import { createShelfClient } from '../core/client';
import type { ShelfClient } from '../core/client';
import type { StorageAdapter } from '../core/storage-adapter';
import type { GetHeaders, ShelfErrorLike, ShelfItem, UploadFile, UploadOptions } from '../core/types';
import { createMemoryAdapter } from '../storage/memory';
import { getDefaultConnectivity } from './connectivity';
import type { ConnectivitySource } from './connectivity';
import { backoffDelay, classifyUploadError } from './errors';

export type OutboxState = 'pending' | 'uploading' | 'failed' | 'done';

export interface OutboxItemError {
  message: string;
  code?: string;
  status?: number;
  /** True when retrying automatically is pointless (4xx refusal, cancelled); a manual retry() still works. */
  permanent: boolean;
}

export interface OutboxItem {
  /** Stable local id. Also the `client_ref` sent with every attempt, so a retry never creates a second document. */
  id: string;
  client_ref: string;
  /** Local file URI; the file is streamed from it by the native networking layer, never read into JS memory. */
  uri: string;
  name: string;
  type: string;
  folder_id?: string;
  on_duplicate?: string;
  state: OutboxState;
  /** 0..1. Without an `upload` override that reports progress it is 0 while uploading and 1 when done. */
  progress: number;
  /** Failed attempts so far. */
  attempts: number;
  /** Earliest time (ms epoch) the next automatic attempt may start; 0 means as soon as possible. */
  nextAttemptAt: number;
  createdAt: number;
  error?: OutboxItemError;
  /** The server's answer once done (in memory only; not persisted). */
  result?: ShelfItem;
}

export interface EnqueueInput {
  uri: string;
  name: string;
  type: string;
  folder_id?: string;
  on_duplicate?: string;
}

export interface OutboxSnapshot {
  items: readonly OutboxItem[];
  online: boolean;
  /** Whether online/offline is actually tracked (false without the netinfo peer). */
  connectivityTracked: boolean;
  paused: boolean;
  pauseReason: 'auth' | 'manual' | null;
  counts: { pending: number; uploading: number; failed: number; done: number };
}

export interface UploadCall {
  file: UploadFile;
  options: UploadOptions;
  signal: AbortSignal;
  onProgress: (fraction: number) => void;
}

export interface OutboxOptions {
  /** A ready client, or give `baseUrl` (+ `getHeaders`). */
  client?: ShelfClient;
  baseUrl?: string;
  getHeaders?: GetHeaders;
  fetch?: typeof fetch;
  onAuthLost?: (error: ShelfErrorLike) => void;
  /** Where items are persisted. Default: memory (does NOT survive a restart); pass a persistent adapter. */
  storage?: StorageAdapter;
  /** Isolates one user's queue from another's on the same storage. The raw value is hashed in the keys. */
  scope?: string;
  /** Simultaneous uploads. Default 3, never more. */
  concurrency?: number;
  /** Backoff after the n-th failure: random in [0, min(maxMs, baseMs * 2^n)). Default 1_000 and 60_000. */
  backoff?: { baseMs?: number; maxMs?: number };
  /** Automatic attempts before an item becomes `failed`. Default 8. */
  maxAttempts?: number;
  /** Default: netinfo when installed, else always online. `false` forces always-online. */
  connectivity?: ConnectivitySource | false;
  /** Replace the transport (e.g. an XMLHttpRequest uploader that reports real progress). */
  upload?: (call: UploadCall) => Promise<ShelfItem>;
  /** Injectable for tests. */
  random?: () => number;
  now?: () => number;
  createId?: () => string;
}

export interface Outbox {
  /** Resolves once persisted items are loaded from storage. */
  readonly ready: Promise<void>;
  /** Persists the item first, then returns; the upload starts as soon as a slot and the network allow. */
  enqueue(input: EnqueueInput): Promise<OutboxItem>;
  /** Aborts an in-flight/pending item; it becomes `failed` (cancelled) and can be retried. */
  cancel(id: string): Promise<void>;
  /** A failed item goes back to pending with the same client_ref. */
  retry(id: string): Promise<void>;
  retryAll(): Promise<void>;
  /** Drops the item (aborting it if running) and deletes it from storage. */
  remove(id: string): Promise<void>;
  /** Drops all `done` items from the list. */
  clearDone(): void;
  pause(): void;
  /** Lifts a manual or auth pause. Call after the user signed in again. */
  resume(): void;
  getSnapshot(): OutboxSnapshot;
  subscribe(listener: () => void): () => void;
  /** Stops timers and in-flight requests without touching storage: a new outbox on the same storage resumes. */
  destroy(): void;
}

const KEY_PREFIX = 'shelf:outbox:v1:';

function hashScope(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

interface Entry {
  item: OutboxItem;
  controller?: AbortController;
}

type Persisted = Omit<OutboxItem, 'result' | 'progress'>;

export function createOutbox(options: OutboxOptions): Outbox {
  const client =
    options.client ??
    (options.baseUrl
      ? createShelfClient({ baseUrl: options.baseUrl, getHeaders: options.getHeaders, fetch: options.fetch, onAuthLost: options.onAuthLost })
      : null);
  if (!client && !options.upload) throw new Error('Shelf outbox: pass a `client`, or `baseUrl` (with `getHeaders`).');
  const storage = options.storage ?? createMemoryAdapter();
  const prefix = `${KEY_PREFIX}${hashScope(options.scope ?? '')}:`;
  const concurrency = Math.max(1, Math.min(3, Math.floor(options.concurrency ?? 3)));
  const baseMs = options.backoff?.baseMs ?? 1_000;
  const maxMs = options.backoff?.maxMs ?? 60_000;
  const maxAttempts = options.maxAttempts ?? 8;
  const random = options.random ?? Math.random;
  const now = options.now ?? Date.now;
  const createId =
    options.createId ?? (() => `${now().toString(36)}-${Math.floor(random() * 0xffffffff).toString(36)}-${Math.floor(Math.random() * 0xffffffff).toString(36)}`);
  const connectivity = options.connectivity === false ? null : (options.connectivity ?? getDefaultConnectivity());

  const entries = new Map<string, Entry>();
  const listeners = new Set<() => void>();
  let online = true;
  let pauseReason: 'auth' | 'manual' | null = null;
  let destroyed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let snapshot: OutboxSnapshot | null = null;

  const transport =
    options.upload ??
    ((c: UploadCall) => (client as ShelfClient).upload(c.file, c.options, { signal: c.signal }));

  function emit() {
    snapshot = null;
    for (const l of [...listeners]) l();
  }

  function getSnapshot(): OutboxSnapshot {
    if (snapshot) return snapshot;
    const items = [...entries.values()].map((e) => e.item).sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
    const counts = { pending: 0, uploading: 0, failed: 0, done: 0 };
    for (const i of items) counts[i.state]++;
    snapshot = { items, online, connectivityTracked: Boolean(connectivity?.tracked), paused: pauseReason !== null, pauseReason, counts };
    return snapshot;
  }

  function toPersisted(item: OutboxItem): Persisted {
    const { result: _r, progress: _p, ...rest } = item;
    return rest;
  }

  async function persist(item: OutboxItem): Promise<void> {
    try {
      await storage.set(prefix + item.id, JSON.stringify(toPersisted(item)));
    } catch {
      // Storage full/unavailable: keep going in memory; the next change tries again.
    }
  }

  async function unpersist(id: string): Promise<void> {
    try {
      await storage.delete(prefix + id);
    } catch {
      /* ignore */
    }
  }

  function update(entry: Entry, patch: Partial<OutboxItem>) {
    entry.item = { ...entry.item, ...patch };
  }

  function clearTimer() {
    if (timer) clearTimeout(timer);
    timer = null;
  }

  function pump() {
    clearTimer();
    if (destroyed || pauseReason || !online) return;
    const t = now();
    let active = 0;
    const waiting: Entry[] = [];
    for (const e of entries.values()) {
      if (e.item.state === 'uploading') active++;
      else if (e.item.state === 'pending') waiting.push(e);
    }
    waiting.sort((a, b) => a.item.createdAt - b.item.createdAt);
    let nextWake = Infinity;
    for (const e of waiting) {
      if (e.item.nextAttemptAt <= t) {
        if (active < concurrency) {
          active++;
          void run(e);
        }
      } else nextWake = Math.min(nextWake, e.item.nextAttemptAt);
    }
    if (nextWake !== Infinity) timer = setTimeout(pump, Math.max(0, nextWake - t));
  }

  async function run(entry: Entry): Promise<void> {
    const controller = new AbortController();
    entry.controller = controller;
    update(entry, { state: 'uploading', progress: 0, error: undefined });
    emit();
    const { item } = entry;
    try {
      const result = await transport({
        file: { uri: item.uri, name: item.name, type: item.type },
        options: { client_ref: item.client_ref, folder_id: item.folder_id, on_duplicate: item.on_duplicate },
        signal: controller.signal,
        onProgress: (f) => {
          if (entry.controller !== controller || entry.item.state !== 'uploading') return;
          update(entry, { progress: Math.max(0, Math.min(1, f)) });
          emit();
        },
      });
      if (destroyed || entry.controller !== controller || entries.get(item.id) !== entry) return;
      entry.controller = undefined;
      update(entry, { state: 'done', progress: 1, result, error: undefined });
      await unpersist(item.id);
      emit();
    } catch (err) {
      if (destroyed || entry.controller !== controller || entries.get(item.id) !== entry) return;
      entry.controller = undefined;
      const kind = classifyUploadError(err);
      const e = err as { message?: string; code?: string; status?: number };
      const base = { message: e?.message || 'Upload failed', code: e?.code, status: e?.status };
      if (kind === 'auth') {
        await purgeAndPause();
        return;
      }
      if (kind === 'cancelled') {
        update(entry, { state: 'failed', error: { ...base, code: 'cancelled', permanent: true } });
      } else if (kind === 'permanent') {
        update(entry, { state: 'failed', attempts: entry.item.attempts + 1, error: { ...base, permanent: true } });
      } else {
        const attempts = entry.item.attempts + 1;
        if (attempts >= maxAttempts) {
          update(entry, { state: 'failed', attempts, error: { ...base, permanent: false } });
        } else {
          update(entry, {
            state: 'pending',
            progress: 0,
            attempts,
            nextAttemptAt: now() + backoffDelay(attempts - 1, { baseMs, maxMs, random }),
            error: { ...base, permanent: false },
          });
        }
      }
      await persist(entry.item);
      emit();
      pump();
      return;
    }
    pump();
  }

  /** The key was revoked: nothing queued can succeed, so abort, drop persisted work and stop until resume(). */
  async function purgeAndPause(): Promise<void> {
    const ids = [...entries.keys()];
    for (const [id, e] of entries) {
      e.controller?.abort();
      if (e.item.state !== 'done') entries.delete(id);
    }
    pauseReason = 'auth';
    clearTimer();
    emit();
    await Promise.all(ids.map(unpersist));
  }

  const ready = (async () => {
    let keys: string[] = [];
    try {
      keys = await storage.list(prefix);
    } catch {
      keys = [];
    }
    for (const k of keys) {
      try {
        const raw = await storage.get(k);
        if (!raw) continue;
        const p = JSON.parse(raw) as Persisted;
        if (!p?.id || !p.uri || entries.has(p.id)) continue;
        // An item that was mid-upload when the app died is simply pending again, same client_ref.
        entries.set(p.id, { item: { ...p, state: p.state === 'uploading' ? 'pending' : p.state, progress: 0, nextAttemptAt: 0 } });
      } catch {
        /* skip an unreadable record */
      }
    }
    emit();
  })();

  const unsubscribeNet = connectivity
    ? connectivity.subscribe((next) => {
        if (destroyed || next === online) return;
        online = next;
        if (online) {
          // Back on the network: do not wait out the backoff timers.
          for (const e of entries.values()) if (e.item.state === 'pending') update(e, { nextAttemptAt: 0 });
        }
        emit();
        void ready.then(pump);
      })
    : () => undefined;

  void ready.then(pump);

  return {
    ready,
    async enqueue(input) {
      if (!input.uri || !input.name || !input.type) throw new Error('Shelf outbox: enqueue needs uri, name and type.');
      await ready;
      if (destroyed) throw new Error('Shelf outbox: destroyed.');
      const id = createId();
      const item: OutboxItem = {
        id,
        client_ref: id,
        uri: input.uri,
        name: input.name,
        type: input.type,
        ...(input.folder_id ? { folder_id: input.folder_id } : {}),
        ...(input.on_duplicate ? { on_duplicate: input.on_duplicate } : {}),
        state: 'pending',
        progress: 0,
        attempts: 0,
        nextAttemptAt: 0,
        createdAt: now(),
      };
      // Persist before anything else: from here on the item survives a crash.
      await persist(item);
      entries.set(id, { item });
      emit();
      pump();
      return item;
    },
    async cancel(id) {
      const e = entries.get(id);
      if (!e || (e.item.state !== 'pending' && e.item.state !== 'uploading')) return;
      const c = e.controller;
      e.controller = undefined;
      update(e, { state: 'failed', progress: 0, error: { message: 'Cancelled', code: 'cancelled', permanent: true } });
      c?.abort();
      await persist(e.item);
      emit();
      pump();
    },
    async retry(id) {
      const e = entries.get(id);
      if (!e || e.item.state !== 'failed') return;
      update(e, { state: 'pending', attempts: 0, nextAttemptAt: 0, progress: 0, error: undefined });
      await persist(e.item);
      emit();
      pump();
    },
    async retryAll() {
      const failed = [...entries.values()].filter((e) => e.item.state === 'failed');
      for (const e of failed) update(e, { state: 'pending', attempts: 0, nextAttemptAt: 0, progress: 0, error: undefined });
      await Promise.all(failed.map((e) => persist(e.item)));
      emit();
      pump();
    },
    async remove(id) {
      const e = entries.get(id);
      if (!e) return;
      entries.delete(id);
      e.controller?.abort();
      e.controller = undefined;
      emit();
      await unpersist(id);
      pump();
    },
    clearDone() {
      for (const [id, e] of entries) if (e.item.state === 'done') entries.delete(id);
      emit();
    },
    pause() {
      if (pauseReason) return;
      pauseReason = 'manual';
      clearTimer();
      emit();
    },
    resume() {
      if (!pauseReason) return;
      pauseReason = null;
      emit();
      pump();
    },
    getSnapshot,
    subscribe(l) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    destroy() {
      destroyed = true;
      clearTimer();
      unsubscribeNet();
      for (const e of entries.values()) {
        e.controller?.abort();
        e.controller = undefined;
      }
      listeners.clear();
    },
  };
}

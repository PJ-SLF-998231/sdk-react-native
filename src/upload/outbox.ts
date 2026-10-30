import { createShelfClient } from '../core/client';
import type { ShelfClient } from '../core/client';
import { credentialFingerprint } from '../core/fingerprint';
import { createAuthSession, getAuthSession } from '../core/session';
import type { StorageAdapter } from '../core/storage-adapter';
import type { GetHeaders, ShelfErrorLike, ShelfItem, UploadFile, UploadOptions } from '../core/types';
import { createMemoryAdapter } from '../storage/memory';
import { getDefaultConnectivity } from './connectivity';
import type { ConnectivitySource } from './connectivity';
import { outboxPrefix, registerClearAllTarget } from '../cache/clear';
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

/** Why the queue is not draining: the server refused the credential (401), the proxy has no key (503 not_configured), or the host paused it. */
export type OutboxPauseReason = 'auth' | 'not_configured' | 'manual';

export interface OutboxSnapshot {
  items: readonly OutboxItem[];
  online: boolean;
  /** Whether online/offline is actually tracked (false without the netinfo peer). */
  connectivityTracked: boolean;
  paused: boolean;
  /** Null while draining. 'auth' and 'not_configured' keep every queued item; see Outbox.resume(). */
  pauseReason: OutboxPauseReason | null;
  /** When the current 'auth' / 'not_configured' pause began (ms epoch; kept across a restart), else null. */
  pausedAt: number | null;
  /** True while a paused queue is sending its one probe item to find out whether the credential works again. */
  probing: boolean;
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
  /**
   * Lifts any pause (manual, 'auth', 'not_configured') and drains the kept queue. Idempotent while not paused. Every
   * attempt calls `getHeaders` afresh, so refresh the credential first, then call this. If the server still refuses it,
   * the queue pauses again and onAuthLost fires again (a new pause). client_ref makes the re-sent files idempotent.
   */
  resume(): void;
  /**
   * Sends ONE queued item now, whatever the credential fingerprint says, to find out whether the pause is over: on
   * success (or any answer that is not a refusal) the queue resumes and drains; on 401 / `not_configured` it stays
   * paused and `onAuthLost` does not fire again. Does nothing for a manual pause or when nothing is paused.
   */
  retryNow(): void;
  getSnapshot(): OutboxSnapshot;
  subscribe(listener: () => void): () => void;
  /** Stops timers and in-flight requests without touching storage: a new outbox on the same storage resumes. */
  destroy(): void;
}

interface Entry {
  item: OutboxItem;
  controller?: AbortController;
}

type Persisted = Omit<OutboxItem, 'result' | 'progress'>;

/**
 * The persisted pause. `fingerprint` is credentialFingerprint() of the headers in use when the refusal happened (16 hex
 * characters of a SHA-256), or null when unknown. The credential itself is never written.
 */
interface PersistedPause {
  v: 1;
  reason: 'auth' | 'not_configured';
  pausedAt: number;
  fingerprint: string | null;
}

export function createOutbox(options: OutboxOptions): Outbox {
  const client =
    options.client ??
    (options.baseUrl
      ? createShelfClient({ baseUrl: options.baseUrl, getHeaders: options.getHeaders, fetch: options.fetch })
      : null);
  if (!client && !options.upload) throw new Error('Shelf outbox: pass a `client`, or `baseUrl` (with `getHeaders`).');
  // The client's auth session: onAuthLost is once per episode, shared with every other holder of the client.
  const session = client ? getAuthSession(client) : createAuthSession();
  const offAuthLost = session.onAuthLost(() => options.onAuthLost);
  const storage = options.storage ?? createMemoryAdapter();
  const prefix = outboxPrefix(options.scope);
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
  let pauseReason: OutboxPauseReason | null = null;
  let pausedAt: number | null = null;
  let probing = false;
  const pauseKey = `${prefix}~pause`;
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
    snapshot = { items, online, connectivityTracked: Boolean(connectivity?.tracked), paused: pauseReason !== null, pauseReason, pausedAt, probing, counts };
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

  async function persistPause(fingerprint: string | null): Promise<void> {
    if (pauseReason !== 'auth' && pauseReason !== 'not_configured') return;
    const rec: PersistedPause = { v: 1, reason: pauseReason, pausedAt: pausedAt ?? now(), fingerprint };
    try {
      await storage.set(pauseKey, JSON.stringify(rec));
    } catch {
      /* the pause then lasts only until the next restart */
    }
  }

  async function unpersistPause(): Promise<void> {
    try {
      await storage.delete(pauseKey);
    } catch {
      /* ignore */
    }
  }

  /** The pause is over: clear it in memory and in storage. */
  function liftPause(): void {
    const persisted = pauseReason === 'auth' || pauseReason === 'not_configured';
    pauseReason = null;
    pausedAt = null;
    probing = false;
    if (persisted) void unpersistPause();
  }

  /** Reads getHeaders once and fingerprints it. Null when this outbox has no way to (a custom transport with no client or getHeaders). */
  function readFingerprint(): Promise<string> | null {
    const viaClient = session.readCredential();
    if (viaClient) return viaClient;
    const gh = options.getHeaders;
    return gh ? (async () => credentialFingerprint(await gh()))() : null;
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
    if (destroyed || (pauseReason && !probing) || !online) return;
    const limit = probing ? 1 : concurrency;
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
        if (active < limit) {
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
      if (probing) endProbe();
      await unpersist(item.id);
      emit();
    } catch (err) {
      if (destroyed || entry.controller !== controller || entries.get(item.id) !== entry) return;
      entry.controller = undefined;
      const kind = classifyUploadError(err);
      const e = err as { message?: string; code?: string; status?: number };
      const base = { message: e?.message || 'Upload failed', code: e?.code, status: e?.status };
      if (kind === 'auth') {
        pauseForAuth(entry, err);
        return;
      }
      if (kind === 'cancelled') {
        update(entry, { state: 'failed', error: { ...base, code: 'cancelled', permanent: true } });
      } else if (kind === 'permanent') {
        update(entry, { state: 'failed', attempts: entry.item.attempts + 1, error: { ...base, permanent: true } });
        if (probing) endProbe(); // the server answered with something other than a refusal: the credential works
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

  /**
   * 401 or 503 not_configured: nothing can succeed until the host fixes the credential, but nothing is lost. Every
   * unsent item (including the one that was refused) goes back to pending, in memory and in storage as it was, running
   * uploads are aborted, and draining stops until resume(). onAuthLost fires once per pause, not once per item.
   */
  /** The probe item got an answer that is not a refusal: the credential works, so the pause ends and the queue drains. */
  function endProbe(): void {
    liftPause();
    session.reportSuccess();
    emit();
  }

  /** Sends one queued item to test the credential. With nothing queued there is nothing to test: the pause just lifts. */
  function startProbe(): void {
    if (destroyed || (pauseReason !== 'auth' && pauseReason !== 'not_configured') || probing) return;
    const queued = [...entries.values()].filter((e) => e.item.state === 'pending');
    if (queued.length === 0) {
      liftPause();
      session.resume();
      emit();
      return;
    }
    for (const e of queued) update(e, { nextAttemptAt: 0 });
    probing = true;
    emit();
    pump();
  }

  function pauseForAuth(refused: Entry, err: unknown): void {
    const reason: OutboxPauseReason = (err as { status?: number }).status === 503 ? 'not_configured' : 'auth';
    for (const e of entries.values()) {
      if (e.item.state !== 'uploading') continue;
      const c = e.controller;
      e.controller = undefined; // so the aborted request's own catch is ignored
      update(e, { state: 'pending', progress: 0, nextAttemptAt: 0, error: undefined });
      c?.abort();
    }
    if (refused.item.state === 'uploading') update(refused, { state: 'pending', progress: 0, nextAttemptAt: 0, error: undefined });
    if (pauseReason !== reason) pausedAt = now();
    pauseReason = reason;
    probing = false; // a refused probe leaves the queue paused, and the open episode keeps onAuthLost quiet
    clearTimer();
    emit();
    // Opens the episode (and tells the host) only for the first refusal; later ones just keep the queue paused.
    session.reportAuthFailure(err as ShelfErrorLike);
    void persistPause(session.active?.fingerprint ?? session.fingerprint);
  }

  /** clearAll(): forget every item (aborting running ones) and delete this queue's records. Files at the URIs are not touched. */
  async function clearQueue(): Promise<void> {
    const ids = [...entries.keys()];
    for (const e of entries.values()) {
      const c = e.controller;
      e.controller = undefined;
      c?.abort();
    }
    entries.clear();
    clearTimer();
    const wasAuthPaused = pauseReason === 'auth' || pauseReason === 'not_configured';
    if (wasAuthPaused) {
      liftPause();
      session.resume();
    }
    emit();
    await Promise.all(ids.map(unpersist));
    if (wasAuthPaused) await unpersistPause();
  }

  const ready = (async () => {
    let keys: string[] = [];
    try {
      keys = await storage.list(prefix);
    } catch {
      keys = [];
    }
    for (const k of keys) {
      if (k === pauseKey) continue;
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
    let persistedPause: PersistedPause | null = null;
    try {
      const raw = await storage.get(pauseKey);
      const p = raw ? (JSON.parse(raw) as PersistedPause) : null;
      if (p && (p.reason === 'auth' || p.reason === 'not_configured') && typeof p.pausedAt === 'number') persistedPause = p;
    } catch {
      /* an unreadable pause record counts as none */
    }
    if (persistedPause && !destroyed && !pauseReason) {
      // Paused before the restart: show it at once and keep sending nothing until the credential is looked at.
      pauseReason = persistedPause.reason;
      pausedAt = persistedPause.pausedAt;
      session.restoreEpisode({ reason: persistedPause.reason, fingerprint: persistedPause.fingerprint, startedAt: persistedPause.pausedAt });
    }
    emit();
    if (persistedPause && pauseReason === persistedPause.reason) void reconcile(persistedPause);
  })();

  /**
   * After a restart with a persisted pause: read getHeaders once. A different fingerprint means the host has refreshed
   * the credential, so one probe item goes out; the same one keeps the queue paused until resume() / retryNow() / a
   * credential change. getHeaders throwing (or no way to read it) also keeps it paused, quietly.
   */
  async function reconcile(p: PersistedPause): Promise<void> {
    const read = p.fingerprint === null ? null : readFingerprint();
    if (!read) return;
    let current: string;
    try {
      current = await read;
    } catch {
      return;
    }
    if (destroyed || !pauseReason || probing) return;
    // A different credential ends the restored episode ('credential'), which the listener below turns into the probe.
    session.observeCredential(current);
  }

  // A credential change seen while auth-paused (restart or not) earns one probe; the episode stays silently open, as the
  // host already knows about this pause.
  const offEpisode = session.onEpisode((ev) => {
    if (ev.type !== 'end' || ev.cause !== 'credential' || destroyed) return;
    if (pauseReason !== 'auth' && pauseReason !== 'not_configured') return;
    session.restoreEpisode({ reason: pauseReason, fingerprint: session.fingerprint, startedAt: pausedAt ?? now() });
    startProbe();
  });

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

  // Held weakly by the clearAll registry; `clearTarget` lives exactly as long as this outbox (see `keepAlive` below).
  const clearTarget = {
    clear: async (ctx: { scoped: boolean; cacheScope?: string }) => {
      if (destroyed) return;
      if (ctx.scoped && outboxPrefix(ctx.cacheScope) !== prefix) return;
      await ready;
      await clearQueue();
    },
  };
  const unregisterClear = registerClearAllTarget(clearTarget);

  const api: Outbox = {
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
      session.resume(); // the host says the credential is fixed: a refusal now is a new episode
      if (!pauseReason) return;
      liftPause();
      emit();
      pump();
    },
    retryNow() {
      if (pauseReason === 'auth' || pauseReason === 'not_configured') startProbe();
      else if (!pauseReason) pump();
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
      offAuthLost();
      unregisterClear();
      offEpisode();
      for (const e of entries.values()) {
        e.controller?.abort();
        e.controller = undefined;
      }
      listeners.clear();
    },
  };
  keepAlive.set(api, clearTarget);
  return api;
}

// Ties the clearAll target's lifetime to the outbox object's: the registry only holds the target weakly.
const keepAlive = new WeakMap<object, object>();

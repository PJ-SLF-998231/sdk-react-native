import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useShelf } from '../provider';
import type { ShelfConnectionProps } from '../provider';
import type { StorageAdapter } from '../core/storage-adapter';
import type { ShelfClient } from '../core/client';
import { getDefaultConnectivity } from './connectivity';
import type { ConnectivitySource } from './connectivity';
import { createOutbox } from './outbox';
import type { EnqueueInput, Outbox, OutboxOptions, OutboxPauseReason, OutboxSnapshot } from './outbox';

export interface UseOutboxOptions extends ShelfConnectionProps {
  /** Use this outbox instead of the shared one for the client (e.g. from createOutbox()). */
  outbox?: Outbox;
  /** Overrides the provider's / props' cache scope for the queue. */
  scope?: string;
  concurrency?: number;
  backoff?: OutboxOptions['backoff'];
  maxAttempts?: number;
  connectivity?: ConnectivitySource | false;
  upload?: OutboxOptions['upload'];
}

export interface OutboxControls {
  outbox: Outbox;
  snapshot: OutboxSnapshot;
  enqueue: (input: EnqueueInput) => Promise<import('./outbox').OutboxItem>;
  cancel: (id: string) => Promise<void>;
  retry: (id: string) => Promise<void>;
  retryAll: () => Promise<void>;
  remove: (id: string) => Promise<void>;
  clearDone: () => void;
  pause: () => void;
  resume: () => void;
  /** Why the queue is paused ('auth' = "Needs sign-in", 'not_configured' = "Not connected", 'manual'), or null. Known right after a restart. */
  pausedReason: OutboxPauseReason | null;
  /** One probe item now, whatever the credential fingerprint; see Outbox.retryNow(). */
  retryNow: () => void;
}

// One outbox per (client, storage, scope), so every screen sees the same queue and a screen unmounting never stops
// uploads while another screen still uses it. Reference-counted: the outbox is destroyed (timers, connectivity and
// episode subscriptions, clearAll registration) when the last useOutbox user unmounts, and a later mount builds a new
// one that reloads the persisted queue. The destroy is deferred one microtask so a StrictMode unmount/remount or a
// dependency change that moves to the same outbox does not destroy it.
interface SharedEntry {
  outbox: Outbox;
  refs: number;
  remove: () => void;
}
const registry = new WeakMap<ShelfClient, WeakMap<object, Map<string, SharedEntry>>>();
const NO_STORAGE: object = {};

function sharedEntry(client: ShelfClient, storage: StorageAdapter | undefined, scope: string | undefined, rest: Omit<OutboxOptions, 'client' | 'storage' | 'scope'>): SharedEntry {
  let byStorage = registry.get(client);
  if (!byStorage) registry.set(client, (byStorage = new WeakMap()));
  const sKey = storage ?? NO_STORAGE;
  let byScope = byStorage.get(sKey);
  if (!byScope) byStorage.set(sKey, (byScope = new Map()));
  const k = scope ?? '';
  let entry = byScope.get(k);
  if (!entry) {
    const scopes = byScope;
    const created: SharedEntry = {
      outbox: createOutbox({ client, storage, scope, ...rest }),
      refs: 0,
      remove: () => {
        if (scopes.get(k) === created) scopes.delete(k);
      },
    };
    scopes.set(k, (entry = created));
  }
  return entry;
}

function acquire(entry: SharedEntry): () => void {
  entry.refs++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    entry.refs--;
    if (entry.refs > 0) return;
    void Promise.resolve().then(() => {
      if (entry.refs > 0) return;
      entry.remove();
      entry.outbox.destroy();
    });
  };
}

/**
 * The outbox for this client, reactive. Works with `<ShelfProvider>` or with `client` / `baseUrl` + `getHeaders` props.
 * The queue is persisted on the provider's `storage` (or the `storage` prop); with neither it is memory-only and does
 * not survive a restart.
 */
export function useOutbox(options: UseOutboxOptions = {}): OutboxControls {
  const ctx = useShelf(options);
  const { outbox: given, scope, concurrency, backoff, maxAttempts, connectivity, upload } = options;
  const storage = options.storage ?? ctx.storage;
  const qScope = scope ?? options.cacheScope ?? ctx.scope;
  const entry = useMemo(
    () => (given ? null : sharedEntry(ctx.client, storage, qScope, { concurrency, backoff, maxAttempts, connectivity, upload })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [given, ctx.client, storage, qScope],
  );
  useEffect(() => (entry ? acquire(entry) : undefined), [entry]);
  const outbox = given ?? (entry as SharedEntry).outbox;
  const snapshot = useSyncExternalStore(outbox.subscribe, outbox.getSnapshot, outbox.getSnapshot);
  return useMemo(
    () => ({
      outbox,
      snapshot,
      enqueue: (i) => outbox.enqueue(i),
      cancel: (id) => outbox.cancel(id),
      retry: (id) => outbox.retry(id),
      retryAll: () => outbox.retryAll(),
      remove: (id) => outbox.remove(id),
      clearDone: () => outbox.clearDone(),
      pause: () => outbox.pause(),
      resume: () => outbox.resume(),
      pausedReason: snapshot.pauseReason,
      retryNow: () => outbox.retryNow(),
    }),
    [outbox, snapshot],
  );
}

export interface OnlineStatus {
  online: boolean;
  /** False when `@react-native-community/netinfo` is not installed: `online` is then always true. */
  tracked: boolean;
}

/** Whether the device is online, from netinfo (optional peer). Without it: always online, `tracked: false`. */
export function useOnlineStatus(source?: ConnectivitySource): OnlineStatus {
  const src = useMemo(() => source ?? getDefaultConnectivity(), [source]);
  const [online, setOnline] = useState(true);
  useEffect(() => src.subscribe(setOnline), [src]);
  return { online, tracked: src.tracked };
}

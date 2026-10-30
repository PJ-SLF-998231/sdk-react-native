import { useCallback, useMemo, useSyncExternalStore } from 'react';
import type { SwrHandle, SwrState } from '../cache/types';
import type { ShelfClient } from '../core/client';
import { useShelf } from '../provider';
import type { ShelfConnectionProps } from '../provider';

/** What every data hook returns: the cached copy at once, then the revalidated one. */
export interface ResourceState<T> {
  data: T | undefined;
  /** Nothing to show yet (no cache, no answer, no error). */
  loading: boolean;
  /** A revalidation is running or pending while `data` (from the cache or older than the fresh window) is on screen. */
  refreshing: boolean;
  /** Last revalidation error; cleared by the next success. `data` is kept. */
  error: unknown;
  /** The last revalidation failed because there is no network. */
  offline: boolean;
  /** `data` came from the persisted cache and has not been revalidated yet. */
  fromCache: boolean;
  /** Epoch ms of the data's origin. */
  updatedAt: number | null;
  refresh: () => Promise<void>;
}

const IDLE: SwrState<never> = { data: undefined, stale: false, loading: false, error: undefined, offline: false, fromCache: false, updatedAt: null };
const noopSubscribe = (): (() => void) => () => undefined;
const idleSnapshot = (): SwrState<never> => IDLE;

export interface ResourceInternals<T> {
  state: ResourceState<T>;
  handle: SwrHandle<T> | null;
  client: ShelfClient;
}

/**
 * The shared plumbing: resolves the client + SWR (provider, `client`, or `baseUrl` + `getHeaders`), subscribes to the
 * handle for `key` and maps its state. A null `key` disables the hook (idle state, no request).
 */
export function useResource<T>(
  conn: ShelfConnectionProps,
  key: string | null,
  fetcher: (client: ShelfClient, signal: AbortSignal, prev: T | undefined) => Promise<T>,
  merge?: (prev: T | undefined, next: T) => T,
): ResourceInternals<T> {
  const ctx = useShelf(conn);
  const { swr, client } = ctx;
  const staleMs = ctx.offline.staleMs;
  const handle = useMemo<SwrHandle<T> | null>(
    () => (key === null ? null : swr.handle<T>({ key, staleMs, merge, fetcher: (signal, prev) => fetcher(client, signal, prev) })),
    // The fetcher/merge closures are re-registered whenever the handle is requested; key + swr + client define identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [swr, client, key, staleMs],
  );
  const raw = useSyncExternalStore(
    handle ? handle.subscribe : noopSubscribe,
    handle ? (handle.snapshot as () => SwrState<T>) : (idleSnapshot as () => SwrState<T>),
    handle ? (handle.snapshot as () => SwrState<T>) : (idleSnapshot as () => SwrState<T>),
  );
  const refresh = useCallback(() => (handle ? handle.refresh() : Promise.resolve()), [handle]);
  const state = useMemo<ResourceState<T>>(
    () => ({
      data: raw.data,
      loading: handle !== null && raw.data === undefined && raw.error === undefined,
      refreshing: raw.data !== undefined && raw.stale,
      error: raw.error,
      offline: raw.offline,
      fromCache: raw.fromCache,
      updatedAt: raw.updatedAt,
      refresh,
    }),
    [raw, refresh, handle],
  );
  return { state, handle, client };
}

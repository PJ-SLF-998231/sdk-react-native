import { isAuthLost, isOfflineError } from '../core/errors';
import type { CacheStore, Swr, SwrHandle, SwrOptions, SwrState } from './types';

/** AppState/reconnect refreshes of one handle are at least this far apart (unless it is offline). */
export const REVALIDATE_THROTTLE_MS = 5000;
const DEFAULT_STALE_MS = 30_000;

/** A handle that also lets the owner replace its data (pagination appends a page, say). */
export interface SwrHandleImpl<T> extends SwrHandle<T> {
  /** Replace the data (kept in memory and written to the cache). Not a revalidation. */
  set(data: T): void;
}

export interface SwrImpl extends Swr {
  handle<T>(opts: SwrOptions<T>): SwrHandleImpl<T>;
}

export interface CreateSwrOptions {
  now?: () => number;
  /** Called once when a fetch fails with isAuthLost; the cache has been purged by then. */
  onAuthLost?: () => void;
}

const isAbort = (e: unknown): boolean => (e as { name?: string } | null)?.name === 'AbortError';

function emptyState<T>(): SwrState<T> {
  return { data: undefined, stale: false, loading: false, error: undefined, offline: false, fromCache: false, updatedAt: null };
}

export const createSwr = ((cache: CacheStore, opts: CreateSwrOptions = {}): SwrImpl => {
  const now = opts.now ?? Date.now;
  const handles = new Map<string, Internal<unknown>>();
  let destroyed = false;
  let authLostFired = false;

  interface Internal<T> extends SwrHandleImpl<T> {
    key: string;
    hasListeners(): boolean;
    reset(): void;
    abort(): void;
    revalidate(force: boolean): void;
    update(o: SwrOptions<T>): void;
  }

  function makeHandle<T>(initial: SwrOptions<T>): Internal<T> {
    let o = initial;
    let state: SwrState<T> = emptyState<T>();
    const listeners = new Set<() => void>();
    let inflight: { controller: AbortController; promise: Promise<void> } | null = null;
    let lastStart = -Infinity;
    let hydrate: Promise<void> | null = null;
    let generation = 0; // bumps on purge so stale async results are dropped

    const set = (patch: Partial<SwrState<T>>): void => {
      state = { ...state, ...patch };
      for (const l of [...listeners]) l();
    };

    function hydrateOnce(): Promise<void> {
      if (hydrate) return hydrate;
      const gen = generation;
      hydrate = (async () => {
        if (state.data !== undefined) return;
        const hit = await cache.getEntry<T>(o.key);
        if (hit && gen === generation && state.data === undefined) {
          set({ data: hit.value, stale: true, fromCache: true, updatedAt: hit.storedAt });
        }
      })().catch(() => undefined);
      return hydrate;
    }

    function refresh(opt?: { abortInFlight?: boolean }): Promise<void> {
      if (destroyed) return Promise.resolve();
      if (inflight) {
        if (!opt?.abortInFlight) return inflight.promise;
        inflight.controller.abort();
        inflight = null;
      }
      const controller = new AbortController();
      const gen = generation;
      lastStart = now();
      const run = (async () => {
        await hydrateOnce();
        if (controller.signal.aborted || gen !== generation) return;
        set({ loading: state.data === undefined, stale: state.data !== undefined });
        let next: T;
        try {
          next = await o.fetcher(controller.signal, state.data);
        } catch (err) {
          if (controller.signal.aborted || gen !== generation) return;
          if (isAbort(err)) {
            set({ loading: false });
            return;
          }
          if (isAuthLost(err)) {
            set({ loading: false, error: err });
            await fireAuthLost();
            return;
          }
          set({ loading: false, error: err, offline: isOfflineError(err), stale: state.data !== undefined });
          return;
        }
        if (controller.signal.aborted || gen !== generation) return;
        const prev = state.data;
        const prevAt = state.updatedAt ?? 0;
        const wasCached = state.fromCache;
        const merged = o.merge ? o.merge(prev, next) : next;
        const t = now();
        set({ data: merged, stale: false, loading: false, error: undefined, offline: false, fromCache: false, updatedAt: t });
        if (merged !== prev || wasCached || t - prevAt > 60_000) await cache.setEntry(o.key, merged).catch(() => undefined);
      })().finally(() => {
        if (inflight?.controller === controller) inflight = null;
      });
      inflight = { controller, promise: run };
      return run;
    }

    function maybeAbort(): void {
      if (listeners.size === 0 && inflight) {
        inflight.controller.abort();
        inflight = null;
        if (state.loading) set({ loading: false });
      }
    }

    const handle: Internal<T> = {
      key: initial.key,
      snapshot: () => state,
      subscribe(listener) {
        listeners.add(listener);
        if (listeners.size === 1) {
          const fresh = state.data !== undefined && !state.fromCache && state.error === undefined && now() - (state.updatedAt ?? 0) < (o.staleMs ?? DEFAULT_STALE_MS);
          if (!fresh) void refresh();
          else void hydrateOnce();
        }
        // Show the cache straight away even if a fetch is already running.
        void hydrateOnce();
        return () => {
          listeners.delete(listener);
          maybeAbort();
        };
      },
      refresh,
      release: maybeAbort,
      set(data) {
        set({ data, stale: false, fromCache: false, updatedAt: now() });
        void cache.setEntry(o.key, data).catch(() => undefined);
      },
      hasListeners: () => listeners.size > 0,
      reset() {
        generation++;
        inflight?.controller.abort();
        inflight = null;
        hydrate = null;
        lastStart = -Infinity;
        state = emptyState<T>();
        for (const l of [...listeners]) l();
      },
      abort() {
        inflight?.controller.abort();
        inflight = null;
      },
      revalidate(force) {
        if (listeners.size === 0) return;
        const t = now();
        if (!force) {
          const trouble = state.offline || state.error !== undefined;
          if (!trouble) {
            if (t - lastStart < REVALIDATE_THROTTLE_MS) return;
            if (state.updatedAt !== null && !state.fromCache && t - state.updatedAt < (o.staleMs ?? DEFAULT_STALE_MS)) return;
          }
        }
        void refresh();
      },
      update(next) {
        o = next;
      },
    };
    return handle;
  }

  async function fireAuthLost(): Promise<void> {
    if (authLostFired) return;
    authLostFired = true;
    await swr.purge();
    try {
      opts.onAuthLost?.();
    } catch {
      /* host callback must not break the cache */
    }
  }

  function revalidateAll(): void {
    for (const h of handles.values()) h.revalidate(false);
  }

  const swr: SwrImpl = {
    handle<T>(o: SwrOptions<T>): SwrHandleImpl<T> {
      const existing = handles.get(o.key) as Internal<T> | undefined;
      if (existing) {
        existing.update(o);
        return existing;
      }
      const h = makeHandle<T>(o);
      handles.set(o.key, h as Internal<unknown>);
      return h;
    },
    revalidateAll,
    invalidate(key) {
      handles.get(key)?.revalidate(true);
    },
    async purge() {
      for (const h of handles.values()) h.reset();
      await cache.purge();
    },
    destroy() {
      destroyed = true;
      for (const h of handles.values()) h.abort();
      handles.clear();
    },
  };
  return swr;
});

export interface CachedEntry<T = unknown> {
  value: T;
  /** Epoch ms of the cache write. */
  storedAt: number;
}

export type PutResult = 'ok' | 'quota';

export interface CacheStore {
  /** False when memory-only (no cacheScope was given). */
  readonly persistent: boolean;
  /** Key prefix this cache owns in the StorageAdapter (derived from baseUrl + cacheScope; never the raw scope). */
  readonly prefix: string;
  getEntry<T>(key: string): Promise<CachedEntry<T> | undefined>;
  /** 'quota' means the entry was too large to keep; the caller carries on without caching. */
  setEntry<T>(key: string, value: T): Promise<PutResult>;
  deleteEntry(key: string): Promise<void>;
  /** Removes every entry of this scope from memory and storage. Never rejects. */
  purge(): Promise<void>;
}

export interface SwrState<T> {
  data: T | undefined;
  /** True while `data` came from the cache or is older than `staleMs` and a revalidation is pending/running. */
  stale: boolean;
  loading: boolean;
  /** Last revalidation error; cleared by the next success. `data` is kept. */
  error: unknown;
  /** Last revalidation failed with isOfflineError. */
  offline: boolean;
  fromCache: boolean;
  /** Epoch ms of the data's origin (cache write or network response). */
  updatedAt: number | null;
}

export interface SwrOptions<T> {
  key: string;
  /** Must honour the signal. */
  fetcher: (signal: AbortSignal, prev: T | undefined) => Promise<T>;
  /** Fresh window; within it a revalidateAll() does not refetch. Default 30_000. */
  staleMs?: number;
  /** Return prev when unchanged so React sees the same reference. */
  merge?: (prev: T | undefined, next: T) => T;
}

export interface SwrHandle<T> {
  snapshot(): SwrState<T>;
  subscribe(listener: () => void): () => void;
  refresh(opts?: { abortInFlight?: boolean }): Promise<void>;
  /** Drop interest; aborts the in-flight fetch when no subscriber is left. */
  release(): void;
  /** Replace the data (memory and cache). Not a revalidation. */
  set(data: T): void;
}

export interface Swr {
  /** Same key => same handle (requests are deduped). */
  handle<T>(opts: SwrOptions<T>): SwrHandle<T>;
  /** Revalidates handles that have subscribers and are stale. Wire it to AppState 'active' and NetInfo reconnect. */
  revalidateAll(): void;
  invalidate(key: string): void;
  /** Drops memory + persisted data and aborts everything (auth lost / clearCache). */
  purge(): Promise<void>;
  destroy(): void;
}

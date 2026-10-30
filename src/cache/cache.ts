import type { StorageAdapter } from '../core/storage-adapter';
import type { CacheStore, CachedEntry, PutResult } from './types';

export const CACHE_ROOT = 'shelf:v1:';
/** One JSON entry over this many characters loses its `parsed_text` first, and is then not stored. */
export const DEFAULT_MAX_ENTRY_CHARS = 1.5 * 1024 * 1024;

export interface CreateCacheOptions {
  /** Where entries are persisted. Without it (or without a cacheScope) the cache is memory-only. */
  storage?: StorageAdapter;
  baseUrl: string;
  /**
   * Isolates one user's cached data from another's on the same device (any stable per-user string, e.g. a user id).
   * Without it the cache is memory-only: nothing is written to storage.
   */
  cacheScope?: string;
  maxEntryChars?: number;
  now?: () => number;
}

/** cyrb53: a small non-cryptographic hash, so the raw scope is never written into a storage key. */
function hash(input: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
}

export function scopePrefix(baseUrl: string, cacheScope: string): string {
  return `${CACHE_ROOT}${hash(`${baseUrl.replace(/\/+$/, '')}\n${cacheScope}`)}:`;
}

/** Live caches register here so clearCache() can empty their memory too. */
export const liveCaches = new Set<CacheStore & { memoryClear(): void }>();

export function createCache(opts: CreateCacheOptions): CacheStore {
  const now = opts.now ?? Date.now;
  const max = opts.maxEntryChars ?? DEFAULT_MAX_ENTRY_CHARS;
  const storage = opts.storage;
  const persistent = Boolean(opts.cacheScope && storage);
  const prefix = persistent ? scopePrefix(opts.baseUrl, opts.cacheScope as string) : '';
  const mem = new Map<string, CachedEntry>();
  let epoch = 0; // bumps on purge so an in-flight write cannot resurrect purged data

  const store: CacheStore & { memoryClear(): void } = {
    persistent,
    prefix,

    async getEntry<T>(key: string) {
      const hit = mem.get(key);
      if (hit) return hit as CachedEntry<T>;
      if (!persistent) return undefined;
      const seen = epoch;
      try {
        const raw = await storage!.get(prefix + key);
        if (raw === null || seen !== epoch) return undefined;
        const parsed = JSON.parse(raw) as { v?: number; storedAt?: number; value?: unknown };
        if (parsed.v !== 1 || typeof parsed.storedAt !== 'number') return undefined;
        const entry: CachedEntry = { value: parsed.value, storedAt: parsed.storedAt };
        mem.set(key, entry);
        return entry as CachedEntry<T>;
      } catch {
        return undefined; // unreadable entries are misses
      }
    },

    async setEntry<T>(key: string, value: T): Promise<PutResult> {
      const entry: CachedEntry = { value, storedAt: now() };
      if (!persistent) {
        mem.set(key, entry);
        return 'ok';
      }
      let kept: unknown = value;
      let raw = JSON.stringify({ v: 1, storedAt: entry.storedAt, value: kept });
      if (raw.length > max) {
        const dropped = dropText(value);
        if (dropped !== value) {
          kept = dropped;
          raw = JSON.stringify({ v: 1, storedAt: entry.storedAt, value: kept });
        }
      }
      if (raw.length > max) {
        mem.delete(key);
        await storage!.delete(prefix + key).catch(() => undefined);
        return 'quota';
      }
      const seen = epoch;
      mem.set(key, { value: kept, storedAt: entry.storedAt });
      try {
        if (seen === epoch) await storage!.set(prefix + key, raw);
      } catch {
        return 'quota';
      }
      return 'ok';
    },

    async deleteEntry(key) {
      mem.delete(key);
      if (persistent) await storage!.delete(prefix + key).catch(() => undefined);
    },

    memoryClear() {
      epoch++;
      mem.clear();
    },

    async purge() {
      store.memoryClear();
      if (!persistent) return;
      try {
        const keys = await storage!.list(prefix);
        await Promise.all(keys.map((k) => storage!.delete(k).catch(() => undefined)));
      } catch {
        /* best effort */
      }
    },
  };
  liveCaches.add(store);
  return store;
}

/** Releases the cache from the live registry (call when its scope unmounts for good). */
export function disposeCache(cache: CacheStore): void {
  liveCaches.delete(cache as CacheStore & { memoryClear(): void });
}

function dropText<T>(value: T): T {
  if (value && typeof value === 'object' && 'parsed_text' in (value as object)) {
    const { parsed_text: _drop, ...rest } = value as Record<string, unknown>;
    return rest as T;
  }
  return value;
}

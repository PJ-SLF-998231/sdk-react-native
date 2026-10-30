import type { StorageAdapter } from '../core/storage-adapter';
import { CACHE_ROOT, liveCaches, scopePrefix } from './cache';

export interface ClearCacheOptions {
  /** Storage to wipe. Live in-memory caches are emptied whether or not it is given. */
  storage?: StorageAdapter;
  /** With both `baseUrl` and `cacheScope` only that scope goes; with neither, everything of every scope. */
  baseUrl?: string;
  cacheScope?: string;
}

/**
 * Removes what the SDK keeps on this device: cached listings and details, in memory and (when `storage` is given)
 * in storage. Call it on sign-out. Never rejects.
 */
export async function clearCache(opts: ClearCacheOptions = {}): Promise<void> {
  const scoped = opts.baseUrl !== undefined && opts.cacheScope !== undefined;
  const prefix = scoped ? scopePrefix(opts.baseUrl as string, opts.cacheScope as string) : CACHE_ROOT;
  try {
    for (const c of [...liveCaches]) {
      if (!scoped || c.prefix === prefix) await c.purge();
    }
  } catch {
    /* best effort */
  }
  if (!opts.storage) return;
  try {
    const keys = await opts.storage.list(prefix);
    await Promise.all(keys.map((k) => (opts.storage as StorageAdapter).delete(k).catch(() => undefined)));
  } catch {
    /* best effort */
  }
}

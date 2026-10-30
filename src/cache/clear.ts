import type { StorageAdapter } from '../core/storage-adapter';
import { CACHE_ROOT, liveCaches, scopePrefix } from './cache';

/** Key prefix of every persisted upload queue (`<prefix><hash(scope)>:<id>`). Plain clearCache() never touches it. */
export const OUTBOX_KEY_PREFIX = 'shelf:outbox:v1:';

/** djb2 hash of the queue scope; the raw scope is never stored in keys. */
export function hashScope(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/** Storage key prefix of one scope's queue. */
export function outboxPrefix(scope: string | undefined): string {
  return `${OUTBOX_KEY_PREFIX}${hashScope(scope ?? '')}:`;
}

/** What a clear-all hook is told: which scope is being cleared (`undefined` scope with `scoped: false` means every scope). */
export interface ClearAllContext {
  scoped: boolean;
  cacheScope?: string;
}

type ClearAllHook = (ctx: ClearAllContext) => void | Promise<void>;
const clearAllHooks = new Set<ClearAllHook>();

/** Something that wants to hear about clearAll() without being kept alive by the registry. */
export interface ClearAllTarget {
  clear: ClearAllHook;
}
type WeakRefLike<T extends object> = { deref(): T | undefined };
const weakTargets = new Set<WeakRefLike<ClearAllTarget>>();

/**
 * Like registerClearAllHook, but the registry holds `target` weakly (a WeakRef, where the engine has one), so a queue
 * the host dropped without destroy() is not kept alive here. The caller must keep `target` reachable for as long as it
 * is in use, and should still call the returned function on destroy. Dead references are dropped on the next clearAll.
 */
export function registerClearAllTarget(target: ClearAllTarget): () => void {
  const WR = (globalThis as { WeakRef?: new <T extends object>(t: T) => WeakRefLike<T> }).WeakRef;
  const ref: WeakRefLike<ClearAllTarget> = WR ? new WR(target) : { deref: () => target };
  weakTargets.add(ref);
  return () => weakTargets.delete(ref);
}

/** Test hook: how many hooks and targets clearAll() would currently call. */
export function clearAllRegistrySize(): number {
  return clearAllHooks.size + weakTargets.size;
}

/**
 * Lets an entry join clearAll() without the cache area importing it (camera/picker/upload must not reach documents, and
 * the root entry must not reach upload). The upload outbox registers its live queues, the documents entry its default
 * thumbnail cache. Returns the unregister function.
 */
export function registerClearAllHook(hook: ClearAllHook): () => void {
  clearAllHooks.add(hook);
  return () => clearAllHooks.delete(hook);
}

export interface ClearCacheOptions {
  /** Also clear thumbnails and the persisted upload queue (same as clearAll()). Default false: those are kept. */
  everything?: boolean;
  /** clearAll only: a thumbnail cache you injected (the default one is cleared through the documents entry). */
  thumbnails?: { clear(): Promise<void> };
  /** Storage to wipe. Live in-memory caches are emptied whether or not it is given. */
  storage?: StorageAdapter;
  /** With both `baseUrl` and `cacheScope` only that scope goes; with neither, everything of every scope. */
  baseUrl?: string;
  cacheScope?: string;
}

/**
 * Removes cached listings and details, in memory and (when `storage` is given) in storage. It KEEPS the persisted
 * upload queue and thumbnails; for sign-out use clearAll() (or `{ everything: true }`). Never rejects.
 */
export async function clearCache(opts: ClearCacheOptions = {}): Promise<void> {
  if (opts.everything) return clearAll({ ...opts, everything: false });
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

/**
 * Sign-out in one call: the read cache (like clearCache), thumbnails (the default thumbnail cache when the documents
 * entry is loaded, plus `thumbnails` if given) and the persisted upload queue, including unsent files' queue entries
 * (live outboxes drop them too). Queue entries are scoped by `cacheScope` when given; without it every scope goes.
 * The files the URIs point at are never touched. Never rejects.
 */
export async function clearAll(opts: ClearCacheOptions = {}): Promise<void> {
  await clearCache({ ...opts, everything: false });
  const scoped = opts.baseUrl !== undefined && opts.cacheScope !== undefined;
  const ctx: ClearAllContext = { scoped, cacheScope: opts.cacheScope };
  for (const h of [...clearAllHooks]) {
    try {
      await h(ctx);
    } catch {
      /* best effort */
    }
  }
  for (const ref of [...weakTargets]) {
    const target = ref.deref();
    if (!target) {
      weakTargets.delete(ref);
      continue;
    }
    try {
      await target.clear(ctx);
    } catch {
      /* best effort */
    }
  }
  try {
    await opts.thumbnails?.clear();
  } catch {
    /* best effort */
  }
  if (!opts.storage) return;
  try {
    const keys = await opts.storage.list(scoped ? outboxPrefix(opts.cacheScope) : OUTBOX_KEY_PREFIX);
    await Promise.all(keys.map((k) => (opts.storage as StorageAdapter).delete(k).catch(() => undefined)));
  } catch {
    /* best effort */
  }
}

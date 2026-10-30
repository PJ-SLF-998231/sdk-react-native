import { createCache, createSwr, clearCache, scopePrefix, disposeCache, DEFAULT_MAX_ENTRY_CHARS } from '../cache';
import type { CacheStore } from '../cache';
import { createMemoryAdapter } from '../storage';
import { ShelfError } from '../core';
import { tick } from './helpers';

const BASE = 'https://api.example.com/api/shelf';
const caches: CacheStore[] = [];
const mk = (o: Parameters<typeof createCache>[0]) => {
  const c = createCache(o);
  caches.push(c);
  return c;
};
afterEach(() => {
  caches.splice(0).forEach(disposeCache);
});

describe('cache over a StorageAdapter', () => {
  test('persists entries across cache instances of the same scope', async () => {
    const storage = createMemoryAdapter();
    await mk({ storage, baseUrl: BASE, cacheScope: 'user-1', now: () => 123 }).setEntry('folders', [{ id: 'a' }]);
    const again = mk({ storage, baseUrl: BASE, cacheScope: 'user-1' });
    expect(await again.getEntry('folders')).toEqual({ value: [{ id: 'a' }], storedAt: 123 });
  });

  test('scopes are isolated per user and per baseUrl, and the raw scope is never in a key', async () => {
    const storage = createMemoryAdapter();
    await mk({ storage, baseUrl: BASE, cacheScope: 'alice@example.com' }).setEntry('k', 1);
    expect(await mk({ storage, baseUrl: BASE, cacheScope: 'bob' }).getEntry('k')).toBeUndefined();
    expect(await mk({ storage, baseUrl: 'https://other.example.com', cacheScope: 'alice@example.com' }).getEntry('k')).toBeUndefined();
    const keys = await storage.list();
    expect(keys).toHaveLength(1);
    expect(keys[0]).not.toContain('alice');
    expect(keys[0]!.startsWith(scopePrefix(BASE, 'alice@example.com'))).toBe(true);
    expect(scopePrefix(BASE + '/', 'u')).toBe(scopePrefix(BASE, 'u'));
  });

  test('without a cacheScope or storage nothing is persisted', async () => {
    const storage = createMemoryAdapter();
    const noScope = mk({ storage, baseUrl: BASE });
    await noScope.setEntry('k', 1);
    expect((await noScope.getEntry('k'))?.value).toBe(1);
    expect(await storage.list()).toEqual([]);
    expect(noScope.persistent).toBe(false);
    expect(mk({ baseUrl: BASE, cacheScope: 'u' }).persistent).toBe(false);
  });

  test('corrupt or foreign-version rows are misses', async () => {
    const storage = createMemoryAdapter();
    const c = mk({ storage, baseUrl: BASE, cacheScope: 'u' });
    await storage.set(c.prefix + 'bad', '{not json');
    await storage.set(c.prefix + 'old', JSON.stringify({ v: 0, storedAt: 1, value: 1 }));
    expect(await c.getEntry('bad')).toBeUndefined();
    expect(await c.getEntry('old')).toBeUndefined();
  });

  test('an oversized entry loses parsed_text first, then is not stored', async () => {
    const storage = createMemoryAdapter();
    const c = mk({ storage, baseUrl: BASE, cacheScope: 'u', maxEntryChars: 200 });
    expect(await c.setEntry('doc', { id: 'd', parsed_text: 'x'.repeat(500) })).toBe('ok');
    expect((await storage.get(c.prefix + 'doc'))).not.toContain('parsed_text');
    expect(await c.setEntry('big', { id: 'd', items: 'x'.repeat(500) })).toBe('quota');
    expect(await c.getEntry('big')).toBeUndefined();
    expect(DEFAULT_MAX_ENTRY_CHARS).toBeGreaterThan(1_000_000);
  });

  test('purge removes this scope from memory and storage and leaves other scopes alone', async () => {
    const storage = createMemoryAdapter();
    const a = mk({ storage, baseUrl: BASE, cacheScope: 'a' });
    const b = mk({ storage, baseUrl: BASE, cacheScope: 'b' });
    await a.setEntry('k', 1);
    await b.setEntry('k', 2);
    await a.purge();
    expect(await a.getEntry('k')).toBeUndefined();
    expect((await b.getEntry('k'))?.value).toBe(2);
    expect(await storage.list(a.prefix)).toEqual([]);
  });

  test('a read that races a purge does not resurrect data', async () => {
    const storage = createMemoryAdapter();
    const c = mk({ storage, baseUrl: BASE, cacheScope: 'u' });
    await c.setEntry('k', 1);
    const fresh = mk({ storage, baseUrl: BASE, cacheScope: 'u' });
    const read = fresh.getEntry('k');
    await fresh.purge();
    expect(await read).toBeUndefined();
  });

  test('clearCache(): scoped, global, and storage-only', async () => {
    const storage = createMemoryAdapter();
    const a = mk({ storage, baseUrl: BASE, cacheScope: 'a' });
    const b = mk({ storage, baseUrl: BASE, cacheScope: 'b' });
    await a.setEntry('k', 1);
    await b.setEntry('k', 2);
    await storage.set('host:own', 'keep');
    await clearCache({ storage, baseUrl: BASE, cacheScope: 'a' });
    expect(await a.getEntry('k')).toBeUndefined();
    expect((await b.getEntry('k'))?.value).toBe(2);
    await clearCache({ storage });
    expect(await b.getEntry('k')).toBeUndefined();
    expect(await storage.list()).toEqual(['host:own']);
    await storage.set(scopePrefix(BASE, 'z') + 'k', '{}');
    await clearCache({ storage }); // no live cache for scope z: storage still cleared
    expect(await storage.list()).toEqual(['host:own']);
  });

  test('clearCache never rejects', async () => {
    const broken = { get: async () => null, set: async () => undefined, delete: async () => { throw new Error('x'); }, list: async () => { throw new Error('x'); } };
    await expect(clearCache({ storage: broken })).resolves.toBeUndefined();
  });
});

describe('stale-while-revalidate', () => {
  const setup = (opts: { storage?: ReturnType<typeof createMemoryAdapter>; scope?: string; onAuthLost?: () => void; t?: { now: number } } = {}) => {
    const t = opts.t ?? { now: 1000 };
    const cache = mk({ storage: opts.storage ?? createMemoryAdapter(), baseUrl: BASE, cacheScope: opts.scope ?? 'u', now: () => t.now });
    const swr = createSwr(cache, { now: () => t.now, onAuthLost: opts.onAuthLost });
    return { cache, swr, t };
  };
  const settle = async () => {
    for (let i = 0; i < 6; i++) await tick();
  };

  test('shows cached data immediately as stale, then replaces it with the fetch', async () => {
    const storage = createMemoryAdapter();
    await mk({ storage, baseUrl: BASE, cacheScope: 'u', now: () => 500 }).setEntry('folders', ['cached']);
    const { swr } = setup({ storage });
    let release!: (v: string[]) => void;
    const fetcher = jest.fn(() => new Promise<string[]>((r) => (release = r)));
    const h = swr.handle<string[]>({ key: 'folders', fetcher });
    const seen: unknown[] = [];
    const off = h.subscribe(() => seen.push(h.snapshot()));
    await settle();
    expect(h.snapshot()).toMatchObject({ data: ['cached'], stale: true, fromCache: true, updatedAt: 500 });
    release(['fresh']);
    await settle();
    expect(h.snapshot()).toMatchObject({ data: ['fresh'], stale: false, fromCache: false, loading: false, offline: false });
    off();
    // the fresh value was written back
    const reread = mk({ storage, baseUrl: BASE, cacheScope: 'u' });
    expect((await reread.getEntry('folders'))?.value).toEqual(['fresh']);
  });

  test('dedupes requests for the same key and honours the fresh window', async () => {
    const { swr, t } = setup();
    const fetcher = jest.fn(async () => 'v');
    const h1 = swr.handle({ key: 'k', fetcher, staleMs: 10_000 });
    const h2 = swr.handle({ key: 'k', fetcher, staleMs: 10_000 });
    expect(h1).toBe(h2);
    h1.subscribe(() => undefined);
    h2.subscribe(() => undefined);
    await settle();
    expect(fetcher).toHaveBeenCalledTimes(1);
    t.now += 6000; // past the throttle, inside the fresh window
    swr.revalidateAll();
    await settle();
    expect(fetcher).toHaveBeenCalledTimes(1);
    t.now += 10_000;
    swr.revalidateAll();
    await settle();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  test('offline errors keep the data and flag offline; the next success clears it', async () => {
    const { swr } = setup();
    const fetcher = jest.fn<Promise<string>, []>();
    fetcher.mockResolvedValueOnce('v1').mockRejectedValueOnce(new TypeError('Network request failed')).mockResolvedValueOnce('v2');
    const h = swr.handle({ key: 'k', fetcher });
    h.subscribe(() => undefined);
    await settle();
    await h.refresh();
    expect(h.snapshot()).toMatchObject({ data: 'v1', offline: true, stale: true });
    await h.refresh();
    expect(h.snapshot()).toMatchObject({ data: 'v2', offline: false, error: undefined });
  });

  test('401 / revoked key purges memory and storage, resets handles, and fires onAuthLost once', async () => {
    const storage = createMemoryAdapter();
    const onAuthLost = jest.fn();
    const { swr, cache } = setup({ storage, onAuthLost });
    await cache.setEntry('other', 'secret');
    const ok = swr.handle({ key: 'a', fetcher: async () => 'data' });
    ok.subscribe(() => undefined);
    await settle();
    expect(ok.snapshot().data).toBe('data');
    const bad = swr.handle({ key: 'b', fetcher: async () => { throw new ShelfError(503, 'not_configured', 'revoked'); } });
    bad.subscribe(() => undefined);
    await settle();
    expect(onAuthLost).toHaveBeenCalledTimes(1);
    expect(await storage.list()).toEqual([]);
    expect(ok.snapshot().data).toBeUndefined();
    await bad.refresh();
    await settle();
    expect(onAuthLost).toHaveBeenCalledTimes(1);
  });

  test('purge drops in-flight results instead of caching them', async () => {
    const storage = createMemoryAdapter();
    const { swr } = setup({ storage });
    let release!: (v: string) => void;
    const h = swr.handle({ key: 'k', fetcher: () => new Promise<string>((r) => (release = r)) });
    h.subscribe(() => undefined);
    await settle();
    await swr.purge();
    release('late');
    await settle();
    expect(h.snapshot().data).toBeUndefined();
    expect(await storage.list()).toEqual([]);
  });

  test('set() replaces data and persists; invalidate() refetches subscribed handles', async () => {
    const storage = createMemoryAdapter();
    const { swr, cache } = setup({ storage });
    const fetcher = jest.fn(async () => 'net');
    const h = swr.handle<string>({ key: 'k', fetcher });
    h.subscribe(() => undefined);
    await settle();
    h.set('local');
    await settle();
    expect(h.snapshot().data).toBe('local');
    expect((await cache.getEntry('k'))?.value).toBe('local');
    swr.invalidate('k');
    await settle();
    expect(h.snapshot().data).toBe('net');
  });

  test('last unsubscribe aborts the in-flight fetch; destroy stops everything', async () => {
    const { swr } = setup();
    let signal!: AbortSignal;
    const h = swr.handle({ key: 'k', fetcher: (s) => ((signal = s), new Promise<string>(() => undefined)) });
    const off = h.subscribe(() => undefined);
    await settle();
    off();
    expect(signal.aborted).toBe(true);
    swr.destroy();
    await expect(h.refresh()).resolves.toBeUndefined();
  });
});

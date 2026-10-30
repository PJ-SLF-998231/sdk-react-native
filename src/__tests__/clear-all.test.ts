import { clearAll, clearCache, createCache, scopePrefix } from '../cache';
import { createOutbox } from '../upload';
import { getDefaultThumbnailCache, setDefaultThumbnailCache } from '../documents';
import type { ThumbnailCache } from '../documents';
import { createMemoryAdapter } from '../storage';
import { createShelfClient } from '../core';
import type { ShelfItem } from '../core';
import { item as apiItem } from './helpers';

const BASE = 'https://x.test';
const file = (n: number) => ({ uri: `file:///tmp/${n}.pdf`, name: `${n}.pdf`, type: 'application/pdf' });
const never = () => new Promise<ShelfItem>(() => undefined); // the item stays queued
const ok = () => Promise.resolve(apiItem('srv') as unknown as ShelfItem);
const fakeThumbs = (): ThumbnailCache & { clear: jest.Mock } => ({ clear: jest.fn(async () => undefined) }) as never;

async function setup(scope = 'a', storage = createMemoryAdapter()) {
  const cache = createCache({ storage, baseUrl: BASE, cacheScope: scope });
  await cache.setEntry('k', 1);
  const ob = createOutbox({ client: createShelfClient({ baseUrl: BASE }), storage, scope, connectivity: false, upload: never });
  await ob.enqueue(file(1));
  await ob.enqueue(file(2));
  return { storage, cache, ob };
}
const cacheKeys = async (s: ReturnType<typeof createMemoryAdapter>) => (await s.list()).filter((k) => k.startsWith('shelf:v1:'));
const queueKeys = async (s: ReturnType<typeof createMemoryAdapter>) => (await s.list()).filter((k) => k.startsWith('shelf:outbox:v1:'));

test('plain clearCache() clears the read cache but keeps the queue and thumbnails', async () => {
  const { storage, ob } = await setup();
  const thumbs = fakeThumbs();
  setDefaultThumbnailCache(thumbs);
  await clearCache({ storage });
  expect(await cacheKeys(storage)).toEqual([]);
  expect(await queueKeys(storage)).toHaveLength(2);
  expect(ob.getSnapshot().items).toHaveLength(2);
  expect(thumbs.clear).not.toHaveBeenCalled();
  ob.destroy();
});

test.each([
  ['clearAll()', (storage: ReturnType<typeof createMemoryAdapter>) => clearAll({ storage })],
  ['clearCache({ everything: true })', (storage: ReturnType<typeof createMemoryAdapter>) => clearCache({ storage, everything: true })],
])('%s clears read cache, default thumbnails and the persisted + live queue', async (_n, run) => {
  const { storage, ob } = await setup();
  const thumbs = fakeThumbs();
  setDefaultThumbnailCache(thumbs);
  await storage.set('host:own', 'keep');
  await run(storage);
  expect(await storage.list()).toEqual(['host:own']);
  expect(ob.getSnapshot().items).toEqual([]);
  expect(thumbs.clear).toHaveBeenCalledTimes(1);
  ob.destroy();
});

test('clearAll({ thumbnails }) clears an injected thumbnail cache', async () => {
  const thumbs = fakeThumbs();
  setDefaultThumbnailCache(fakeThumbs());
  await clearAll({ thumbnails: thumbs });
  expect(thumbs.clear).toHaveBeenCalledTimes(1);
});

test('clearAll with a scope leaves another user\'s cache and queue alone', async () => {
  const storage = createMemoryAdapter();
  const a = await setup('a', storage);
  const b = await setup('b', storage);
  setDefaultThumbnailCache(fakeThumbs());
  await clearAll({ storage, baseUrl: BASE, cacheScope: 'a' });
  expect(a.ob.getSnapshot().items).toEqual([]);
  expect(b.ob.getSnapshot().items).toHaveLength(2);
  expect(await queueKeys(storage)).toHaveLength(2);
  expect((await cacheKeys(storage)).every((k) => k.startsWith(scopePrefix(BASE, 'b')))).toBe(true);
  expect(await cacheKeys(storage)).toHaveLength(1);
  a.ob.destroy();
  b.ob.destroy();
});

test('an upload finishing after clearAll does not resurrect its item', async () => {
  const storage = createMemoryAdapter();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = () => r()));
  const ob = createOutbox({ client: createShelfClient({ baseUrl: BASE }), storage, connectivity: false, upload: () => gate.then(ok) });
  await ob.enqueue(file(1));
  await clearAll({ storage });
  release();
  await new Promise<void>((r) => setTimeout(() => r(), 0));
  expect(ob.getSnapshot().items).toEqual([]);
  expect(await storage.list()).toEqual([]);
  ob.destroy();
});

test('clearAll never rejects when a hook or the storage throws', async () => {
  const broken = { get: async () => null, set: async () => undefined, delete: async () => { throw new Error('x'); }, list: async () => { throw new Error('x'); } };
  setDefaultThumbnailCache({ clear: async () => { throw new Error('x'); } } as never);
  await expect(clearAll({ storage: broken, thumbnails: { clear: async () => { throw new Error('y'); } } })).resolves.toBeUndefined();
  setDefaultThumbnailCache(null);
  void getDefaultThumbnailCache;
});

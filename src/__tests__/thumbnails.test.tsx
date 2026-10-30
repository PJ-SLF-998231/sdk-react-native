import React from 'react';
import { Image } from 'react-native';
import { render, waitFor } from '@testing-library/react-native';
import { Thumbnail, createFileThumbnailCache, createMemoryThumbnailCache, pickPreviewSize, thumbnailKey } from '../documents';
import type { FileSystemLike, ThumbnailCache } from '../documents';
import { createShelfClient } from '../core';
import { item, mockFetch } from './helpers';

function fakeFs() {
  const files = new Map<string, string | number>(); // uri -> size (number) or text
  const downloads: Array<{ url: string; uri: string; headers?: Record<string, string> }> = [];
  const fs: FileSystemLike & { files: typeof files; downloads: typeof downloads; status: number; size: number } = {
    cacheDirectory: 'file:///cache/',
    files,
    downloads,
    status: 200,
    size: 100,
    async getInfoAsync(uri) {
      const v = files.get(uri);
      return v === undefined ? { exists: false } : { exists: true, size: typeof v === 'number' ? v : v.length };
    },
    async makeDirectoryAsync() {},
    async downloadAsync(url, uri, o) {
      downloads.push({ url, uri, headers: o?.headers });
      if (fs.status === 200) files.set(uri, fs.size);
      return { status: fs.status, uri };
    },
    async deleteAsync(uri) {
      for (const k of [...files.keys()]) if (k === uri || k.startsWith(uri.endsWith('/') ? uri : uri + '/')) files.delete(k);
    },
    async readAsStringAsync(uri) {
      const v = files.get(uri);
      if (typeof v !== 'string') throw new Error('ENOENT');
      return v;
    },
    async writeAsStringAsync(uri, c) {
      files.set(uri, c);
    },
  };
  return fs;
}
const src = (id: string) => ({ uri: `https://api.test/files/${id}/thumbnail`, headers: { Authorization: 'Bearer k' } });

describe('pickPreviewSize', () => {
  test('smallest rendition that covers the needed pixels, else the largest, else null', () => {
    const all = ['small', 'medium', 'large'];
    expect(pickPreviewSize(all, 100)).toBe('small');
    expect(pickPreviewSize(all, 360)).toBe('small');
    expect(pickPreviewSize(all, 361)).toBe('medium');
    expect(pickPreviewSize(all, 1500)).toBe('large');
    expect(pickPreviewSize(all, 5000)).toBe('large');
    expect(pickPreviewSize(['small', 'medium'], 1500)).toBe('medium');
    expect(pickPreviewSize(['large'], 50)).toBe('large');
    expect(pickPreviewSize([], 50)).toBeNull();
    expect(pickPreviewSize(undefined, 50)).toBeNull();
  });
});

describe('file thumbnail cache', () => {
  test('downloads with the auth headers once, then serves from disk', async () => {
    const fs = fakeFs();
    const c = createFileThumbnailCache({ fileSystem: fs });
    expect(await c.get('a.small.1')).toBeNull();
    const got = await c.put('a.small.1', src('a'));
    expect(got.uri).toBe('file:///cache/shelf-thumbnails/a.small.1.img');
    expect(fs.downloads[0]?.headers).toEqual({ Authorization: 'Bearer k' });
    expect(await c.get('a.small.1')).toEqual({ uri: got.uri });
    expect(fs.downloads.length).toBe(1);
  });

  test('LRU: past the byte cap the least recently used file is deleted, a get refreshes recency', async () => {
    const fs = fakeFs();
    fs.size = 100;
    const c = createFileThumbnailCache({ fileSystem: fs, maxBytes: 250 });
    await c.put('a', src('a'));
    await c.put('b', src('b'));
    await c.get('a'); // a is now newer than b
    await c.put('c', src('c')); // 300 > 250: evict b
    expect(await c.get('b')).toBeNull();
    expect(await c.get('a')).not.toBeNull();
    expect(await c.get('c')).not.toBeNull();
    expect([...fs.files.keys()].filter((k) => k.endsWith('.img')).sort()).toEqual(['file:///cache/shelf-thumbnails/a.img', 'file:///cache/shelf-thumbnails/c.img']);
  });

  test('recency survives a restart through the index file; a file deleted behind its back is a miss', async () => {
    const fs = fakeFs();
    const one = createFileThumbnailCache({ fileSystem: fs });
    await one.put('a', src('a'));
    await one.put('b', src('b'));
    await new Promise<void>((r) => setTimeout(r, 0));
    const two = createFileThumbnailCache({ fileSystem: fs });
    expect(await two.get('a')).not.toBeNull();
    fs.files.delete('file:///cache/shelf-thumbnails/b.img');
    expect(await two.get('b')).toBeNull();
  });

  test('a failed download rejects, caches nothing and removes the partial file', async () => {
    const fs = fakeFs();
    fs.status = 404;
    const c = createFileThumbnailCache({ fileSystem: fs });
    await expect(c.put('a', src('a'))).rejects.toThrow(/404/);
    expect(await c.get('a')).toBeNull();
  });

  test('concurrent puts of one key download once; clear empties', async () => {
    const fs = fakeFs();
    const c = createFileThumbnailCache({ fileSystem: fs });
    await Promise.all([c.put('a', src('a')), c.put('a', src('a'))]);
    expect(fs.downloads.length).toBe(1);
    await c.clear();
    expect(await c.get('a')).toBeNull();
  });

  test('limits simultaneous downloads', async () => {
    const fs = fakeFs();
    let live = 0;
    let peak = 0;
    const orig = fs.downloadAsync.bind(fs);
    fs.downloadAsync = async (...a) => {
      live++;
      peak = Math.max(peak, live);
      await new Promise<void>((r) => setTimeout(r, 5));
      live--;
      return orig(...a);
    };
    const c = createFileThumbnailCache({ fileSystem: fs, concurrency: 2 });
    await Promise.all(['a', 'b', 'c', 'd', 'e'].map((k) => c.put(k, src(k))));
    expect(peak).toBe(2);
  });
});

test('memory thumbnail cache is an LRU of sources', async () => {
  const c = createMemoryThumbnailCache({ maxEntries: 2 });
  await c.put('a', src('a'));
  await c.put('b', src('b'));
  await c.get('a');
  await c.put('c', src('c'));
  expect(await c.get('b')).toBeNull();
  expect((await c.get('a'))?.uri).toContain('/a/');
});

describe('Thumbnail component', () => {
  const client = createShelfClient({ baseUrl: 'https://api.test', getHeaders: () => ({ Authorization: 'Bearer k' }), fetch: mockFetch([]).fetch });

  test('asks the cache first, downloads the size that covers the box on a miss, and shows the picture', async () => {
    const put = jest.fn(async (_k: string, s: { uri: string }) => ({ uri: 'file:///t.jpg', from: s.uri }));
    const cache: ThumbnailCache = { get: jest.fn(async () => null), put: put as unknown as ThumbnailCache['put'], clear: async () => {} };
    const doc = item('d1', { preview_sizes: ['small', 'medium', 'large'] });
    const tree = render(<Thumbnail document={doc} width={200} height={150} pixelRatio={3} client={client} cache={cache} />); // 600px needed
    await waitFor(() => expect(tree.UNSAFE_getByType(Image).props.source).toEqual({ uri: 'file:///t.jpg' }));
    expect(put.mock.calls[0]?.[0]).toBe(thumbnailKey(doc, 'medium'));
    expect(put.mock.calls[0]?.[1]).toMatchObject({ uri: 'https://api.test/files/d1/thumbnail?size=medium', headers: { Authorization: 'Bearer k' } });
  });

  test('a hit does not download; no preview means no request; a failed download keeps the placeholder', async () => {
    const hit: ThumbnailCache = { get: jest.fn(async () => ({ uri: 'file:///hit.jpg' })), put: jest.fn(), clear: async () => {} };
    const a = render(<Thumbnail document={item('d1')} width={48} height={48} pixelRatio={2} client={client} cache={hit} />);
    await waitFor(() => expect(a.UNSAFE_getByType(Image).props.source.uri).toBe('file:///hit.jpg'));
    expect(hit.put).not.toHaveBeenCalled();

    const none: ThumbnailCache = { get: jest.fn(), put: jest.fn(), clear: async () => {} };
    const b = render(<Thumbnail document={item('d2', { preview_sizes: [] })} width={48} height={48} client={client} cache={none} />);
    expect(none.get).not.toHaveBeenCalled();
    expect(b.getByText('PDF', { includeHiddenElements: true })).toBeTruthy();

    const bad: ThumbnailCache = { get: jest.fn(async () => null), put: jest.fn(async () => Promise.reject(new Error('x'))), clear: async () => {} };
    const c = render(<Thumbnail document={item('d3')} width={48} height={48} client={client} cache={bad} />);
    await waitFor(() => expect(bad.put).toHaveBeenCalled());
    expect(c.UNSAFE_queryAllByType(Image).length).toBe(0);
    expect(c.getByText('PDF', { includeHiddenElements: true })).toBeTruthy();
  });
});

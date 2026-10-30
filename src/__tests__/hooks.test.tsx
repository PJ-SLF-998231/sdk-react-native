import React from 'react';
import { Text } from 'react-native';
import { act, render, waitFor } from '@testing-library/react-native';
import { folderPath, mergeFirstPage, useDocument, useDocumentSite, useDocumentText, useDocuments, useFolder, useFolders } from '../hooks';
import type { UseDocumentsResult, UseFolderResult } from '../hooks';
import { documentsKey } from '../hooks/useDocuments';
import { foldersKey } from '../hooks/useFolders';
import { ShelfProvider } from '../provider';
import { createCache } from '../cache';
import { createShelfClient } from '../core';
import { createMemoryAdapter } from '../storage';
import { item, mockFetch, tick } from './helpers';

const BASE = 'https://api.test';
const folders = [
  { id: 'a', name: 'Alpha', parent_id: null, item_count: 2 },
  { id: 'b', name: 'Beta', parent_id: 'a', item_count: 1 },
];

function probe<T>(use: () => T) {
  const out: { current: T } = { current: undefined as T };
  const P = () => {
    out.current = use();
    return <Text>x</Text>;
  };
  return { out, P };
}

describe('useFolders / useFolder', () => {
  test('works with no provider through baseUrl + getHeaders, and sends the headers', async () => {
    const f = mockFetch([{ body: folders }]);
    const getHeaders = jest.fn(() => ({ Authorization: 'Bearer k' }));
    const { out, P } = probe(() => useFolders({ baseUrl: BASE, getHeaders, fetch: f.fetch }));
    render(<P />);
    expect(out.current.loading).toBe(true);
    await waitFor(() => expect(out.current.data).toEqual(folders));
    expect(f.calls[0]?.url).toBe(`${BASE}/folders`);
    expect(f.calls[0]?.init.headers.Authorization).toBe('Bearer k');
    expect(out.current.loading).toBe(false);
  });

  test('works with a ready client and no provider', async () => {
    const f = mockFetch([{ body: folders }]);
    const client = createShelfClient({ baseUrl: BASE, fetch: f.fetch });
    const { out, P } = probe(() => useFolders({ client }));
    render(<P />);
    await waitFor(() => expect(out.current.data?.length).toBe(2));
  });

  test('renders the persisted copy first (fromCache), then the revalidated one', async () => {
    const storage = createMemoryAdapter();
    await createCache({ storage, baseUrl: BASE, cacheScope: 'u1' }).setEntry(foldersKey(), [folders[0]]);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const f = mockFetch([{ body: folders }]);
    const slow = (async (...a: Parameters<typeof fetch>) => {
      await gate;
      return f.fetch(...a);
    }) as typeof fetch;
    const { out, P } = probe(() => useFolders({ baseUrl: BASE, fetch: slow, storage, cacheScope: 'u1' }));
    render(<P />);
    await waitFor(() => expect(out.current.data).toEqual([folders[0]]));
    expect(out.current.fromCache).toBe(true);
    expect(out.current.loading).toBe(false);
    expect(out.current.refreshing).toBe(true);
    await act(async () => release());
    await waitFor(() => expect(out.current.data).toEqual(folders));
    expect(out.current.fromCache).toBe(false);
    expect(out.current.refreshing).toBe(false);
  });

  test('cache scope: another user never sees the first user\'s cached folders', async () => {
    const storage = createMemoryAdapter();
    await createCache({ storage, baseUrl: BASE, cacheScope: 'alice' }).setEntry(foldersKey(), folders);
    const f = mockFetch([{ body: [] }]);
    const { out, P } = probe(() => useFolders({ baseUrl: BASE, fetch: f.fetch, storage, cacheScope: 'bob' }));
    render(<P />);
    await waitFor(() => expect(f.calls.length).toBe(1));
    expect(out.current.fromCache).toBe(false);
    await waitFor(() => expect(out.current.data).toEqual([]));
  });

  test('a failed revalidation keeps the cached data and reports the error; without cache it is an error with no data', async () => {
    const storage = createMemoryAdapter();
    await createCache({ storage, baseUrl: BASE, cacheScope: 'u1' }).setEntry(foldersKey(), folders);
    const f = mockFetch([{ status: 500, body: { error: { code: 'boom', message: 'boom' } } }]);
    const kept = probe(() => useFolders({ baseUrl: BASE, fetch: f.fetch, storage, cacheScope: 'u1' }));
    render(<kept.P />);
    await waitFor(() => expect(kept.out.current.error).toBeDefined());
    expect(kept.out.current.data).toEqual(folders);

    const f2 = mockFetch([{ status: 500, body: {} }]);
    const bare = probe(() => useFolders({ baseUrl: BASE, fetch: f2.fetch }));
    render(<bare.P />);
    await waitFor(() => expect(bare.out.current.error).toBeDefined());
    expect(bare.out.current.data).toBeUndefined();
    expect(bare.out.current.loading).toBe(false);
  });

  test('a network failure sets offline', async () => {
    const down = (async () => {
      throw new TypeError('Network request failed');
    }) as typeof fetch;
    const { out, P } = probe(() => useFolders({ baseUrl: BASE, fetch: down }));
    render(<P />);
    await waitFor(() => expect(out.current.offline).toBe(true));
  });

  test('useFolder derives folder, path and children from the folder list', async () => {
    const f = mockFetch([{ body: folders }]);
    const { out, P } = probe((): UseFolderResult => useFolder('b', { baseUrl: BASE, fetch: f.fetch }));
    render(<P />);
    await waitFor(() => expect(out.current.folder?.name).toBe('Beta'));
    expect(out.current.path.map((p) => p.id)).toEqual(['a', 'b']);
    expect(out.current.children).toEqual([]);
    expect(folderPath(folders, 'a').map((p) => p.id)).toEqual(['a']);
    expect(folderPath(folders, 'nope')).toEqual([]);
    expect(folderPath([{ id: 'x', name: 'x', parent_id: 'y' }, { id: 'y', name: 'y', parent_id: 'x' }], 'x').length).toBe(2); // cycle-safe
  });
});

describe('useDocuments', () => {
  test('lists a folder, paginates with loadMore, and dedupes', async () => {
    const f = mockFetch([
      { body: { items: [item('1'), item('2')], next_cursor: 'c1' } },
      { body: { items: [item('2'), item('3')], next_cursor: null } },
    ]);
    const { out, P } = probe((): UseDocumentsResult => useDocuments('fold', { baseUrl: BASE, fetch: f.fetch, pageSize: 2 }));
    render(<P />);
    await waitFor(() => expect(out.current.items.length).toBe(2));
    expect(f.calls[0]?.url).toBe(`${BASE}/files?folder_id=fold&limit=2`);
    expect(out.current.hasMore).toBe(true);
    await act(async () => {
      await out.current.loadMore();
    });
    expect(f.calls[1]?.url).toBe(`${BASE}/files?folder_id=fold&limit=2&cursor=c1`);
    expect(out.current.items.map((i) => i.id)).toEqual(['1', '2', '3']);
    expect(out.current.hasMore).toBe(false);
  });

  test('scope: folders do not share lists', async () => {
    const f = mockFetch((c) => ({ body: { items: [item(c.url.includes('folder_id=a') ? 'in-a' : 'in-b')] } }));
    const a = probe(() => useDocuments('a', { baseUrl: BASE, fetch: f.fetch }));
    render(<a.P />);
    await waitFor(() => expect(a.out.current.items[0]?.id).toBe('in-a'));
    expect(documentsKey('a')).not.toBe(documentsKey('b'));
    expect(documentsKey(null, true)).not.toBe(documentsKey(null, false));
  });

  test('cached list is shown before the network answers; error keeps it', async () => {
    const storage = createMemoryAdapter();
    await createCache({ storage, baseUrl: BASE, cacheScope: 's' }).setEntry(documentsKey('a'), { items: [item('c1')], next_cursor: null });
    const f = mockFetch([{ status: 503, body: {} }]);
    const { out, P } = probe(() => useDocuments('a', { baseUrl: BASE, fetch: f.fetch, storage, cacheScope: 's' }));
    render(<P />);
    await waitFor(() => expect(out.current.items[0]?.id).toBe('c1'));
    await waitFor(() => expect(out.current.error).toBeDefined());
    expect(out.current.items.length).toBe(1);
    expect(out.current.ready).toBe(true);
  });

  test('mergeFirstPage keeps loaded pages after a first-page refresh and returns prev when nothing changed', () => {
    const prev = { items: [item('1'), item('2'), item('3'), item('4')], next_cursor: 'z' };
    expect(mergeFirstPage(prev, { items: [item('1'), item('2')], next_cursor: 'c' }).items.map((i) => i.id)).toEqual(['1', '2', '3', '4']);
    expect(mergeFirstPage(prev, { items: [item('1'), item('2')], next_cursor: 'c' }).next_cursor).toBe('z');
    expect(mergeFirstPage(prev, { items: [item('0'), item('1')], next_cursor: 'c' }).items.map((i) => i.id)).toEqual(['0', '1', '3', '4']);
    const same = { items: [item('1'), item('2'), item('3'), item('4')], next_cursor: 'z' };
    expect(mergeFirstPage(prev, same)).toBe(prev);
  });
});

describe('useDocument / useDocumentText / useDocumentSite', () => {
  test('text comes from the document entry; idle without an id', async () => {
    const f = mockFetch([{ body: { ...item('d1'), parsed_text: 'hello world' } }]);
    const { out, P } = probe(() => useDocumentText('d1', { baseUrl: BASE, fetch: f.fetch }));
    render(<P />);
    expect(out.current.text).toBe('');
    await waitFor(() => expect(out.current.text).toBe('hello world'));
    expect(f.calls[0]?.url).toBe(`${BASE}/files/d1`);

    const g = mockFetch([]);
    const idle = probe(() => useDocument(undefined, { baseUrl: BASE, fetch: g.fetch }));
    render(<idle.P />);
    await act(tick);
    expect(g.calls.length).toBe(0);
    expect(idle.out.current.data).toBeUndefined();
  });

  test('site: 404 is status none, a site is returned, other errors surface', async () => {
    const none = mockFetch([{ status: 404, body: { error: { code: 'not_found', message: 'x' } } }]);
    const a = probe(() => useDocumentSite('d1', { baseUrl: BASE, fetch: none.fetch }));
    render(<a.P />);
    await waitFor(() => expect(a.out.current.data).toEqual({ file_id: 'd1', status: 'none' }));
    expect(none.calls[0]?.url).toBe(`${BASE}/files/d1/site`);

    const ready = mockFetch([{ body: { file_id: 'd2', status: 'ready', spec: { v: 1 } } }]);
    const b = probe(() => useDocumentSite('d2', { baseUrl: BASE, fetch: ready.fetch }));
    render(<b.P />);
    await waitFor(() => expect(b.out.current.data?.status).toBe('ready'));

    const bad = mockFetch([{ status: 500, body: {} }]);
    const c = probe(() => useDocumentSite('d3', { baseUrl: BASE, fetch: bad.fetch }));
    render(<c.P />);
    await waitFor(() => expect(c.out.current.error).toBeDefined());
  });
});

test('hooks share one cache under a ShelfProvider', async () => {
  const f = mockFetch((c) => (c.url.endsWith('/folders') ? { body: folders } : { body: { items: [] } }));
  const client = createShelfClient({ baseUrl: BASE, fetch: f.fetch });
  const { out, P } = probe(() => ({ a: useFolders(), b: useFolders() }));
  render(
    <ShelfProvider client={client}>
      <P />
    </ShelfProvider>,
  );
  await waitFor(() => expect(out.current.a.data?.length).toBe(2));
  expect(out.current.b.data?.length).toBe(2);
  expect(f.calls.filter((c) => c.url.endsWith('/folders')).length).toBe(1); // deduped
});

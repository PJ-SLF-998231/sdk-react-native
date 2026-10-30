import React from 'react';
import { FlatList } from 'react-native';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { DocumentCard, DocumentList, DocumentRow } from '../documents';
import type { ThumbnailCache } from '../documents';
import { FolderBreadcrumb, FolderCard, FolderHeader, FolderList } from '../folders';
import { createShelfClient } from '../core';
import { createCache } from '../cache';
import { createMemoryAdapter } from '../storage';
import { documentsKey } from '../hooks/useDocuments';
import { darkTheme } from '../theme';
import { item, mockFetch } from './helpers';

const BASE = 'https://api.test';
const pending = (() => new Promise(() => undefined)) as unknown as typeof fetch;
const noThumbs: ThumbnailCache = { get: async () => null, put: async () => Promise.reject(new Error('no')), clear: async () => {} };
const folders = [
  { id: 'a', name: 'Alpha', parent_id: null, item_count: 2, total_item_count: 3 },
  { id: 'b', name: 'Beta', parent_id: 'a', item_count: 1 },
  { id: 'c', name: 'Gamma', parent_id: null, item_count: 0 },
];
// preview_sizes: [] keeps snapshots free of async thumbnail loads
const docs = [item('d1', { preview_sizes: [], size_bytes: 2048 }), item('d2', { preview_sizes: [], filename: 'scan.png', content_type: 'image/png', parse_status: 'processing' })];

describe('FolderList', () => {
  test('loading', () => {
    expect(render(<FolderList baseUrl={BASE} fetch={pending} />).toJSON()).toMatchSnapshot();
  });
  test('empty', async () => {
    const f = mockFetch([{ body: [] }]);
    const t = render(<FolderList baseUrl={BASE} fetch={f.fetch} />);
    await t.findByText('No folders');
    expect(t.toJSON()).toMatchSnapshot();
  });
  test('populated: top level only, press, and no write UI by default', async () => {
    const f = mockFetch([{ body: folders }]);
    const onPress = jest.fn();
    const t = render(<FolderList baseUrl={BASE} fetch={f.fetch} onPressFolder={onPress} />);
    await t.findByText('Alpha');
    expect(t.queryByText('Beta')).toBeNull();
    expect(t.queryByText('Rename')).toBeNull();
    expect(t.queryByText('Delete')).toBeNull();
    expect(t.toJSON()).toMatchSnapshot();
    fireEvent.press(t.getByText('Alpha'));
    expect(onPress).toHaveBeenCalledWith(folders[0]);
  });
  test('children of parentId, and write buttons only when their handlers are passed', async () => {
    const f = mockFetch([{ body: folders }]);
    const rename = jest.fn();
    const t = render(<FolderList baseUrl={BASE} fetch={f.fetch} parentId="a" onRenameFolder={rename} />);
    await t.findByText('Beta');
    expect(t.queryByText('Alpha')).toBeNull();
    expect(t.queryByText('Delete')).toBeNull();
    fireEvent.press(t.getByText('Rename'));
    expect(rename).toHaveBeenCalledWith(folders[1]);
  });
  test('error with retry', async () => {
    const f = mockFetch([{ status: 500, body: {} }, { body: folders }]);
    const t = render(<FolderList baseUrl={BASE} fetch={f.fetch} />);
    await t.findByText('Could not load folders');
    expect(t.toJSON()).toMatchSnapshot();
    fireEvent.press(t.getByText('Try again'));
    await t.findByText('Alpha');
  });
});

describe('Folder pieces', () => {
  test('FolderCard snapshots (plain, with write actions, dark)', () => {
    const t = render(
      <>
        <FolderCard folder={folders[0] as never} />
        <FolderCard folder={folders[1] as never} onRename={() => {}} onDelete={() => {}} />
        <FolderCard folder={folders[2] as never} theme={darkTheme} />
      </>,
    );
    expect(t.toJSON()).toMatchSnapshot();
  });
  test('FolderBreadcrumb snapshot and navigation; the current crumb is not pressable', () => {
    const onPress = jest.fn();
    const t = render(<FolderBreadcrumb path={[folders[0] as never, folders[1] as never]} onPress={onPress} />);
    expect(t.toJSON()).toMatchSnapshot();
    fireEvent.press(t.getByText('All documents'));
    expect(onPress).toHaveBeenLastCalledWith(null);
    fireEvent.press(t.getByText('Alpha'));
    expect(onPress).toHaveBeenLastCalledWith(folders[0]);
    onPress.mockClear();
    fireEvent.press(t.getByText('Beta'));
    expect(onPress).not.toHaveBeenCalled();
  });
  test('FolderHeader: root, loading folder, loaded folder; "New folder" only when asked', async () => {
    const f = mockFetch(() => ({ body: folders }));
    const client = createShelfClient({ baseUrl: BASE, fetch: f.fetch });
    const root = render(<FolderHeader client={client} />);
    expect(root.queryByText('New folder')).toBeNull();
    expect(root.toJSON()).toMatchSnapshot('root');
    const inner = render(<FolderHeader client={client} folderId="b" onCreateFolder={() => {}} />);
    await inner.findByText('1 document');
    expect(inner.toJSON()).toMatchSnapshot('folder');
  });
});

describe('DocumentList', () => {
  test('loading', () => {
    expect(render(<DocumentList baseUrl={BASE} fetch={pending} folderId="a" thumbnailCache={noThumbs} />).toJSON()).toMatchSnapshot();
  });
  test('empty', async () => {
    const f = mockFetch([{ body: { items: [] } }]);
    const t = render(<DocumentList baseUrl={BASE} fetch={f.fetch} folderId="a" />);
    await t.findByText('No documents');
    expect(t.toJSON()).toMatchSnapshot();
  });
  test('populated rows, press, and virtualisation props', async () => {
    const f = mockFetch([{ body: { items: docs } }]);
    const onPress = jest.fn();
    const t = render(<DocumentList baseUrl={BASE} fetch={f.fetch} folderId="a" onPressDocument={onPress} thumbnailCache={noThumbs} />);
    await t.findByText('d1.pdf');
    expect(t.toJSON()).toMatchSnapshot();
    fireEvent.press(t.getByText('scan.png'));
    expect(onPress).toHaveBeenCalledWith(docs[1]);
    const list = t.UNSAFE_getByType(FlatList);
    expect(list.props.windowSize).toBe(7);
    expect(list.props.getItemLayout(null, 3)).toEqual({ length: 72, offset: 216, index: 3 });
  });
  test('populated cards (grid)', async () => {
    const f = mockFetch([{ body: { items: docs } }]);
    const t = render(<DocumentList baseUrl={BASE} fetch={f.fetch} folderId="a" variant="card" thumbnailCache={noThumbs} />);
    await t.findByText('d1.pdf');
    expect(t.toJSON()).toMatchSnapshot();
  });
  test('error without cache offers retry; offline with cache keeps the rows and says so', async () => {
    const bad = mockFetch([{ status: 500, body: {} }]);
    const a = render(<DocumentList baseUrl={BASE} fetch={bad.fetch} folderId="a" />);
    await a.findByText('Could not load documents');
    expect(a.toJSON()).toMatchSnapshot();

    const storage = createMemoryAdapter();
    await createCache({ storage, baseUrl: BASE, cacheScope: 'u' }).setEntry(documentsKey('a'), { items: docs, next_cursor: null });
    const down = (async () => {
      throw new TypeError('Network request failed');
    }) as typeof fetch;
    const b = render(<DocumentList baseUrl={BASE} fetch={down} folderId="a" storage={storage} cacheScope="u" thumbnailCache={noThumbs} />);
    await b.findByText('d1.pdf');
    await b.findByText('Offline: showing saved documents');
  });
  test('renders through a custom listComponent, and falls back to FlatList when FlashList is missing', async () => {
    const f = mockFetch([{ body: { items: docs } }, { body: { items: docs } }]);
    const Custom = jest.fn((p: any) => <FlatList {...p} testID="custom" />);
    const a = render(<DocumentList baseUrl={BASE} fetch={f.fetch} folderId="a" listComponent={Custom} thumbnailCache={noThumbs} />);
    await a.findByText('d1.pdf');
    expect(Custom.mock.calls[0]?.[0]).toMatchObject({ numColumns: 1, onEndReachedThreshold: 1.5 });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const b = render(<DocumentList baseUrl={BASE} fetch={f.fetch} folderId="b" listComponent="flashlist" thumbnailCache={noThumbs} />);
    await b.findByText('d1.pdf');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('@shopify/flash-list'));
    warn.mockRestore();
  });
  test('loads the next page near the end', async () => {
    const f = mockFetch([{ body: { items: [docs[0]], next_cursor: 'n' } }, { body: { items: [docs[1]] } }]);
    const t = render(<DocumentList baseUrl={BASE} fetch={f.fetch} folderId="a" thumbnailCache={noThumbs} />);
    await t.findByText('d1.pdf');
    await act(async () => {
      t.UNSAFE_getByType(FlatList).props.onEndReached();
    });
    await t.findByText('scan.png');
    expect(f.calls[1]?.url).toContain('cursor=n');
  });
});

describe('DocumentRow / DocumentCard', () => {
  test('snapshots', () => {
    const t = render(
      <>
        <DocumentRow document={docs[0] as never} thumbnailCache={noThumbs} />
        <DocumentRow document={docs[1] as never} theme={darkTheme} thumbnailCache={noThumbs} />
        <DocumentCard document={docs[0] as never} thumbnailCache={noThumbs} />
        <DocumentCard document={docs[1] as never} width={120} theme={darkTheme} thumbnailCache={noThumbs} />
      </>,
    );
    expect(t.toJSON()).toMatchSnapshot();
  });
});


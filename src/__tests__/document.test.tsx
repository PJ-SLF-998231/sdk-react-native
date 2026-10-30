import React from 'react';
import { Linking } from 'react-native';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import {
  DocumentContentView,
  DocumentPreview,
  DocumentScreen,
  DocumentTextView,
  SiteRenderer,
  activeTab,
  chunkText,
  parseSiteSpec,
  resolveTabs,
} from '../document';
import { ShelfProvider } from '../provider';
import { createShelfClient } from '../core';
import { item, mockFetch } from './helpers';
import { resetZoomLibsForTests } from '../document/peers';

const BASE = 'https://api.test';
const fx = (name: string): unknown => require(`./fixtures/site/${name}.json`);
const BLOCKS = ['hero', 'summary', 'key_facts', 'amount', 'parties', 'timeline', 'table', 'source'];

const doc = (extra: Record<string, unknown> = {}) => ({ ...item('d1', { preview_sizes: ['small', 'medium', 'large'], filename: 'invoice.pdf' }), parsed_text: 'Line one\nLine two', download_url: 'https://dl.test/x', ...extra });

/** Routes by path: the document, its site and the thumbnail. */
function api(opts: { document?: unknown; site?: unknown; siteStatus?: number } = {}) {
  return mockFetch((c) => {
    if (c.url.includes('/site')) return { status: opts.siteStatus ?? 200, body: opts.site ?? { file_id: 'd1', status: 'none' } };
    if (c.url.includes('/files/d1')) return { body: opts.document ?? doc() };
    return { status: 404 };
  });
}
const conn = (f: ReturnType<typeof mockFetch>) => ({ baseUrl: BASE, getHeaders: () => ({ Authorization: 'Bearer k' }), fetch: f.fetch });

describe('site spec: one fixture per block type', () => {
  test.each(BLOCKS)('%s renders and matches its snapshot', (name) => {
    const r = render(<SiteRenderer spec={fx(name)} />);
    expect(r.toJSON()).toMatchSnapshot();
    const parsed = parseSiteSpec(fx(name));
    expect(parsed.unknown).toEqual([]);
    expect(parsed.blocks.map((b) => b.type)).toEqual([name]);
  });

  test('blocks are laid out in the fixed order whatever the spec order', () => {
    expect(parseSiteSpec(fx('full_shuffled')).blocks.map((b) => b.type)).toEqual(BLOCKS);
    expect(render(<SiteRenderer spec={fx('full_shuffled')} />).toJSON()).toMatchSnapshot();
  });

  test('several tables are numbered', () => {
    render(<SiteRenderer spec={fx('two_tables')} />);
    expect(screen.getByText('Items 1 of 2')).toBeTruthy();
    expect(screen.getByText('Items 2 of 2')).toBeTruthy();
  });

  test('formats dates, amounts and source refs', () => {
    render(<SiteRenderer spec={fx('full_shuffled')} />);
    expect(screen.getByText('Acme Ltd · 8 Oct 2026')).toBeTruthy();
    expect(screen.getByText('ZAR 1,245.50')).toBeTruthy();
    expect(screen.getByText('ZAR −3')).toBeTruthy();
    expect(screen.getByText('Nov 2026')).toBeTruthy();
    expect(screen.getAllByText('Page 1 · Line 12').length).toBeGreaterThan(0);
  });

  test('unknown and unusable blocks are skipped and reported once each', () => {
    const seen: unknown[] = [];
    render(<SiteRenderer spec={fx('unknown_and_invalid')} onUnknownBlock={(r) => seen.push(r)} />);
    expect(screen.getByTestId('site-hero')).toBeTruthy();
    expect(screen.getByTestId('site-summary')).toBeTruthy();
    expect(seen.map((s) => (s as { type: string; index: number; reason: string }))).toMatchObject([
      { type: 'chart', index: 1, reason: 'unknown' },
      { type: 'summary', index: 2, reason: 'invalid' },
      { type: '', index: 3, reason: 'unknown' },
      { type: 'summary', index: 5, reason: 'invalid' },
    ]);
  });

  test('an unsupported version degrades to a message and reports its blocks', () => {
    const seen: { reason: string }[] = [];
    render(<SiteRenderer spec={fx('version_2')} onUnknownBlock={(r) => seen.push(r)} />);
    expect(screen.getByText('Nothing to show')).toBeTruthy();
    expect(seen).toMatchObject([{ reason: 'unsupported_version' }]);
  });

  test('garbage specs do not throw', () => {
    for (const bad of [null, 'x', 4, {}, { version: 1 }, { version: 1, blocks: 'no' }]) {
      expect(() => render(<SiteRenderer spec={bad} />)).not.toThrow();
    }
  });

  test('links in text open through Linking, or onOpenLink', () => {
    const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
    const first = render(<SiteRenderer spec={fx('summary')} />);
    fireEvent.press(screen.getByText('https://pay.example.com/inv-204'));
    expect(open).toHaveBeenCalledWith('https://pay.example.com/inv-204');
    first.unmount();
    const custom = jest.fn();
    render(<SiteRenderer spec={fx('summary')} onOpenLink={custom} />);
    fireEvent.press(screen.getByText('https://pay.example.com/inv-204'));
    expect(custom).toHaveBeenCalledWith('https://pay.example.com/inv-204');
    open.mockRestore();
  });

  test('table rows are padded or cut to the column count', () => {
    const spec = { ...(fx('table') as object), blocks: [{ type: 'table', props: { columns: ['A', 'B'], rows: [['1'], ['1', '2', '3']] } }] };
    const b = parseSiteSpec(spec).blocks[0];
    expect(b && b.type === 'table' && b.props.rows).toEqual([['1', ''], ['1', '2']]);
  });
});

describe('tab configuration', () => {
  test('default order is Text, Preview, Content; Content needs has_site', () => {
    expect(resolveTabs(undefined, true)).toEqual(['text', 'preview', 'content']);
    expect(resolveTabs(undefined, false)).toEqual(['text', 'preview']);
    expect(resolveTabs(undefined, undefined)).toEqual(['text', 'preview']);
  });
  test('tabs is an ordered subset; junk and repeats are dropped; empty falls back to the default', () => {
    expect(resolveTabs(['content', 'text'], true)).toEqual(['content', 'text']);
    expect(resolveTabs(['preview', 'preview', 'nope'], true)).toEqual(['preview']);
    expect(resolveTabs([], true)).toEqual(['text', 'preview', 'content']);
    expect(resolveTabs(['content'], false)).toEqual([]);
  });
  test('activeTab: pick, then initial, then first, each only if visible', () => {
    expect(activeTab(['text', 'preview'], 'preview', 'text')).toBe('preview');
    expect(activeTab(['text', 'preview'], null, 'preview')).toBe('preview');
    expect(activeTab(['text', 'preview'], null, 'content')).toBe('text');
    expect(activeTab([], null, 'text')).toBeNull();
  });

  test('screen: default tabs and has_site gating, with no provider', async () => {
    const f = api({ document: doc({ has_site: false }) });
    render(<DocumentScreen documentId="d1" {...conn(f)} />);
    await waitFor(() => expect(screen.getByText('invoice.pdf')).toBeTruthy());
    expect(screen.getByTestId('document-tab-text')).toBeTruthy();
    expect(screen.getByTestId('document-tab-preview')).toBeTruthy();
    expect(screen.queryByTestId('document-tab-content')).toBeNull();
    expect(screen.getByText(/Line one/)).toBeTruthy();
    expect(f.calls.some((c) => c.url.includes('/site'))).toBe(false);
  });

  test('screen: has_site shows Content last by default, and tabs reorders; initialTab and switching work', async () => {
    const f = api({ document: doc({ has_site: true }), site: { file_id: 'd1', status: 'ready', spec: fx('full_shuffled') } });
    const onTabChange = jest.fn();
    render(<DocumentScreen documentId="d1" tabs={['content', 'text']} initialTab="content" onTabChange={onTabChange} {...conn(f)} />);
    await waitFor(() => expect(screen.getByTestId('document-tab-content')).toBeTruthy());
    const ids = screen.getByTestId('document-tabs').props.children.flat().map((c: { key: string }) => c.key);
    expect(ids).toEqual(['content', 'text']);
    expect(screen.queryByTestId('document-tab-preview')).toBeNull();
    await waitFor(() => expect(screen.getByTestId('site-hero')).toBeTruthy());
    fireEvent.press(screen.getByTestId('document-tab-text'));
    expect(onTabChange).toHaveBeenCalledWith('text');
    expect(screen.getByText(/Line one/)).toBeTruthy();
  });

  test('screen: works inside a ShelfProvider and shares one document request across tabs', async () => {
    const f = api({ document: doc() });
    const client = createShelfClient({ baseUrl: BASE, fetch: f.fetch });
    render(
      <ShelfProvider client={client}>
        <DocumentScreen documentId="d1" />
      </ShelfProvider>,
    );
    await waitFor(() => expect(screen.getByText(/Line one/)).toBeTruthy());
    expect(f.calls.filter((c) => c.url.endsWith('/files/d1')).length).toBe(1);
  });

  test('screen: load error offers retry', async () => {
    const f = mockFetch(() => ({ status: 500, body: { error: 'boom' } }));
    render(<DocumentScreen documentId="d1" {...conn(f)} />);
    await waitFor(() => expect(screen.getByText("Couldn't load the document")).toBeTruthy());
    expect(screen.getByText('Try again')).toBeTruthy();
  });
});

describe('DocumentTextView', () => {
  test('renders alone: selectable text', async () => {
    const f = api();
    render(<DocumentTextView documentId="d1" {...conn(f)} />);
    await waitFor(() => expect(screen.getByText(/Line one/)).toBeTruthy());
    expect(screen.getByText(/Line one/).props.selectable).toBe(true);
  });
  test('loading, empty, still reading, failed and error states', async () => {
    const f = api({ document: doc({ parsed_text: '' }) });
    const r = render(<DocumentTextView documentId="d1" {...conn(f)} />);
    expect(screen.getByText('Loading text')).toBeTruthy();
    await waitFor(() => expect(screen.getByText('No text')).toBeTruthy());
    r.unmount();
    render(<DocumentTextView documentId="d1" {...conn(api({ document: doc({ parsed_text: '', parse_status: 'pending' }) }))} />);
    await waitFor(() => expect(screen.getByText('Reading the document')).toBeTruthy());
    render(<DocumentTextView documentId="d1" {...conn(api({ document: doc({ parsed_text: '', parse_status: 'failed' }) }))} />);
    await waitFor(() => expect(screen.getByText("Text couldn't be read")).toBeTruthy());
    render(<DocumentTextView documentId="d1" {...conn(mockFetch(() => ({ status: 500 })))} />);
    await waitFor(() => expect(screen.getByText("Couldn't load the text")).toBeTruthy());
  });
  test('a very long text is chunked and only the first rows mount', async () => {
    const long = Array.from({ length: 20000 }, (_, i) => `line ${i} lorem ipsum dolor sit amet`).join('\n');
    const chunks = chunkText(long, 3000);
    expect(chunks.length).toBeGreaterThan(100);
    expect(chunks.every((c) => c.text.length <= 3000)).toBe(true);
    render(<DocumentTextView documentId="d1" {...conn(api({ document: doc({ parsed_text: long }) }))} />);
    await waitFor(() => expect(screen.getByText(/line 0 lorem/)).toBeTruthy());
    expect(screen.getAllByText(/lorem ipsum/).length).toBeLessThan(30);
  });
  test('chunking: pages on form feeds, long single lines split, nothing lost', () => {
    const c = chunkText('a\n\fb\fc', 100);
    expect(c.map((x) => [x.page, x.text])).toEqual([[1, 'a\n'], [2, 'b'], [3, 'c']]);
    const one = chunkText('word '.repeat(2000), 500);
    expect(one.every((x) => x.text.length <= 500)).toBe(true);
    expect(one.map((x) => x.text).join(' ').replace(/\s+/g, ' ').trim()).toBe('word '.repeat(2000).trim());
    expect(chunkText('x'.repeat(1200), 500).map((x) => x.text.length)).toEqual([500, 500, 200]);
    expect(chunkText('')).toEqual([]);
  });
});

describe('DocumentPreview', () => {
  test('renders alone: thumbnail at the default size with auth headers', async () => {
    const f = api();
    render(<DocumentPreview documentId="d1" {...conn(f)} zoom={false} />);
    await waitFor(() => expect(screen.getByTestId('preview-image')).toBeTruthy());
    const src = screen.getByTestId('preview-image').props.source;
    expect(src.uri).toBe(`${BASE}/files/d1/thumbnail?size=medium`);
    expect(src.headers.Authorization).toBe('Bearer k');
    expect(screen.queryByTestId('preview-sizes')).toBeNull();
  });
  test('showSizes lists available sizes and switching changes the request', async () => {
    const f = api({ document: doc({ preview_sizes: ['small', 'large'] }) });
    const onSizeChange = jest.fn();
    render(<DocumentPreview documentId="d1" {...conn(f)} zoom={false} showSizes onSizeChange={onSizeChange} />);
    await waitFor(() => expect(screen.getByTestId('preview-sizes')).toBeTruthy());
    expect(screen.queryByTestId('preview-size-medium')).toBeNull();
    await waitFor(() => expect(screen.getByTestId('preview-image').props.source.uri).toContain('size=large'));
    fireEvent.press(screen.getByTestId('preview-size-small'));
    expect(onSizeChange).toHaveBeenCalledWith('small');
    await waitFor(() => expect(screen.getByTestId('preview-image').props.source.uri).toContain('size=small'));
  });
  test('no preview: message and Open original through Linking', async () => {
    const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
    render(<DocumentPreview documentId="d1" {...conn(api({ document: doc({ preview_sizes: [], filename: 'a.xyz' }) }))} />);
    await waitFor(() => expect(screen.getByText('No preview for this file')).toBeTruthy());
    fireEvent.press(screen.getByTestId('preview-open-original'));
    expect(open).toHaveBeenCalledWith('https://dl.test/x');
    open.mockRestore();
  });
  test('without the zoom peers it falls back to the plain image', async () => {
    resetZoomLibsForTests();
    render(<DocumentPreview documentId="d1" {...conn(api())} />);
    await waitFor(() => expect(screen.getByTestId('preview-image')).toBeTruthy());
    expect(screen.queryByTestId('preview-zoom')).toBeNull();
  });
});

describe('DocumentPreview zoom (optional peers present)', () => {
  afterEach(() => {
    jest.dontMock('react-native-gesture-handler');
    jest.dontMock('react-native-reanimated');
    resetZoomLibsForTests();
  });
  test('uses the zoomable image when both peers load', async () => {
    const chain: any = new Proxy(function () {}, { get: () => () => chain, apply: () => chain });
    const RN = require('react-native');
    jest.doMock('react-native-gesture-handler', () => ({ Gesture: new Proxy({}, { get: () => () => chain }), GestureDetector: ({ children }: any) => children }), { virtual: true });
    jest.doMock('react-native-reanimated', () => ({ __esModule: true, default: { View: RN.View }, useSharedValue: (v: number) => ({ value: v }), useAnimatedStyle: (f: () => object) => f(), withTiming: (v: number) => v }), { virtual: true });
    resetZoomLibsForTests();
    render(<DocumentPreview documentId="d1" {...conn(api())} />);
    await waitFor(() => expect(screen.getByTestId('preview-zoom')).toBeTruthy());
  });
});

describe('DocumentContentView', () => {
  test('renders alone from the site endpoint', async () => {
    const f = api({ site: { file_id: 'd1', status: 'ready', spec: fx('hero') } });
    render(<DocumentContentView documentId="d1" {...conn(f)} />);
    await waitFor(() => expect(screen.getByText('Invoice INV-204 from Acme')).toBeTruthy());
  });
  test('stale or building with a spec shows it labelled Updating', async () => {
    const f = api({ site: { file_id: 'd1', status: 'ready', stale: true, spec: fx('hero') } });
    render(<DocumentContentView documentId="d1" {...conn(f)} pollMs={0} />);
    await waitFor(() => expect(screen.getByText('Updating…')).toBeTruthy());
  });
  test('pending: building shows a preparing message and re-reads until ready', async () => {
    jest.useFakeTimers();
    try {
      let n = 0;
      const f = mockFetch((c) => (c.url.includes('/site') ? { body: ++n < 2 ? { file_id: 'd1', status: 'building' } : { file_id: 'd1', status: 'ready', spec: fx('hero') } } : { status: 404 }));
      render(<DocumentContentView documentId="d1" {...conn(f)} pollMs={1000} />);
      await act(async () => {
        await jest.advanceTimersByTimeAsync(10);
      });
      expect(screen.getByText('Content is being prepared')).toBeTruthy();
      await act(async () => {
        await jest.advanceTimersByTimeAsync(1100);
      });
      expect(screen.getByText('Invoice INV-204 from Acme')).toBeTruthy();
    } finally {
      jest.useRealTimers();
    }
  });
  test('no site (404) is empty standalone, and preparing when a site is expected; failed says so', async () => {
    const r = render(<DocumentContentView documentId="d1" {...conn(api({ siteStatus: 404 }))} />);
    await waitFor(() => expect(screen.getByText('No generated content')).toBeTruthy());
    r.unmount();
    render(<DocumentContentView documentId="d1" expectSite pollMs={0} {...conn(api({ siteStatus: 404 }))} />);
    await waitFor(() => expect(screen.getByText('Content is being prepared')).toBeTruthy());
    render(<DocumentContentView documentId="d1" {...conn(api({ site: { file_id: 'd1', status: 'failed', error: 'nope' } }))} />);
    await waitFor(() => expect(screen.getByText("Content couldn't be generated")).toBeTruthy());
  });
  test('onUnknownBlock is forwarded', async () => {
    const seen: unknown[] = [];
    render(<DocumentContentView documentId="d1" onUnknownBlock={(r) => seen.push(r)} {...conn(api({ site: { file_id: 'd1', status: 'ready', spec: fx('unknown_and_invalid') } }))} />);
    await waitFor(() => expect(seen.length).toBe(4));
  });
});


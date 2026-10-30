import React from 'react';
import { act, render } from '@testing-library/react-native';
import { DocumentList } from '../documents';
import type { ThumbnailCache } from '../documents';
import { createCache } from '../cache';
import { createMemoryAdapter } from '../storage';
import { documentsKey } from '../hooks/useDocuments';
import { item } from './helpers';

declare const performance: { now(): number };
const BASE = 'https://api.test';
const N = 2000;
const pending = (() => new Promise(() => undefined)) as unknown as typeof fetch;
const noThumbs: ThumbnailCache = { get: async () => null, put: async () => Promise.reject(new Error('offline')), clear: async () => {} };

test(`cold start: ${N} cached documents reach the first list render in under 100 ms, with only a window of rows mounted`, async () => {
  const items = Array.from({ length: N }, (_, i) => item(`doc-${String(i).padStart(4, '0')}`, { preview_sizes: ['small'], created_at: '2026-01-01T00:00:00Z' }));
  // One untimed render of a 3-item list first: it pays for one-time module initialisation and engine warm-up in the jest
  // process (not part of "reading 2,000 cached items"). Every timed run below still starts from a fresh storage and cache.
  const warm = createMemoryAdapter();
  await createCache({ storage: warm, baseUrl: BASE, cacheScope: 'warm' }).setEntry(documentsKey('w'), { items: items.slice(0, 3), next_cursor: null });
  const w = render(<DocumentList baseUrl={BASE} fetch={pending} folderId="w" storage={warm} cacheScope="warm" thumbnailCache={noThumbs} />);
  while (w.queryAllByText('doc-0000.pdf').length === 0) await act(async () => Promise.resolve());
  w.unmount();
  const times: number[] = [];
  let rows = 0;
  for (let run = 0; run < 3; run++) {
    // A fresh storage per run, and a fresh provider cache inside the list: the entry is read from storage (JSON.parse of 2,000 items).
    const storage = createMemoryAdapter();
    await createCache({ storage, baseUrl: BASE, cacheScope: 'perf' }).setEntry(documentsKey('big'), { items, next_cursor: null });
    const start = performance.now();
    const t = render(<DocumentList baseUrl={BASE} fetch={pending} folderId="big" storage={storage} cacheScope="perf" thumbnailCache={noThumbs} />);
    // First render from cache: the first row exists. Flush microtasks (no timers), so only real work is measured.
    while (t.queryAllByText('doc-0000.pdf').length === 0) {
      if (performance.now() - start > 2000) throw new Error('list never rendered from the cache');
      await act(async () => {
        await Promise.resolve();
      });
    }
    times.push(performance.now() - start);
    rows = t.queryAllByRole('button').length;
    t.unmount();
  }
  console.log(`PERF cold start to first list render from cache, ${N} items (memory adapter): ${times.map((x) => x.toFixed(1)).join(' ms, ')} ms (each run: fresh storage and cache, after one untimed warm-up render); rows mounted: ${rows}`);
  expect(times[0]).toBeLessThan(100);
  expect(Math.max(...times)).toBeLessThan(100);
  expect(rows).toBeGreaterThan(0);
  expect(rows).toBeLessThanOrEqual(40); // windowed: initialNumToRender plus a first batch, nowhere near 2,000
});

import { createOutbox } from '../upload';
import type { ConnectivitySource, Outbox, UploadCall } from '../upload';
import { createMemoryAdapter } from '../storage';
import { ShelfError, createShelfClient } from '../core';
import type { ShelfItem } from '../core';
import { item as apiItem, mockFetch } from './helpers';

jest.useFakeTimers();

const ok = (id = 'srv') => apiItem(id) as unknown as ShelfItem;
const file = (n: number) => ({ uri: `file:///tmp/${n}.pdf`, name: `${n}.pdf`, type: 'application/pdf' });

/** An upload transport whose calls the test settles by hand. */
function controlled() {
  const calls: Array<UploadCall & { resolve: (v?: ShelfItem) => void; reject: (e: unknown) => void }> = [];
  const upload = (c: UploadCall) =>
    new Promise<ShelfItem>((resolve, reject) => {
      c.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      calls.push({ ...c, resolve: (v) => resolve(v ?? ok()), reject });
    });
  return { calls, upload };
}

function net() {
  let l: ((o: boolean) => void) | undefined;
  const source: ConnectivitySource = { tracked: true, subscribe: (fn) => ((l = fn), fn(true), () => undefined) };
  return { source, set: (o: boolean) => l?.(o) };
}

const flush = () => jest.advanceTimersByTimeAsync(0);
const base = { connectivity: false as const, random: () => 0.5, backoff: { baseMs: 1000, maxMs: 60000 } };
const outboxes: Outbox[] = [];
const make = (o: Parameters<typeof createOutbox>[0]) => {
  const ob = createOutbox(o);
  outboxes.push(ob);
  return ob;
};
afterEach(() => {
  outboxes.splice(0).forEach((o) => o.destroy());
});

test('persists the item before uploading and keeps one stable client_ref across retries', async () => {
  const storage = createMemoryAdapter();
  const t = controlled();
  const ob = make({ ...base, client: createShelfClient({ baseUrl: 'https://x.test' }), storage, upload: t.upload });
  const queued = await ob.enqueue(file(1));
  expect((await storage.list()).length).toBe(1);
  await flush();
  expect(t.calls).toHaveLength(1);
  expect(t.calls[0]!.options.client_ref).toBe(queued.client_ref);
  t.calls[0]!.reject(new ShelfError(503, 'unavailable', 'down'));
  await flush();
  await jest.advanceTimersByTimeAsync(2000);
  expect(t.calls).toHaveLength(2);
  expect(t.calls[1]!.options.client_ref).toBe(queued.client_ref);
  t.calls[1]!.resolve();
  await flush();
  expect(ob.getSnapshot().items[0]!.state).toBe('done');
  expect(await storage.list()).toEqual([]);
});

test('sends a {uri,name,type} part and client_ref through the real client (no Blob/base64)', async () => {
  const m = mockFetch([{ status: 201, body: apiItem('a') }]);
  const ob = make({ ...base, baseUrl: 'https://x.test', fetch: m.fetch });
  const q = await ob.enqueue({ ...file(1), folder_id: 'f1' });
  await flush();
  expect(m.calls).toHaveLength(1);
  const form = m.calls[0]!.init.body as unknown as { get(k: string): unknown };
  expect(form.get('client_ref')).toBe(q.client_ref);
  expect(form.get('folder_id')).toBe('f1');
  // Whatever FormData the runtime has, the file part was appended as the {uri,name,type} object or a File-like with that name,
  // never as the raw bytes we would have had to read into JS.
  const f = form.get('file') as unknown;
  expect(typeof f === 'string' ? f : JSON.stringify(f)).toMatch(/1\.pdf|\[object Object\]/);
  expect(ob.getSnapshot().counts.done).toBe(1);
});

test('backoff is exponential with jitter, capped, and gives up as failed (manual retry works)', async () => {
  const t = controlled();
  const ob = make({ ...base, client: createShelfClient({ baseUrl: 'https://x.test' }), upload: t.upload, random: () => 0.999, backoff: { baseMs: 1000, maxMs: 4000 }, maxAttempts: 4 });
  await ob.enqueue(file(1));
  await flush();
  const waits: number[] = [];
  for (let i = 0; i < 3; i++) {
    t.calls[i]!.reject(new ShelfError(500, 'boom', 'x'));
    await flush();
    const s = ob.getSnapshot().items[0]!;
    expect(s.state).toBe('pending');
    waits.push(s.nextAttemptAt - Date.now());
    await jest.advanceTimersByTimeAsync(5000);
  }
  expect(waits).toEqual([999, 1998, 3996]); // 1s, 2s, 4s ceilings x 0.999, capped at maxMs
  t.calls[3]!.reject(new ShelfError(500, 'boom', 'x'));
  await flush();
  const failed = ob.getSnapshot().items[0]!;
  expect(failed.state).toBe('failed');
  expect(failed.error?.permanent).toBe(false);
  await ob.retry(failed.id);
  await flush();
  expect(t.calls).toHaveLength(5);
  expect(t.calls[4]!.options.client_ref).toBe(failed.client_ref);
});

test('a permanent 4xx fails at once and is not retried automatically', async () => {
  const t = controlled();
  const ob = make({ ...base, client: createShelfClient({ baseUrl: 'https://x.test' }), upload: t.upload });
  await ob.enqueue(file(1));
  await flush();
  t.calls[0]!.reject(new ShelfError(415, 'unsupported', 'nope'));
  await flush();
  await jest.advanceTimersByTimeAsync(120000);
  expect(t.calls).toHaveLength(1);
  const i = ob.getSnapshot().items[0]!;
  expect([i.state, i.error?.permanent, i.error?.status]).toEqual(['failed', true, 415]);
});

test('a 401 purges the persisted queue and pauses until resume()', async () => {
  const storage = createMemoryAdapter();
  const t = controlled();
  const ob = make({ ...base, client: createShelfClient({ baseUrl: 'https://x.test' }), storage, upload: t.upload, concurrency: 1 });
  await ob.enqueue(file(1));
  await ob.enqueue(file(2));
  await flush();
  t.calls[0]!.reject(new ShelfError(401, 'unauthorized', 'revoked'));
  await flush();
  const s = ob.getSnapshot();
  expect([s.paused, s.pauseReason, s.items.length]).toEqual([true, 'auth', 0]);
  expect(await storage.list()).toEqual([]);
  await ob.enqueue(file(3)); // persisted, but nothing starts while paused
  await jest.advanceTimersByTimeAsync(60000);
  expect(t.calls).toHaveLength(1);
  ob.resume();
  await flush();
  expect(t.calls).toHaveLength(2);
});

test('limits concurrency to 3 and starts the next as slots free', async () => {
  const t = controlled();
  const ob = make({ ...base, client: createShelfClient({ baseUrl: 'https://x.test' }), upload: t.upload, concurrency: 10 });
  for (let i = 0; i < 7; i++) await ob.enqueue(file(i));
  await flush();
  expect(t.calls).toHaveLength(3);
  expect(ob.getSnapshot().counts).toMatchObject({ uploading: 3, pending: 4 });
  t.calls[0]!.resolve();
  await flush();
  expect(t.calls).toHaveLength(4);
  expect(ob.getSnapshot().counts.uploading).toBe(3);
  for (let i = 1; i < 7; i++) {
    t.calls[i]!.resolve();
    await flush();
    expect(ob.getSnapshot().counts.uploading).toBeLessThanOrEqual(3);
  }
  expect(ob.getSnapshot().counts.done).toBe(7);
});

test('restart: a new outbox over the same adapter resumes with the same client_ref', async () => {
  const storage = createMemoryAdapter();
  const a = controlled();
  const first = createOutbox({ ...base, client: createShelfClient({ baseUrl: 'https://x.test' }), storage, upload: a.upload });
  const q = await first.enqueue(file(1));
  await first.enqueue(file(2));
  await flush();
  expect(a.calls).toHaveLength(2); // both mid-upload when the app "dies"
  first.destroy();
  const b = controlled();
  const second = make({ ...base, client: createShelfClient({ baseUrl: 'https://x.test' }), storage, upload: b.upload });
  await second.ready;
  await flush();
  expect(b.calls.map((c) => c.options.client_ref).sort()).toEqual([q.client_ref, second.getSnapshot().items.find((i) => i.id !== q.id)!.client_ref].sort());
  expect(second.getSnapshot().items.map((i) => i.id)).toContain(q.id);
  b.calls.forEach((c) => c.resolve());
  await flush();
  expect(second.getSnapshot().counts.done).toBe(2);
  expect(await storage.list()).toEqual([]);
});

test('a different scope does not see another user\'s queue', async () => {
  const storage = createMemoryAdapter();
  const t = controlled();
  const a = make({ ...base, client: createShelfClient({ baseUrl: 'https://x.test' }), storage, scope: 'u1', upload: t.upload, connectivity: { tracked: true, subscribe: () => () => undefined } });
  a.pause();
  await a.enqueue(file(1));
  const b = make({ ...base, client: createShelfClient({ baseUrl: 'https://x.test' }), storage, scope: 'u2', upload: t.upload });
  await b.ready;
  expect(b.getSnapshot().items).toHaveLength(0);
});

test('offline holds uploads; coming back online retries immediately, not after the backoff', async () => {
  const n = net();
  const t = controlled();
  const ob = make({ ...base, connectivity: n.source, client: createShelfClient({ baseUrl: 'https://x.test' }), upload: t.upload });
  n.set(false);
  await ob.enqueue(file(1));
  await jest.advanceTimersByTimeAsync(30000);
  expect(t.calls).toHaveLength(0);
  expect(ob.getSnapshot().online).toBe(false);
  n.set(true);
  await flush();
  expect(t.calls).toHaveLength(1);
  // fail while "online" then go offline/online: skips the long backoff
  t.calls[0]!.reject(new TypeError('Network request failed'));
  await flush();
  n.set(false);
  await jest.advanceTimersByTimeAsync(100000);
  expect(t.calls).toHaveLength(1);
  n.set(true);
  await flush();
  expect(t.calls).toHaveLength(2);
  expect(t.calls[1]!.options.client_ref).toBe(t.calls[0]!.options.client_ref);
});

test('cancel aborts the request and marks the item failed(cancelled); remove deletes it from storage', async () => {
  const storage = createMemoryAdapter();
  const t = controlled();
  const ob = make({ ...base, client: createShelfClient({ baseUrl: 'https://x.test' }), storage, upload: t.upload });
  const q = await ob.enqueue(file(1));
  await flush();
  await ob.cancel(q.id);
  await flush();
  expect(t.calls[0]!.signal.aborted).toBe(true);
  const i = ob.getSnapshot().items[0]!;
  expect([i.state, i.error?.code]).toEqual(['failed', 'cancelled']);
  await jest.advanceTimersByTimeAsync(100000);
  expect(t.calls).toHaveLength(1);
  await ob.retry(q.id);
  await flush();
  expect(t.calls).toHaveLength(2);
  await ob.remove(q.id);
  expect(ob.getSnapshot().items).toHaveLength(0);
  expect(await storage.list()).toEqual([]);
});

test('reports progress from a custom transport', async () => {
  const ob = make({
    ...base,
    client: createShelfClient({ baseUrl: 'https://x.test' }),
    upload: (c) => {
      c.onProgress(0.4);
      return new Promise(() => undefined);
    },
  });
  await ob.enqueue(file(1));
  await flush();
  expect(ob.getSnapshot().items[0]).toMatchObject({ state: 'uploading', progress: 0.4 });
});

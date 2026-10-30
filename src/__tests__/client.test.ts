import { createShelfClient, ShelfError, isAuthLost, isOfflineError } from '../core';
import { mockFetch, item } from './helpers';

const base = 'https://api.example.com/api/shelf/';

test('merges async getHeaders into every request and never needs a key prop', async () => {
  const m = mockFetch([{ body: { name: 'x' } }]);
  const c = createShelfClient({ baseUrl: base, fetch: m.fetch, getHeaders: async () => ({ Authorization: 'Bearer t1' }) });
  expect(c.baseUrl).toBe('https://api.example.com/api/shelf');
  await c.info();
  expect(m.calls[0]!.url).toBe('https://api.example.com/api/shelf/');
  expect(m.calls[0]!.init.headers).toEqual({ Authorization: 'Bearer t1', Accept: 'application/json' });
});

test('uses global fetch when none is injected', async () => {
  const m = mockFetch([{ body: {} }]);
  const prev = globalThis.fetch;
  globalThis.fetch = m.fetch;
  try {
    await createShelfClient({ baseUrl: base }).info();
    expect(m.calls).toHaveLength(1);
  } finally {
    globalThis.fetch = prev;
  }
});

test('folders accepts an array, {folders} and null', async () => {
  const m = mockFetch([{ body: [{ id: 'a', name: 'A' }] }, { body: { folders: [{ id: 'b', name: 'B' }] } }, { body: null }]);
  const c = createShelfClient({ baseUrl: base, fetch: m.fetch });
  expect((await c.folders())[0]!.id).toBe('a');
  expect((await c.folders())[0]!.id).toBe('b');
  expect(await c.folders()).toEqual([]);
});

test('listFiles builds the query and normalises items', async () => {
  const m = mockFetch([{ body: { files: [{ ...item('f1'), preview_sizes: null }], next_cursor: 'n' } }]);
  const c = createShelfClient({ baseUrl: base, fetch: m.fetch });
  const r = await c.listFiles({ folder_id: 'fo 1', limit: 20, cursor: 'c', recursive: true });
  expect(m.calls[0]!.url).toBe(`${c.baseUrl}/files?folder_id=fo%201&limit=20&cursor=c&recursive=true`);
  expect(r.next_cursor).toBe('n');
  expect(r.items[0]!.preview_sizes).toEqual([]);
});

test('getFile, getText and getSite hit the right routes', async () => {
  const m = mockFetch([{ body: { ...item('f/1'), parsed_text: 'hello' } }, { body: { ...item('f1') } }, { body: { file_id: 'f1', status: 'ready' } }]);
  const c = createShelfClient({ baseUrl: base, fetch: m.fetch });
  expect((await c.getFile('f/1')).parsed_text).toBe('hello');
  expect(m.calls[0]!.url).toContain('/files/f%2F1');
  expect(await c.getText('f1')).toBe('');
  expect((await c.getSite('f1')).status).toBe('ready');
  expect(m.calls[2]!.url).toBe(`${c.baseUrl}/files/f1/site`);
});

test('upload streams a {uri,name,type} part with client_ref and sets no Content-Type', async () => {
  const appended: [string, unknown][] = [];
  const g = globalThis as unknown as { FormData: unknown };
  const RealFD = g.FormData;
  g.FormData = class {
    append(k: string, v: unknown) {
      appended.push([k, v]);
    }
  };
  try {
    const m = mockFetch([{ body: item('new') }]);
    const c = createShelfClient({ baseUrl: base, fetch: m.fetch, getHeaders: () => ({ Authorization: 'Bearer t' }) });
    const file = { uri: 'file:///tmp/scan.jpg', name: 'scan.jpg', type: 'image/jpeg' };
    const out = await c.upload(file, { folder_id: 'fo', client_ref: 'ref-1', on_duplicate: 'rename' });
    expect(out.id).toBe('new');
    expect(appended).toEqual([
      ['file', file],
      ['folder_id', 'fo'],
      ['client_ref', 'ref-1'],
      ['on_duplicate', 'rename'],
    ]);
    const call = m.calls[0]!;
    expect(call.init.method).toBe('POST');
    expect(call.url).toBe(`${c.baseUrl}/files`);
    expect(Object.keys(call.init.headers).map((h) => h.toLowerCase())).not.toContain('content-type');
  } finally {
    g.FormData = RealFD;
  }
});

test('updateFile, deleteFile and the folder writes', async () => {
  const m = mockFetch([{ body: item('f1') }, { status: 204 }, { body: { id: 'n', name: 'N' } }, { body: { id: 'n', name: 'M' } }, { status: 204 }]);
  const c = createShelfClient({ baseUrl: base, fetch: m.fetch });
  await c.updateFile('f1', { filename: 'b.pdf' });
  expect(m.calls[0]!.init.method).toBe('PATCH');
  expect(m.calls[0]!.init.body).toBe('{"filename":"b.pdf"}');
  expect(m.calls[0]!.init.headers['Content-Type']).toBe('application/json');
  await expect(c.deleteFile('f1')).resolves.toBeUndefined();
  expect(m.calls[1]!.init.method).toBe('DELETE');
  await c.createFolder({ name: 'N' });
  expect(m.calls[2]!.url).toBe(`${c.baseUrl}/folders`);
  await c.updateFolder('n', { name: 'M' });
  expect(m.calls[3]!.url).toBe(`${c.baseUrl}/folders/n`);
  expect(m.calls[3]!.init.method).toBe('PATCH');
  await c.deleteFolder('n');
  expect(m.calls[4]!.init.method).toBe('DELETE');
});

test('urls and authenticated sources', async () => {
  const c = createShelfClient({ baseUrl: base, getHeaders: () => ({ Authorization: 'Bearer t' }) });
  expect(c.thumbnailUrl('a b', 'small')).toBe(`${c.baseUrl}/files/a%20b/thumbnail?size=small`);
  expect(c.thumbnailUrl('a')).toBe(`${c.baseUrl}/files/a/thumbnail`);
  expect(c.originalUrl('a', 'my file.pdf')).toBe(`${c.baseUrl}/files/a/original/my%20file.pdf`);
  expect(await c.authedSource(c.thumbnailUrl('a', 'small'))).toEqual({
    uri: `${c.baseUrl}/files/a/thumbnail?size=small`,
    headers: { Authorization: 'Bearer t', Accept: '*/*' },
  });
});

test('thumbnail sends If-None-Match and treats 304 as unchanged', async () => {
  const bytes = new Uint8Array([1, 2, 3]).buffer;
  const m = mockFetch([{ status: 304 }, { raw: bytes, headers: { 'Content-Type': 'image/webp', ETag: '"e1"' } }]);
  const c = createShelfClient({ baseUrl: base, fetch: m.fetch });
  expect(await c.thumbnail('a', 'small', { etag: '"e0"' })).toEqual({ status: 304 });
  expect(m.calls[0]!.init.headers['If-None-Match']).toBe('"e0"');
  const r = await c.thumbnail('a', 'small');
  expect(r).toEqual({ status: 200, bytes, type: 'image/webp', etag: '"e1"' });
  const o = mockFetch([{ raw: bytes, headers: { 'Content-Type': 'application/pdf' } }]);
  expect(await createShelfClient({ baseUrl: base, fetch: o.fetch }).original('a', 'x.pdf')).toEqual({ bytes, type: 'application/pdf' });
});

test('typed errors carry status, code and field', async () => {
  const m = mockFetch([{ status: 422, body: { code: 'invalid', message: 'bad name', field: 'filename' } }, { status: 404 }]);
  const c = createShelfClient({ baseUrl: base, fetch: m.fetch });
  const e = await c.updateFile('x', {}).catch((x) => x);
  expect(e).toBeInstanceOf(ShelfError);
  expect([e.status, e.code, e.message, e.field]).toEqual([422, 'invalid', 'bad name', 'filename']);
  const e2 = await c.getFile('x').catch((x) => x);
  expect([e2.status, e2.code]).toEqual([404, 'http_error']);
});

test('401 and 503 not_configured are auth loss and fire onAuthLost; other failures do not', async () => {
  const lost = jest.fn();
  const m = mockFetch([{ status: 401, body: { code: 'unauthorized' } }, { status: 503, body: { error: 'not_configured' } }, { status: 503, body: { code: 'down' } }, { status: 502 }]);
  const c = createShelfClient({ baseUrl: base, fetch: m.fetch, onAuthLost: lost });
  const e1 = await c.info().catch((x) => x);
  const e2 = await c.info().catch((x) => x);
  expect(isAuthLost(e1)).toBe(true);
  expect(isAuthLost(e2)).toBe(true);
  expect(lost).toHaveBeenCalledTimes(2);
  const e3 = await c.info().catch((x) => x);
  const e4 = await c.info().catch((x) => x);
  expect([isAuthLost(e3), isOfflineError(e3), isOfflineError(e4)]).toEqual([false, true, true]);
  expect(lost).toHaveBeenCalledTimes(2);
});

test('network failure is offline, abort is not; a throwing onAuthLost does not mask the error', async () => {
  expect(isOfflineError(new TypeError('Network request failed'))).toBe(true);
  expect(isOfflineError(Object.assign(new Error('x'), { name: 'AbortError' }))).toBe(false);
  const m = mockFetch([{ status: 401 }]);
  const c = createShelfClient({ baseUrl: base, fetch: m.fetch, onAuthLost: () => { throw new Error('boom'); } });
  await expect(c.info()).rejects.toBeInstanceOf(ShelfError);
});

test('passes the abort signal through', async () => {
  const m = mockFetch([{ body: {} }]);
  const ctl = new AbortController();
  await createShelfClient({ baseUrl: base, fetch: m.fetch }).info({ signal: ctl.signal });
  expect(m.calls[0]!.init.signal).toBe(ctl.signal);
});

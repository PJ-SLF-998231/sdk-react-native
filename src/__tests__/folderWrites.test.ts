import { createShelfClient, ShelfError } from '../core';
import { mockFetch } from './helpers';

// Contract for the integration API's folder writes (shelf api internal/integrations/folders.go, docs/openapi.yaml:
// createIntegrationFolder, updateIntegrationFolder, deleteIntegrationFolder). The bodies below are the shapes the API
// writes: IntegrationFolder on success, and apiutil.ErrorBody ({error, code, message, retryable, field?}) on failure.
// Status and message strings are copied from the Go handlers.

const base = 'https://proxy.example.com/shelf';
const KEY = '11111111-1111-4111-8111-111111111111';
const SUB = '22222222-2222-4222-8222-222222222222';
const NEW = '33333333-3333-4333-8333-333333333333';

const folder = (extra: Record<string, unknown> = {}) => ({
  id: NEW,
  parent_id: KEY,
  name: 'Receipts',
  item_count: 0,
  total_item_count: 0,
  ...extra,
});

const err = (status: number, code: string, message: string, extra: Record<string, unknown> = {}) => ({
  status,
  body: { error: message, code, message, retryable: false, ...extra },
});

const READ_KEY = err(403, 'forbidden', "This integration has read-only access. Ask the folder's owner for a read_write integration to change documents.");
const OWN_FOLDER = (verb: string) => err(403, 'forbidden', `An integration can't ${verb} its own folder; the owner does that.`);
const NOT_FOUND = err(404, 'not_found', 'folder not found');

function client(replies: Parameters<typeof mockFetch>[0]) {
  const m = mockFetch(replies);
  return { m, c: createShelfClient({ baseUrl: base, fetch: m.fetch }) };
}

async function rejection(p: Promise<unknown>): Promise<ShelfError> {
  const e = await p.then(
    () => undefined,
    (x) => x,
  );
  expect(e).toBeInstanceOf(ShelfError);
  return e as ShelfError;
}

describe('createFolder', () => {
  test('POST /folders {name, parent_id} -> 201 IntegrationFolder', async () => {
    const { m, c } = client([{ status: 201, body: folder({ parent_id: SUB }) }]);
    const f = await c.createFolder({ name: 'Receipts', parent_id: SUB });
    expect(f).toEqual(folder({ parent_id: SUB }));
    expect(m.calls[0]!.url).toBe(`${base}/folders`);
    expect(m.calls[0]!.init.method).toBe('POST');
    expect(JSON.parse(String(m.calls[0]!.init.body))).toEqual({ name: 'Receipts', parent_id: SUB });
    expect(m.calls[0]!.init.headers['Content-Type']).toBe('application/json');
  });

  test('parent_id left out is sent as name only (the folder goes directly in the key folder)', async () => {
    const { m, c } = client([{ status: 201, body: folder() }]);
    await c.createFolder({ name: 'Receipts' });
    expect(JSON.parse(String(m.calls[0]!.init.body))).toEqual({ name: 'Receipts' });
  });

  test('403 forbidden for a read key', async () => {
    const e = await rejection(client([READ_KEY]).c.createFolder({ name: 'x' }));
    expect([e.status, e.code]).toEqual([403, 'forbidden']);
    expect(e.message).toMatch(/read-only access/);
  });

  test('404 not_found for a parent outside the key tree (same answer as a missing folder)', async () => {
    const e = await rejection(client([NOT_FOUND]).c.createFolder({ name: 'x', parent_id: KEY.replace(/1/g, '9') }));
    expect([e.status, e.code, e.message]).toEqual([404, 'not_found', 'folder not found']);
  });

  test('409 conflict when nested past 64 levels', async () => {
    const e = await rejection(client([err(409, 'conflict', "Folders can't be nested that deep.")]).c.createFolder({ name: 'x', parent_id: SUB }));
    expect([e.status, e.code, e.message]).toEqual([409, 'conflict', "Folders can't be nested that deep."]);
  });

  test('400 invalid_input for a bad name, and for a null parent_id', async () => {
    const { c } = client([err(400, 'invalid_input', 'name is required', { field: 'name' }), err(400, 'invalid_input', "parent_id can't be null: folders stay inside the integration's folder")]);
    const e = await rejection(c.createFolder({ name: '' }));
    expect([e.status, e.code, e.field]).toEqual([400, 'invalid_input', 'name']);
    const n = await rejection(c.createFolder({ name: 'x', parent_id: null } as never));
    expect([n.status, n.code]).toEqual([400, 'invalid_input']);
  });

  test('409 conflict for a sibling with the name', async () => {
    const e = await rejection(client([err(409, 'conflict', 'A folder with that name already exists here.')]).c.createFolder({ name: 'Receipts' }));
    expect([e.status, e.code]).toEqual([409, 'conflict']);
  });
});

describe('updateFolder', () => {
  test('rename: PATCH /folders/{id} {name} -> 200 IntegrationFolder', async () => {
    const { m, c } = client([{ body: folder({ name: 'Invoices' }) }]);
    expect(await c.updateFolder(NEW, { name: 'Invoices' })).toEqual(folder({ name: 'Invoices' }));
    expect(m.calls[0]!.url).toBe(`${base}/folders/${NEW}`);
    expect(m.calls[0]!.init.method).toBe('PATCH');
    expect(JSON.parse(String(m.calls[0]!.init.body))).toEqual({ name: 'Invoices' });
  });

  test('move: PATCH {parent_id}; both fields together', async () => {
    const { m, c } = client([{ body: folder({ parent_id: SUB }) }, { body: folder({ parent_id: SUB, name: 'Both' }) }]);
    expect((await c.updateFolder(NEW, { parent_id: SUB })).parent_id).toBe(SUB);
    expect(JSON.parse(String(m.calls[0]!.init.body))).toEqual({ parent_id: SUB });
    await c.updateFolder(NEW, { name: 'Both', parent_id: SUB });
    expect(JSON.parse(String(m.calls[1]!.init.body))).toEqual({ name: 'Both', parent_id: SUB });
  });

  test('error mapping: 403 read key, 403 own folder, uniform 404, 409 cycle / sibling / depth, 400 empty patch', async () => {
    const { c } = client([
      READ_KEY,
      OWN_FOLDER('rename or move'),
      NOT_FOUND,
      err(409, 'conflict', 'A folder can\'t go inside itself.'),
      err(409, 'conflict', "Folders can't be nested that deep."),
      err(400, 'invalid_input', 'nothing to change: send name or parent_id'),
    ]);
    const got = [];
    for (const patch of [{ name: 'a' }, { name: 'a' }, { name: 'a' }, { parent_id: SUB }, { parent_id: SUB }, {}]) {
      const e = await rejection(c.updateFolder(NEW, patch));
      got.push([e.status, e.code]);
    }
    expect(got).toEqual([
      [403, 'forbidden'],
      [403, 'forbidden'],
      [404, 'not_found'],
      [409, 'conflict'],
      [409, 'conflict'],
      [400, 'invalid_input'],
    ]);
  });

  test('the key\'s own folder is told apart from a read key by message only (both are 403 forbidden)', async () => {
    const e = await rejection(client([OWN_FOLDER('rename or move')]).c.updateFolder(KEY, { name: 'x' }));
    expect(e.message).toMatch(/own folder/);
  });
});

describe('deleteFolder', () => {
  test('DELETE /folders/{id} -> 204 resolves undefined', async () => {
    const { m, c } = client([{ status: 204 }]);
    await expect(c.deleteFolder(NEW)).resolves.toBeUndefined();
    expect(m.calls[0]!.url).toBe(`${base}/folders/${NEW}`);
    expect(m.calls[0]!.init.method).toBe('DELETE');
    expect(m.calls[0]!.init.body).toBeUndefined();
  });

  test('403 read key, 403 own folder, 404 outside the tree', async () => {
    const { c } = client([READ_KEY, OWN_FOLDER('delete'), NOT_FOUND]);
    const got = [];
    for (let i = 0; i < 3; i++) {
      const e = await rejection(c.deleteFolder(KEY));
      got.push([e.status, e.code]);
    }
    expect(got).toEqual([
      [403, 'forbidden'],
      [403, 'forbidden'],
      [404, 'not_found'],
    ]);
  });
});

test('folder errors do not trigger onAuthLost (403/404/409 are not auth loss)', async () => {
  const lost = jest.fn();
  const m = mockFetch([READ_KEY, NOT_FOUND, err(409, 'conflict', 'x')]);
  const c = createShelfClient({ baseUrl: base, fetch: m.fetch, onAuthLost: lost });
  await rejection(c.createFolder({ name: 'a' }));
  await rejection(c.deleteFolder(NEW));
  await rejection(c.updateFolder(NEW, { name: 'b' }));
  expect(lost).not.toHaveBeenCalled();
});

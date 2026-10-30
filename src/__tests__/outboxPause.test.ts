import { clearAll, clearAllRegistrySize, registerClearAllTarget } from '../cache/clear';
import { createOutbox } from '../upload';
import type { ConnectivitySource, Outbox, UploadCall } from '../upload';
import { createMemoryAdapter } from '../storage';
import { createShelfClient, credentialFingerprint, getAuthSession } from '../core';
import type { ShelfItem } from '../core';
import { item as apiItem } from './helpers';

jest.useFakeTimers();

const SECRET_OLD = 'Bearer old-secret-token-AAAA1111';
const SECRET_NEW = 'Bearer new-secret-token-BBBB2222';
const BASE = 'https://x.test';
const file = (n: number) => ({ uri: `file:///tmp/${n}.pdf`, name: `${n}.pdf`, type: 'application/pdf' });
const flush = () => jest.advanceTimersByTimeAsync(0);
const outboxes: Outbox[] = [];
afterEach(() => outboxes.splice(0).forEach((o) => o.destroy()));

/** A fake API: answers 401 to every token but `good`, and records each call (token and client_ref). A `gate` holds the replies until released. */
function api(initialGood: string | null) {
  let good = initialGood;
  const calls: Array<{ token: string | undefined; ref: string }> = [];
  let gate: Promise<void> | null = null;
  let release: () => void = () => undefined;
  const hold = () => {
    gate = new Promise<void>((r) => (release = r));
  };
  const fetchFn = (async (_url: unknown, init: { headers: Record<string, string>; body: unknown }) => {
    const form = init.body as unknown as { get?: (k: string) => unknown; _parts?: Array<[string, unknown]> };
    const ref = String(form?.get ? (form.get('client_ref') ?? '') : (form?._parts?.find(([k]) => k === 'client_ref')?.[1] ?? ''));
    calls.push({ token: init.headers.Authorization, ref });
    if (gate) await gate;
    const okReply = init.headers.Authorization === good;
    const status = okReply ? 200 : 401;
    const body = okReply ? apiItem(`srv-${calls.length}`) : { code: 'unauthorized', message: 'no' };
    return { ok: okReply, status, statusText: String(status), headers: { get: () => null }, text: async () => JSON.stringify(body), json: async () => body };
  }) as unknown as typeof fetch;
  return { fetch: fetchFn, calls, setGood: (g: string | null) => (good = g), hold, release: () => release() };
}

const base = { connectivity: false as const, random: () => 0.5, backoff: { baseMs: 1000, maxMs: 60000 } };

function boot(o: {
  storage: ReturnType<typeof createMemoryAdapter>;
  token: string | (() => string);
  server: ReturnType<typeof api>;
  onAuthLost?: () => void;
  getHeaders?: () => Record<string, string>;
  connectivity?: ConnectivitySource;
  scope?: string;
}) {
  const client = createShelfClient({
    baseUrl: BASE,
    fetch: o.server.fetch,
    getHeaders: o.getHeaders ?? (() => ({ Authorization: typeof o.token === 'function' ? o.token() : o.token })),
  });
  const ob = createOutbox({ ...base, ...(o.connectivity ? { connectivity: o.connectivity } : {}), client, storage: o.storage, scope: o.scope, onAuthLost: o.onAuthLost });
  outboxes.push(ob);
  return { ob, client };
}

/** First run: three files queued, every request refused. Leaves a paused queue (and its persisted pause) in `storage`, then "kills" the app. */
async function pausedStorage(scope?: string) {
  const storage = createMemoryAdapter();
  const server = api(null);
  const { ob } = boot({ storage, token: SECRET_OLD, server, scope });
  for (const n of [1, 2, 3]) await ob.enqueue(file(n));
  await flush();
  expect(ob.getSnapshot().pauseReason).toBe('auth');
  const refs = ob.getSnapshot().items.map((i) => i.client_ref).sort();
  await flush();
  ob.destroy();
  return { storage, refs };
}

const keys = async (s: ReturnType<typeof createMemoryAdapter>) => (await s.list()).sort();
const pauseRecord = async (s: ReturnType<typeof createMemoryAdapter>) => {
  const k = (await s.list()).find((x) => x.endsWith('~pause'));
  return k ? JSON.parse((await s.get(k)) as string) : null;
};

describe('the pause is persisted with the queue', () => {
  test('reason, pausedAt and the credential fingerprint are stored; no header value is', async () => {
    const { storage } = await pausedStorage();
    const rec = await pauseRecord(storage);
    expect(rec).toEqual({ v: 1, reason: 'auth', pausedAt: expect.any(Number), fingerprint: credentialFingerprint({ Authorization: SECRET_OLD }) });
    expect(rec.fingerprint).toMatch(/^[0-9a-f]{16}$/);
  });

  test('grep over every persisted key and value: no credential, header value or token fragment; nothing logged either', async () => {
    const logged: string[] = [];
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => jest.spyOn(console, m).mockImplementation((...a: unknown[]) => void logged.push(a.map(String).join(' '))));
    const { storage } = await pausedStorage();
    // a restart, a refused probe with a new credential, then a persisted-pause rewrite
    const { ob } = boot({ storage, token: SECRET_NEW, server: api(null) });
    await ob.ready;
    await flush();
    const everything = (await storage.list()).map(async (k) => k + '\n' + (await storage.get(k)));
    const dump = (await Promise.all(everything)).join('\n');
    expect((await storage.list()).some((k) => k.endsWith('~pause'))).toBe(true);
    for (const needle of [SECRET_OLD, SECRET_NEW, 'secret', 'Bearer', 'Authorization', 'AAAA1111', 'BBBB2222']) expect(dump).not.toContain(needle);
    expect(logged.join('\n')).not.toMatch(/secret|Bearer|AAAA1111|BBBB2222/);
    spies.forEach((s) => s.mockRestore());
  });
});

describe('restart with a persisted pause', () => {
  test('different fingerprint: one probe item, success resumes and drains the rest once each, onAuthLost never fires', async () => {
    const { storage, refs } = await pausedStorage();
    const server = api(SECRET_NEW);
    server.hold();
    const onAuthLost = jest.fn();
    const { ob, client } = boot({ storage, token: SECRET_NEW, server, onAuthLost });
    await ob.ready;
    expect(ob.getSnapshot().pauseReason).toBe('auth'); // known before anything is sent
    await flush();
    expect(server.calls).toHaveLength(1); // ONE probe
    expect(ob.getSnapshot()).toMatchObject({ paused: true, probing: true });
    await jest.advanceTimersByTimeAsync(5000);
    expect(server.calls).toHaveLength(1);
    server.release();
    await flush();
    await flush();
    const s = ob.getSnapshot();
    expect([s.paused, s.probing, s.pauseReason]).toEqual([false, false, null]);
    expect(s.items.map((i) => i.state)).toEqual(['done', 'done', 'done']);
    expect(server.calls).toHaveLength(3);
    expect(server.calls.map((c) => c.ref).sort()).toEqual(refs); // each file exactly once, same client_ref as before
    expect(onAuthLost).not.toHaveBeenCalled();
    expect(getAuthSession(client).active).toBeNull(); // the W1 episode ended
    expect(await keys(storage)).toEqual([]); // queue and pause record gone
  });

  test('different fingerprint, probe refused: stays paused, onAuthLost does not fire again, the queue is intact; retryNow() with an accepted credential then resumes', async () => {
    const { storage } = await pausedStorage();
    const server = api(null);
    const onAuthLost = jest.fn();
    let token = SECRET_NEW;
    const { ob } = boot({ storage, token: () => token, server, onAuthLost });
    await ob.ready;
    await flush();
    expect(server.calls).toHaveLength(1);
    expect(ob.getSnapshot()).toMatchObject({ paused: true, probing: false, pauseReason: 'auth' });
    await jest.advanceTimersByTimeAsync(120000);
    expect(server.calls).toHaveLength(1); // no retry loop
    expect(onAuthLost).not.toHaveBeenCalled();
    expect((await keys(storage)).filter((k) => !k.endsWith('~pause'))).toHaveLength(3);
    expect((await pauseRecord(storage)).fingerprint).toBe(credentialFingerprint({ Authorization: SECRET_NEW })); // remembers the newer refused credential
    // retryNow: one more probe, still refused, still silent
    ob.retryNow();
    await flush();
    expect(server.calls).toHaveLength(2);
    expect(onAuthLost).not.toHaveBeenCalled();
    // the credential is accepted now: the next probe works and the queue drains
    server.setGood(SECRET_NEW);
    ob.retryNow();
    await flush();
    await flush();
    expect(ob.getSnapshot().paused).toBe(false);
    expect(server.calls).toHaveLength(5); // 2 refused probes + the successful probe + the other two items
    expect(onAuthLost).not.toHaveBeenCalled();
    expect(token).toBe(SECRET_NEW);
  });

  test('a refusal after a successful probe is a new episode: onAuthLost fires once', async () => {
    const { storage } = await pausedStorage();
    const server = api(SECRET_NEW);
    const onAuthLost = jest.fn();
    const { ob } = boot({ storage, token: SECRET_NEW, server, onAuthLost });
    await ob.ready;
    await flush();
    await flush();
    expect(ob.getSnapshot().paused).toBe(false);
    expect(onAuthLost).not.toHaveBeenCalled();
    server.setGood(null); // revoked
    await ob.enqueue(file(9));
    await flush();
    expect(ob.getSnapshot().pauseReason).toBe('auth');
    expect(onAuthLost).toHaveBeenCalledTimes(1);
  });

  test('same fingerprint: stays paused and sends nothing until resume(); then drains', async () => {
    const { storage, refs } = await pausedStorage();
    const server = api(SECRET_OLD);
    const onAuthLost = jest.fn();
    const { ob } = boot({ storage, token: SECRET_OLD, server, onAuthLost });
    await ob.ready;
    await flush();
    await jest.advanceTimersByTimeAsync(120000);
    expect(server.calls).toHaveLength(0);
    expect(ob.getSnapshot()).toMatchObject({ paused: true, pauseReason: 'auth', probing: false });
    expect(onAuthLost).not.toHaveBeenCalled();
    ob.resume();
    await flush();
    await flush();
    expect(server.calls.map((c) => c.ref).sort()).toEqual(refs);
    expect(ob.getSnapshot().paused).toBe(false);
    expect(await keys(storage)).toEqual([]);
  });

  test('retryNow() does one probe even when the fingerprint is the same', async () => {
    const { storage } = await pausedStorage();
    const server = api(null);
    const { ob } = boot({ storage, token: SECRET_OLD, server });
    await ob.ready;
    await flush();
    expect(server.calls).toHaveLength(0);
    ob.retryNow();
    await flush();
    expect(server.calls).toHaveLength(1);
    expect(ob.getSnapshot().pauseReason).toBe('auth');
  });

  test('a credential change seen later while paused (same fingerprint at start) earns one probe', async () => {
    const { storage } = await pausedStorage();
    const server = api(SECRET_NEW);
    let token = SECRET_OLD;
    const { ob, client } = boot({ storage, token: () => token, server });
    await ob.ready;
    await flush();
    expect(server.calls).toHaveLength(0);
    token = SECRET_NEW;
    await client.info().catch(() => undefined); // any request reads getHeaders and sees the new credential
    await flush();
    await flush();
    expect(ob.getSnapshot().paused).toBe(false);
    expect(server.calls.filter((c) => c.ref)).toHaveLength(3);
  });

  test('getHeaders throws at startup: stays paused, no crash, onAuthLost silent, nothing sent', async () => {
    const { storage } = await pausedStorage();
    const server = api(SECRET_NEW);
    const onAuthLost = jest.fn();
    const getHeaders = jest.fn(() => {
      throw new Error('keychain locked');
    });
    const { ob } = boot({ storage, token: '', server, getHeaders, onAuthLost });
    await ob.ready;
    await flush();
    await jest.advanceTimersByTimeAsync(120000);
    expect(getHeaders).toHaveBeenCalledTimes(1);
    expect(ob.getSnapshot()).toMatchObject({ paused: true, pauseReason: 'auth', probing: false });
    expect(server.calls).toHaveLength(0);
    expect(onAuthLost).not.toHaveBeenCalled();
    expect((await keys(storage)).length).toBe(4); // 3 items + the pause
  });

  test('offline at startup: stays paused and quiet; when the network returns the (different credential) probe goes out', async () => {
    const { storage } = await pausedStorage();
    const server = api(SECRET_NEW);
    let set!: (o: boolean) => void;
    const connectivity: ConnectivitySource = { tracked: true, subscribe: (fn) => ((set = fn), fn(false), () => undefined) };
    const onAuthLost = jest.fn();
    const { ob } = boot({ storage, token: SECRET_NEW, server, onAuthLost, connectivity });
    await ob.ready;
    await flush();
    await jest.advanceTimersByTimeAsync(60000);
    expect(server.calls).toHaveLength(0);
    expect(ob.getSnapshot()).toMatchObject({ paused: true, online: false, pauseReason: 'auth' });
    set(true);
    await flush();
    await flush();
    expect(ob.getSnapshot().paused).toBe(false);
    expect(server.calls).toHaveLength(3);
    expect(onAuthLost).not.toHaveBeenCalled();
  });

  test('different fingerprint with an empty queue just lifts the pause', async () => {
    const storage = createMemoryAdapter();
    const server = api(null);
    const first = boot({ storage, token: SECRET_OLD, server });
    await first.ob.enqueue(file(1));
    await flush();
    expect(first.ob.getSnapshot().pauseReason).toBe('auth');
    await first.ob.remove(first.ob.getSnapshot().items[0]!.id);
    first.ob.destroy();
    const { ob } = boot({ storage, token: SECRET_NEW, server });
    await ob.ready;
    await flush();
    expect(ob.getSnapshot().paused).toBe(false);
    expect(await keys(storage)).toEqual([]);
  });

  test('a manual pause is not persisted', async () => {
    const storage = createMemoryAdapter();
    const { ob } = boot({ storage, token: SECRET_OLD, server: api(SECRET_OLD) });
    await ob.ready;
    ob.pause();
    await flush();
    expect(await keys(storage)).toEqual([]);
  });
});

describe('the persisted pause is cleared', () => {
  test('by resume()', async () => {
    const { storage } = await pausedStorage();
    const { ob } = boot({ storage, token: SECRET_OLD, server: api(SECRET_OLD) });
    await ob.ready;
    await flush();
    expect(await pauseRecord(storage)).not.toBeNull();
    ob.resume();
    await flush();
    expect(await pauseRecord(storage)).toBeNull();
  });

  test('by clearAll() on storage alone, and by clearAll() reaching a live paused outbox', async () => {
    const a = await pausedStorage('u1');
    await clearAll({ storage: a.storage, baseUrl: BASE, cacheScope: 'u1' });
    expect(await keys(a.storage)).toEqual([]);
    const b = await pausedStorage('u2');
    const { ob } = boot({ storage: b.storage, token: SECRET_OLD, server: api(null), scope: 'u2' });
    await ob.ready;
    expect(ob.getSnapshot().paused).toBe(true);
    await clearAll({ storage: b.storage, baseUrl: BASE, cacheScope: 'u2' });
    expect(await keys(b.storage)).toEqual([]);
    expect(ob.getSnapshot()).toMatchObject({ paused: false, pauseReason: null, items: [] });
    // the next user starts clean: a restart finds nothing paused
    ob.destroy();
    const fresh = boot({ storage: b.storage, token: SECRET_NEW, server: api(SECRET_NEW), scope: 'u2' });
    await fresh.ob.ready;
    expect(fresh.ob.getSnapshot().paused).toBe(false);
  });
});

describe('clearAll registry', () => {
  const transport = (_c: UploadCall) => new Promise<ShelfItem>(() => undefined);

  test('destroy() removes the outbox from the registry', () => {
    const before = clearAllRegistrySize();
    const obs = Array.from({ length: 5 }, () => createOutbox({ ...base, upload: transport }));
    expect(clearAllRegistrySize()).toBe(before + 5);
    obs.forEach((o) => o.destroy());
    expect(clearAllRegistrySize()).toBe(before);
  });

  test('targets are held weakly: a collected one is dropped on the next clearAll', async () => {
    const original = (globalThis as { WeakRef?: unknown }).WeakRef;
    class FakeWeakRef<T extends object> {
      constructor(private t: T) {}
      deref(): T | undefined {
        return dead ? undefined : this.t;
      }
    }
    let dead = false;
    (globalThis as { WeakRef?: unknown }).WeakRef = FakeWeakRef;
    try {
      const before = clearAllRegistrySize();
      const cleared = jest.fn();
      registerClearAllTarget({ clear: cleared });
      expect(clearAllRegistrySize()).toBe(before + 1);
      await clearAll();
      expect(cleared).toHaveBeenCalledTimes(1);
      dead = true; // the target was garbage collected
      await clearAll();
      expect(cleared).toHaveBeenCalledTimes(1);
      expect(clearAllRegistrySize()).toBe(before);
    } finally {
      (globalThis as { WeakRef?: unknown }).WeakRef = original;
    }
  });
});

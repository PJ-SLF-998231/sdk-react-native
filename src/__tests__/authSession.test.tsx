import React from 'react';
import { Text } from 'react-native';
import { render, waitFor } from '@testing-library/react-native';
import { ShelfError, createAuthSession, createShelfClient, credentialFingerprint, getAuthSession, sha256Hex } from '../core';
import type { ShelfClient } from '../core';
import { ShelfProvider } from '../provider';
import { useDocuments, useFolders } from '../hooks';
import { createOutbox } from '../upload';
import { createMemoryAdapter } from '../storage';
import { mockFetch } from './helpers';

const BASE = 'https://api.test';
const SECRET = 'Bearer super-secret-token-123';
const e401 = () => new ShelfError(401, 'unauthorized', 'no');
const e503 = () => new ShelfError(503, 'not_configured', 'no key');
const settle = () => new Promise<void>((r) => setTimeout(r, 0));

describe('credentialFingerprint', () => {
  test('SHA-256 matches the standard vectors', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256Hex('a'.repeat(1000))).toBe('41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3');
    expect(sha256Hex('héllo €😀')).toHaveLength(64);
  });

  test('is truncated, stable under key order and name case, and differs per credential', () => {
    const a = credentialFingerprint({ Authorization: SECRET, 'X-A': '1' });
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(credentialFingerprint({ 'x-a': '1', authorization: SECRET })).toBe(a);
    expect(credentialFingerprint({ Authorization: SECRET + 'x', 'X-A': '1' })).not.toBe(a);
    expect(credentialFingerprint({})).toMatch(/^[0-9a-f]{16}$/);
    expect(credentialFingerprint(undefined)).toBe(credentialFingerprint({}));
    expect(a).not.toContain('secret');
  });
});

describe('AuthSession', () => {
  test('a burst of failures opens one episode and notifies once; later failures stay silent', () => {
    const s = createAuthSession();
    const host = jest.fn();
    s.onAuthLost(() => host);
    const events: string[] = [];
    s.onEpisode((e) => events.push(e.type));
    expect([s.reportAuthFailure(e401()), s.reportAuthFailure(e401()), s.reportAuthFailure(e503())]).toEqual([true, false, false]);
    expect(host).toHaveBeenCalledTimes(1);
    expect(s.active?.reason).toBe('auth');
    expect(events).toEqual(['start']);
  });

  test('ignores errors that are not auth loss', () => {
    const s = createAuthSession();
    expect(s.reportAuthFailure(new ShelfError(500, 'boom', 'x'))).toBe(false);
    expect(s.reportAuthFailure(new ShelfError(503, 'down', 'x'))).toBe(false);
    expect(s.active).toBeNull();
  });

  test('a success ends the episode and the next failure is a new one', () => {
    const s = createAuthSession();
    const host = jest.fn();
    s.onAuthLost(() => host);
    s.reportAuthFailure(e401());
    expect(s.reportSuccess()).toBe(true);
    expect(s.active).toBeNull();
    expect(s.reportAuthFailure(e503())).toBe(true);
    expect(host).toHaveBeenCalledTimes(2);
    expect(s.active?.reason).toBe('not_configured');
  });

  test('a success from a request that began before the episode does not end it', () => {
    const s = createAuthSession();
    const early = s.begin();
    s.reportAuthFailure(e401());
    expect(s.reportSuccess(early)).toBe(false);
    expect(s.active).not.toBeNull();
    expect(s.reportSuccess(s.begin())).toBe(true);
  });

  test('resume() ends the episode', () => {
    const s = createAuthSession();
    const host = jest.fn();
    s.onAuthLost(() => host);
    const ends: string[] = [];
    s.onEpisode((e) => e.type === 'end' && ends.push(e.cause));
    s.reportAuthFailure(e401());
    expect(s.resume()).toBe(true);
    expect(s.resume()).toBe(false);
    s.reportAuthFailure(e401());
    expect(host).toHaveBeenCalledTimes(2);
    expect(ends).toEqual(['resume']);
  });

  test('a different credential fingerprint ends the episode; the same one does not; a stale failure is ignored', () => {
    const s = createAuthSession();
    const host = jest.fn();
    s.onAuthLost(() => host);
    s.observeCredential('aaaa');
    s.reportAuthFailure(e401(), { fingerprint: 'aaaa' });
    s.observeCredential('aaaa');
    expect(s.active).not.toBeNull();
    s.observeCredential('bbbb');
    expect(s.active).toBeNull();
    expect(s.reportAuthFailure(e401(), { fingerprint: 'aaaa' })).toBe(false); // refused under the replaced credential
    expect(host).toHaveBeenCalledTimes(1);
    expect(s.reportAuthFailure(e401(), { fingerprint: 'bbbb' })).toBe(true);
    expect(host).toHaveBeenCalledTimes(2);
  });

  test('one callback function subscribed twice is called once; distinct callbacks once each; throwing ones are contained', () => {
    const s = createAuthSession();
    const same = jest.fn();
    const other = jest.fn();
    s.onAuthLost(() => same);
    s.onAuthLost(() => same);
    s.onAuthLost(() => {
      throw new Error('boom');
    });
    s.onAuthLost(() => other);
    s.onEpisode(() => {
      throw new Error('boom');
    });
    s.reportAuthFailure(e401());
    expect([same.mock.calls.length, other.mock.calls.length]).toEqual([1, 1]);
  });

  test('stores and exposes no credential value', () => {
    const s = createAuthSession();
    const logs = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const fp = credentialFingerprint({ Authorization: SECRET });
    s.observeCredential(fp);
    s.reportAuthFailure(e401());
    const dump = JSON.stringify({ a: s.active, f: s.fingerprint });
    expect(dump).not.toContain('super-secret');
    expect(dump).toContain(fp);
    expect(logs).not.toHaveBeenCalled();
    logs.mockRestore();
  });
});

describe('client', () => {
  test('a concurrent 401 burst fires onAuthLost once and every caller still gets its error', async () => {
    const m = mockFetch(() => ({ status: 401 }));
    const lost = jest.fn();
    const c = createShelfClient({ baseUrl: BASE, fetch: m.fetch, getHeaders: () => ({ Authorization: SECRET }), onAuthLost: lost });
    const results = await Promise.all(Array.from({ length: 10 }, () => c.info().catch((e) => e)));
    expect(results.every((e) => e instanceof ShelfError && e.status === 401)).toBe(true);
    expect(m.calls).toHaveLength(10);
    expect(lost).toHaveBeenCalledTimes(1);
    await c.folders().catch(() => undefined);
    expect(lost).toHaveBeenCalledTimes(1); // still the same episode
  });

  test('a mix of 401 and 503 not_configured is one episode', async () => {
    let n = 0;
    const m = mockFetch(() => (n++ % 2 ? { status: 503, body: { code: 'not_configured' } } : { status: 401 }));
    const lost = jest.fn();
    const c = createShelfClient({ baseUrl: BASE, fetch: m.fetch, onAuthLost: lost });
    await Promise.all([c.info(), c.info(), c.folders(), c.getFile('x')].map((p) => p.catch(() => undefined)));
    expect(lost).toHaveBeenCalledTimes(1);
  });

  test('a success starts a new episode window: failure, success, failure fires twice', async () => {
    const replies = [{ status: 401 }, { status: 401 }, { body: {} }, { status: 401 }];
    const m = mockFetch(replies);
    const lost = jest.fn();
    const c = createShelfClient({ baseUrl: BASE, fetch: m.fetch, onAuthLost: lost });
    await c.info().catch(() => undefined);
    await c.info().catch(() => undefined);
    expect(lost).toHaveBeenCalledTimes(1);
    await c.info();
    expect(getAuthSession(c).active).toBeNull();
    await c.info().catch(() => undefined);
    expect(lost).toHaveBeenCalledTimes(2);
  });

  test('an in-flight request that succeeds after the failure does not end the episode', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let i = 0;
    const slow = (async (_u: unknown, _i: unknown) => {
      const n = i++;
      if (n === 0) await gate; // the first request answers last, with a success
      const status = n === 0 ? 200 : 401;
      return { ok: status === 200, status, statusText: '', headers: { get: () => null }, text: async () => '{}', json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) };
    }) as unknown as typeof fetch;
    const lost = jest.fn();
    const c = createShelfClient({ baseUrl: BASE, fetch: slow, onAuthLost: lost });
    const first = c.info();
    await settle();
    await c.info().catch(() => undefined);
    release();
    await first;
    await c.info().catch(() => undefined);
    expect(lost).toHaveBeenCalledTimes(1);
  });

  test('a changed getHeaders credential ends the episode, so a refusal of the new one fires again', async () => {
    let token = 'old';
    const m = mockFetch(() => ({ status: 401 }));
    const lost = jest.fn();
    const c = createShelfClient({ baseUrl: BASE, fetch: m.fetch, getHeaders: () => ({ Authorization: token }), onAuthLost: lost });
    await c.info().catch(() => undefined);
    await c.info().catch(() => undefined);
    expect(lost).toHaveBeenCalledTimes(1);
    token = 'fresh';
    await c.info().catch(() => undefined);
    expect(lost).toHaveBeenCalledTimes(2);
  });

  test('resume() on the session ends the episode', async () => {
    const m = mockFetch(() => ({ status: 401 }));
    const lost = jest.fn();
    const c = createShelfClient({ baseUrl: BASE, fetch: m.fetch, onAuthLost: lost });
    await c.info().catch(() => undefined);
    getAuthSession(c).resume();
    await c.info().catch(() => undefined);
    expect(lost).toHaveBeenCalledTimes(2);
  });

  test('the session holds only a fingerprint of the credential', async () => {
    const m = mockFetch(() => ({ status: 401 }));
    const c = createShelfClient({ baseUrl: BASE, fetch: m.fetch, getHeaders: () => ({ Authorization: SECRET }) });
    await c.info().catch(() => undefined);
    const s = getAuthSession(c);
    expect(s.fingerprint).toBe(credentialFingerprint({ Authorization: SECRET }));
    expect(JSON.stringify({ a: s.active, f: s.fingerprint })).not.toContain('super-secret');
  });
});

function Folders({ client }: { client?: ShelfClient }) {
  const r = useFolders(client ? { client } : {});
  return <Text>{r.error ? 'error' : 'ok'}</Text>;
}
function Docs() {
  const r = useDocuments(null);
  return <Text>{r.error ? 'error' : 'ok'}</Text>;
}

describe('provider, hooks and outbox', () => {
  test('injected client under a provider: a burst of failing hooks and requests calls onAuthLost once, and errors reach direct callers', async () => {
    const m = mockFetch(() => ({ status: 401 }));
    const client = createShelfClient({ baseUrl: BASE, fetch: m.fetch });
    const onAuthLost = jest.fn();
    function Both() {
      const f = useFolders({});
      const d = useDocuments(null);
      void f;
      void d;
      return <Text>x</Text>;
    }
    render(
      <ShelfProvider client={client} onAuthLost={onAuthLost}>
        <Both />
      </ShelfProvider>,
    );
    await waitFor(() => expect(m.calls.length).toBeGreaterThanOrEqual(2));
    const direct = await Promise.all([client.info(), client.info(), client.getFile('a')].map((p) => p.catch((e) => e)));
    expect(direct.every((e) => e instanceof ShelfError)).toBe(true);
    await settle();
    expect(onAuthLost).toHaveBeenCalledTimes(1);
  });

  test('a client with its own onAuthLost plus a provider callback: each once per episode', async () => {
    const m = mockFetch(() => ({ status: 401 }));
    const own = jest.fn();
    const client = createShelfClient({ baseUrl: BASE, fetch: m.fetch, onAuthLost: own });
    const host = jest.fn();
    render(
      <ShelfProvider client={client} onAuthLost={host}>
        <Text>x</Text>
      </ShelfProvider>,
    );
    await Promise.all([client.info(), client.info()].map((p) => p.catch(() => undefined)));
    expect([own.mock.calls.length, host.mock.calls.length]).toEqual([1, 1]);
  });

  test('two providers sharing a client (same callback) and two components fire once', async () => {
    const m = mockFetch(() => ({ status: 401 }));
    const client = createShelfClient({ baseUrl: BASE, fetch: m.fetch });
    const onAuthLost = jest.fn();
    render(
      <>
        <ShelfProvider client={client} onAuthLost={onAuthLost}>
          <Folders />
          <Docs />
        </ShelfProvider>
        <ShelfProvider client={client} onAuthLost={onAuthLost}>
          <Folders />
        </ShelfProvider>
        <Folders client={client} />
      </>,
    );
    await waitFor(() => expect(m.calls.length).toBeGreaterThanOrEqual(3));
    await Promise.all([client.info(), client.info()].map((p) => p.catch(() => undefined)));
    await settle();
    expect(onAuthLost).toHaveBeenCalledTimes(1);
  });

  test('a provider-built client: one call for a burst, then a new episode after a success', async () => {
    let fail = true;
    const m = mockFetch(() => (fail ? { status: 401 } : { body: {} }));
    const onAuthLost = jest.fn();
    let client!: ShelfClient;
    const Grab = () => {
      client = require('../provider').useShelf().client;
      return null;
    };
    render(
      <ShelfProvider baseUrl={BASE} fetch={m.fetch} onAuthLost={onAuthLost}>
        <Grab />
      </ShelfProvider>,
    );
    await Promise.all([client.info(), client.info(), client.info()].map((p) => p.catch(() => undefined)));
    expect(onAuthLost).toHaveBeenCalledTimes(1);
    fail = false;
    await client.info();
    fail = true;
    await client.info().catch(() => undefined);
    expect(onAuthLost).toHaveBeenCalledTimes(2);
  });

  test('outbox plus requests on the same client: one call; the outbox stays paused; resume() then refusal fires again', async () => {
    const m = mockFetch(() => ({ status: 401 }));
    const client = createShelfClient({ baseUrl: BASE, fetch: m.fetch });
    const outboxLost = jest.fn();
    const hostLost = jest.fn();
    render(
      <ShelfProvider client={client} onAuthLost={hostLost}>
        <Text>x</Text>
      </ShelfProvider>,
    );
    const ob = createOutbox({ client, storage: createMemoryAdapter(), connectivity: false, onAuthLost: outboxLost, concurrency: 3 });
    try {
      for (let i = 0; i < 4; i++) await ob.enqueue({ uri: `file:///tmp/${i}.pdf`, name: `${i}.pdf`, type: 'application/pdf' });
      await waitFor(() => expect(ob.getSnapshot().pauseReason).toBe('auth'));
      await Promise.all([client.info(), client.folders()].map((p) => p.catch(() => undefined)));
      await settle();
      expect(hostLost).toHaveBeenCalledTimes(1);
      expect(outboxLost).toHaveBeenCalledTimes(1);
      expect(ob.getSnapshot().paused).toBe(true);
      expect(ob.getSnapshot().items.every((i) => i.state === 'pending')).toBe(true);
      ob.resume();
      await waitFor(() => expect(hostLost).toHaveBeenCalledTimes(2));
      expect(ob.getSnapshot().pauseReason).toBe('auth');
    } finally {
      ob.destroy();
    }
  });
});

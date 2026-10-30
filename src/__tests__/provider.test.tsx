import React from 'react';
import { Text } from 'react-native';
import { render, screen, waitFor } from '@testing-library/react-native';
import { ShelfProvider, useShelf, createShelfClient, createMemoryAdapterForTests } from './provider-helpers';
import { mockFetch } from './helpers';
import { createOutbox } from '../upload';
import { darkTheme, lightTheme } from '../theme';
import type { ShelfConnectionProps } from '../provider';

function Probe({ props, onValue }: { props?: ShelfConnectionProps; onValue?: (v: ReturnType<typeof useShelf>) => void }) {
  const v = useShelf(props);
  onValue?.(v);
  return <Text>{`${v.client.baseUrl}|${v.theme.mode}`}</Text>;
}

jest.mock('react-native/Libraries/Utilities/useColorScheme', () => ({ __esModule: true, default: () => 'dark' }));

test('works with no provider via baseUrl + getHeaders, memory-only cache, and uses fresh headers per request', async () => {
  const m = mockFetch([{ body: {} }, { body: {} }]);
  let token = 't1';
  let v!: ReturnType<typeof useShelf>;
  render(<Probe props={{ baseUrl: 'https://x.test/api/', getHeaders: () => ({ Authorization: token }), fetch: m.fetch }} onValue={(x) => (v = x)} />);
  expect(screen.getByText('https://x.test/api|light')).toBeTruthy(); // device is dark but the SDK does not follow it
  expect(v.cache.persistent).toBe(false);
  await v.client.info();
  token = 't2';
  await v.client.info();
  expect(m.calls.map((c) => c.init.headers.Authorization)).toEqual(['t1', 't2']);
});

test('works with no provider via a ready client', () => {
  const client = createShelfClient({ baseUrl: 'https://c.test' });
  render(<Probe props={{ client }} />);
  expect(screen.getByText('https://c.test|light')).toBeTruthy();
});

test('throws a clear error with neither a provider nor connection props', () => {
  const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  expect(() => render(<Probe />)).toThrow(/Shelf: pass a `client`/);
  spy.mockRestore();
});

test('provider supplies client, theme and offline settings to descendants; explicit props win', () => {
  const seen: ReturnType<typeof useShelf>[] = [];
  render(
    <ShelfProvider baseUrl="https://p.test" theme="dark" themeOverrides={{ colors: { accent: '#123456' } }} offline={{ staleMs: 5 }}>
      <Probe onValue={(v) => seen.push(v)} />
      <Probe props={{ baseUrl: 'https://own.test' }} />
    </ShelfProvider>,
  );
  expect(screen.getByText('https://p.test|dark')).toBeTruthy();
  expect(screen.getByText('https://own.test|light')).toBeTruthy();
  expect(seen[0]!.theme.colors.accent).toBe('#123456');
  expect(seen[0]!.theme.colors.bg).toBe(darkTheme.colors.bg);
  expect(seen[0]!.offline).toEqual({ enabled: true, staleMs: 5 });
});

test('theme="system" follows the device only when opted in; a full theme object is used as given', () => {
  render(<ShelfProvider baseUrl="https://s.test" theme="system"><Probe /></ShelfProvider>);
  expect(screen.getByText('https://s.test|dark')).toBeTruthy();
  render(<ShelfProvider baseUrl="https://t.test" theme={lightTheme}><Probe /></ShelfProvider>);
  expect(screen.getByText('https://t.test|light')).toBeTruthy();
});

test('persistence needs storage + cacheScope + offline enabled; offline.enabled=false is memory-only', () => {
  const storage = createMemoryAdapterForTests();
  const persistentFor = (p: Partial<React.ComponentProps<typeof ShelfProvider>>): boolean => {
    let out: boolean | undefined;
    render(
      <ShelfProvider baseUrl="https://a.test" {...p}>
        <Probe onValue={(v) => (out = v.cache.persistent)} />
      </ShelfProvider>,
    );
    return out as boolean;
  };
  expect(persistentFor({ storage, cacheScope: 'u1' })).toBe(true);
  expect(persistentFor({ storage })).toBe(false);
  expect(persistentFor({ cacheScope: 'u1' })).toBe(false);
  expect(persistentFor({ storage, cacheScope: 'u1', offline: { enabled: false } })).toBe(false);
});

test('a 401 through the provider client purges the cache and calls onAuthLost', async () => {
  const storage = createMemoryAdapterForTests();
  const m = mockFetch([{ status: 401 }]);
  const onAuthLost = jest.fn();
  let v!: ReturnType<typeof useShelf>;
  render(
    <ShelfProvider baseUrl="https://a.test" storage={storage} cacheScope="u1" fetch={m.fetch} onAuthLost={onAuthLost}>
      <Probe onValue={(x) => (v = x)} />
    </ShelfProvider>,
  );
  await v.cache.setEntry('k', 1);
  expect(await storage.list()).toHaveLength(1);
  await v.client.info().catch(() => undefined);
  await waitFor(async () => expect(await storage.list()).toEqual([]));
  expect(onAuthLost).toHaveBeenCalledTimes(1);
});

test('on 401 the read cache is purged but the persisted upload queue is kept (only sign-out clears it)', async () => {
  const storage = createMemoryAdapterForTests();
  const m = mockFetch([{ status: 401 }]);
  const onAuthLost = jest.fn();
  let v!: ReturnType<typeof useShelf>;
  render(
    <ShelfProvider baseUrl="https://a.test" storage={storage} cacheScope="u1" fetch={m.fetch} onAuthLost={onAuthLost}>
      <Probe onValue={(x) => (v = x)} />
    </ShelfProvider>,
  );
  await v.cache.setEntry('k', 1);
  const ob = createOutbox({ client: v.client, storage, scope: 'u1', connectivity: false });
  await ob.enqueue({ uri: 'file:///tmp/a.pdf', name: 'a.pdf', type: 'application/pdf' });
  await waitFor(() => expect(ob.getSnapshot().pauseReason).toBe('auth'));
  await waitFor(async () => expect((await storage.list()).filter((k) => k.startsWith('shelf:v1:'))).toEqual([])); // cache purged
  expect((await storage.list()).filter((k) => k.startsWith('shelf:outbox:v1:') && !k.endsWith('~pause'))).toHaveLength(1); // queue kept
  expect(ob.getSnapshot().items.map((i) => i.state)).toEqual(['pending']);
  expect(onAuthLost).toHaveBeenCalledTimes(1);
  ob.destroy();
});

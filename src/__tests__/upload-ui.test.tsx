import React from 'react';
import { Text } from 'react-native';
import { act, render, screen, waitFor } from '@testing-library/react-native';
import { OfflineBanner, UploadStatusBadge, createOutbox, useOnlineStatus, useUpload } from '../upload';
import type { ConnectivitySource, UseUploadResult } from '../upload';
import { useOutbox as useOutboxFromHooks, useOnlineStatus as useOnlineFromHooks } from '../hooks';
import { ShelfProvider } from '../provider';
import { createShelfClient } from '../core';
import { createMemoryAdapter } from '../storage';
import { darkTheme } from '../theme';
import { item as apiItem, mockFetch } from './helpers';

beforeAll(() => {
  jest.spyOn(console, 'warn').mockImplementation(() => undefined); // the missing-netinfo dev warning
});

test('UploadStatusBadge snapshots', () => {
  const states = [
    { state: 'pending' as const },
    { item: { state: 'pending' as const, progress: 0, attempts: 2 } },
    { item: { state: 'uploading' as const, progress: 0.42, attempts: 0 } },
    { state: 'done' as const },
    { state: 'failed' as const },
  ];
  const tree = render(
    <>
      {states.map((p, i) => (
        <UploadStatusBadge key={i} {...p} />
      ))}
      <UploadStatusBadge state="failed" theme={darkTheme} />
    </>,
  );
  expect(tree.toJSON()).toMatchSnapshot();
});

test('UploadStatusBadge shows the pause reason on unsent items only', () => {
  const tree = render(
    <>
      <UploadStatusBadge state="pending" paused="auth" />
      <UploadStatusBadge state="pending" paused="not_configured" />
      <UploadStatusBadge state="pending" paused="manual" />
      <UploadStatusBadge state="done" paused="auth" />
    </>,
  );
  expect(tree.toJSON()).toMatchSnapshot();
});

test('useUpload exposes the pause reason while a 401 keeps the queue', async () => {
  const m = mockFetch([{ status: 401 }]);
  let u!: UseUploadResult;
  const store = createMemoryAdapter();
  const P = () => {
    u = useUpload({ baseUrl: 'https://x.test', getHeaders: () => ({ Authorization: 'Bearer t' }), fetch: m.fetch, connectivity: false, storage: store, cacheScope: 'u-pause' });
    return <Text>{u.pauseReason ?? 'none'}</Text>;
  };
  render(<P />);
  await act(async () => {
    await u.enqueue({ uri: 'file:///tmp/a.pdf', name: 'a.pdf', type: 'application/pdf' });
  });
  await waitFor(() => expect(u.pauseReason).toBe('auth'));
  expect([u.paused, u.all.length, u.all[0]!.state]).toEqual([true, 1, 'pending']);
  act(() => u.resume());
});

test('OfflineBanner snapshots and visibility', () => {
  const offline = render(<OfflineBanner online={false} pendingCount={3} />);
  expect(offline.toJSON()).toMatchSnapshot('offline with pending');
  offline.unmount();
  const paused = render(<OfflineBanner online pauseReason="auth" theme={darkTheme} />);
  expect(paused.toJSON()).toMatchSnapshot('paused auth');
  paused.unmount();
  const noKey = render(<OfflineBanner online pauseReason="not_configured" pendingCount={2} />);
  expect(noKey.toJSON()).toMatchSnapshot('paused not_configured');
  noKey.unmount();
  const signIn = render(<OfflineBanner online pauseReason="auth" pendingCount={1} />);
  expect(signIn.toJSON()).toMatchSnapshot('paused auth with kept uploads');
  signIn.unmount();
  const hidden = render(<OfflineBanner online />);
  expect(hidden.toJSON()).toBeNull();
});

test('useOnlineStatus follows the connectivity source; without netinfo it is always online and untracked', () => {
  let emit!: (o: boolean) => void;
  const source: ConnectivitySource = { tracked: true, subscribe: (l) => ((emit = l), () => undefined) };
  let v!: ReturnType<typeof useOnlineStatus>;
  const P = ({ s }: { s?: ConnectivitySource }) => {
    v = useOnlineStatus(s);
    return <Text>{String(v.online)}</Text>;
  };
  render(<P s={source} />);
  act(() => emit(false));
  expect(v).toEqual({ online: false, tracked: true });
  render(<P />); // @react-native-community/netinfo is not installed in this repo's tests
  expect(v).toEqual({ online: true, tracked: false });
});

test('hooks entry exposes useOutbox and useOnlineStatus', () => {
  expect(useOutboxFromHooks).toBeDefined();
  expect(useOnlineFromHooks).toBe(useOnlineStatus);
});

test('useUpload works with no provider (baseUrl + getHeaders) and with ShelfProvider; the queue persists on the provider storage', async () => {
  const m = mockFetch(() => ({ status: 201, body: apiItem('a') }));
  let u!: UseUploadResult;
  const P = () => {
    u = useUpload({ baseUrl: 'https://x.test', getHeaders: () => ({ Authorization: 'Bearer t' }), fetch: m.fetch, connectivity: false });
    return <Text>{u.items.map((i) => i.state).join(',')}</Text>;
  };
  render(<P />);
  await act(async () => {
    await u.enqueue({ uri: 'file:///a.pdf', name: 'a.pdf', type: 'application/pdf' });
  });
  await waitFor(() => expect(u.items[0]?.state).toBe('done'));
  expect(m.calls[0]!.init.headers.Authorization).toBe('Bearer t');

  const storage = createMemoryAdapter();
  const hang = (() => new Promise(() => undefined)) as unknown as typeof fetch; // stays in flight: no backoff timer left running
  const client = createShelfClient({ baseUrl: 'https://y.test', fetch: hang });
  const Q = () => {
    u = useUpload({ connectivity: false });
    return null;
  };
  render(
    <ShelfProvider client={client} storage={storage} cacheScope="user-1">
      <Q />
    </ShelfProvider>,
  );
  await act(async () => {
    await u.enqueue({ uri: 'file:///b.pdf', name: 'b.pdf', type: 'application/pdf' });
  });
  expect((await storage.list()).some((k) => k.startsWith('shelf:outbox:v1:'))).toBe(true);
  // headless API shares the same shape
  const headless = createOutbox({ client, storage, scope: 'user-1', connectivity: false });
  await headless.ready;
  expect(headless.getSnapshot().items).toHaveLength(1);
  headless.destroy();
});

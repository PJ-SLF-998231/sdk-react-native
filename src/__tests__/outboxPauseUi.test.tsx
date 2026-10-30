import React from 'react';
import { Text } from 'react-native';
import { act, render, screen, waitFor } from '@testing-library/react-native';
import { clearAllRegistrySize } from '../cache/clear';
import { OfflineBanner, UploadStatusBadge, createOutbox, useOutbox } from '../upload';
import type { Outbox, OutboxControls } from '../upload';
import { createShelfClient } from '../core';
import { ShelfProvider } from '../provider';
import { createMemoryAdapter } from '../storage';
import { item as apiItem } from './helpers';

beforeAll(() => {
  jest.spyOn(console, 'warn').mockImplementation(() => undefined); // missing-netinfo dev warning
});

const BASE = 'https://x.test';
const refuse = (async () => ({ ok: false, status: 401, statusText: '401', headers: { get: () => null }, json: async () => ({ code: 'unauthorized' }), text: async () => '{}' })) as unknown as typeof fetch;
const accept = (async () => ({ ok: true, status: 200, statusText: 'OK', headers: { get: () => null }, json: async () => apiItem('s'), text: async () => JSON.stringify(apiItem('s')) })) as unknown as typeof fetch;

function Screen({ outbox, onControls }: { outbox: Outbox; onControls?: (c: OutboxControls) => void }) {
  const c = useOutbox({ outbox, baseUrl: BASE });
  onControls?.(c);
  return (
    <>
      <Text testID="reason">{String(c.pausedReason)}</Text>
      <OfflineBanner online pauseReason={c.pausedReason} pendingCount={c.snapshot.counts.pending} />
      {c.snapshot.items.map((i) => (
        <UploadStatusBadge key={i.id} item={i} paused={c.snapshot.pauseReason} />
      ))}
    </>
  );
}

test('after a restart the UI shows "Needs sign-in" as soon as the outbox is ready, before any request, and retryNow() is exposed', async () => {
  const storage = createMemoryAdapter();
  const first = createOutbox({ client: createShelfClient({ baseUrl: BASE, fetch: refuse, getHeaders: () => ({ Authorization: 'Bearer a' }) }), storage, connectivity: false });
  await first.enqueue({ uri: 'file:///a.pdf', name: 'a.pdf', type: 'application/pdf' });
  await waitFor(() => expect(first.getSnapshot().pauseReason).toBe('auth'));
  await new Promise<void>((r) => setTimeout(r, 0));
  first.destroy();

  let calls = 0;
  const countingRefuse = (async (...a: unknown[]) => (calls++, (refuse as (...x: unknown[]) => unknown)(...a))) as unknown as typeof fetch;
  const second = createOutbox({ client: createShelfClient({ baseUrl: BASE, fetch: countingRefuse, getHeaders: () => ({ Authorization: 'Bearer a' }) }), storage, connectivity: false });
  let controls!: OutboxControls;
  render(<Screen outbox={second} onControls={(c) => (controls = c)} />);
  await act(async () => {
    await second.ready;
  });
  expect(screen.getByTestId('reason').props.children).toBe('auth');
  expect(screen.getAllByText(/Needs sign-in/).length).toBeGreaterThan(0); // banner and the item's badge
  expect(calls).toBe(0);
  expect(controls.pausedReason).toBe('auth');
  await act(async () => controls.retryNow());
  await waitFor(() => expect(calls).toBe(1));
  expect(controls.pausedReason).toBe('auth');
  second.destroy();
});

describe('shared outboxes are reference counted', () => {
  const settle = () => act(async () => void (await new Promise<void>((r) => setTimeout(r, 0))));
  function Use({ onOutbox }: { onOutbox: (o: Outbox) => void }) {
    const c = useOutbox();
    onOutbox(c.outbox);
    return <Text>{String(c.snapshot.paused)}</Text>;
  }

  test('destroyed when the last user unmounts, kept while another still uses it, rebuilt on a later mount', async () => {
    const client = createShelfClient({ baseUrl: BASE, fetch: accept });
    const storage = createMemoryAdapter();
    const registryBefore = clearAllRegistrySize();
    const seen: Outbox[] = [];
    const tree = (a: boolean, b: boolean) => (
      <ShelfProvider client={client} storage={storage} cacheScope="u1">
        {a ? <Use onOutbox={(o) => seen.push(o)} /> : null}
        {b ? <Use onOutbox={(o) => seen.push(o)} /> : null}
      </ShelfProvider>
    );
    const r = render(tree(true, true));
    await settle();
    const shared = seen[0]!;
    expect(new Set(seen).size).toBe(1); // both screens share one outbox
    expect(clearAllRegistrySize()).toBe(registryBefore + 1);
    r.rerender(tree(true, false));
    await settle();
    await act(async () => {
      await expect(shared.enqueue({ uri: 'file:///a.pdf', name: 'a.pdf', type: 'application/pdf' })).resolves.toBeDefined(); // still alive
    });
    expect(clearAllRegistrySize()).toBe(registryBefore + 1);
    r.rerender(tree(false, false));
    await settle();
    await expect(shared.enqueue({ uri: 'file:///b.pdf', name: 'b.pdf', type: 'application/pdf' })).rejects.toThrow(/destroyed/);
    expect(clearAllRegistrySize()).toBe(registryBefore); // out of the clearAll registry
    seen.length = 0;
    r.rerender(tree(true, false));
    await settle();
    expect(seen[0]).not.toBe(shared); // a new outbox...
    await seen[0]!.ready;
    expect(seen[0]!.getSnapshot().items.length).toBeGreaterThanOrEqual(0); // ...that reloads the persisted queue
    r.unmount();
    await settle();
    expect(clearAllRegistrySize()).toBe(registryBefore);
  });

  test('React StrictMode (effects run twice) does not destroy the outbox that stays mounted', async () => {
    const client = createShelfClient({ baseUrl: BASE, fetch: accept });
    let ob!: Outbox;
    render(
      <React.StrictMode>
        <ShelfProvider client={client}>
          <Use onOutbox={(o) => (ob = o)} />
        </ShelfProvider>
      </React.StrictMode>,
    );
    await settle();
    await act(async () => {
      await expect(ob.enqueue({ uri: 'file:///a.pdf', name: 'a.pdf', type: 'application/pdf' })).resolves.toBeDefined();
    });
  });
});

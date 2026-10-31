import React from 'react';
import { Text } from 'react-native';
import { act, render, waitFor } from '@testing-library/react-native';
import { useResource } from '../hooks/resource';
import type { ResourceInternals } from '../hooks/resource';
import type { ShelfClient } from '../core/client';
import { mockFetch } from './helpers';

// useResource is the plumbing under every data hook: connection resolution, the SWR handle per key, and the state mapping.
const BASE = 'https://api.test';

function probe<T>(initialKey: string | null, fetcher: (c: ShelfClient, s: AbortSignal, prev: T | undefined) => Promise<T>) {
  const out: { current: ResourceInternals<T> } = { current: undefined as unknown as ResourceInternals<T> };
  const f = mockFetch([]);
  const P = ({ k }: { k: string | null }) => {
    out.current = useResource<T>({ baseUrl: BASE, getHeaders: () => ({}), fetch: f.fetch }, k, fetcher);
    return <Text>x</Text>;
  };
  const view = render(<P k={initialKey} />);
  return { out, rerender: (k: string | null) => view.rerender(<P k={k} />) };
}

describe('useResource', () => {
  test('a null key is idle: no fetch, not loading, refresh resolves', async () => {
    const fetcher = jest.fn(async () => 1);
    const { out } = probe<number>(null, fetcher);
    expect(out.current.handle).toBeNull();
    expect(out.current.state).toMatchObject({ data: undefined, loading: false, refreshing: false, error: undefined, offline: false, fromCache: false, updatedAt: null });
    await expect(out.current.state.refresh()).resolves.toBeUndefined();
    expect(fetcher).not.toHaveBeenCalled();
  });

  test('loads through the resolved client, then refresh fetches again with the previous value', async () => {
    let n = 0;
    const fetcher = jest.fn(async (_c: ShelfClient, _s: AbortSignal, _prev: number | undefined) => ++n);
    const { out } = probe<number>('k1', fetcher);
    expect(out.current.state.loading).toBe(true);
    await waitFor(() => expect(out.current.state.data).toBe(1));
    expect(out.current.state.loading).toBe(false);
    expect(out.current.state.updatedAt).toEqual(expect.any(Number));
    const [client, signal] = fetcher.mock.calls[0]!;
    expect(client).toBe(out.current.client);
    expect(client.baseUrl).toBe(BASE);
    expect(signal).toBeInstanceOf(AbortSignal);
    await act(() => out.current.state.refresh());
    await waitFor(() => expect(out.current.state.data).toBe(2));
    expect(fetcher.mock.calls[1]![2]).toBe(1);
  });

  test('an error with nothing to show is not loading; the next success clears it', async () => {
    const boom = new Error('boom');
    let fail = true;
    const fetcher = jest.fn(async () => {
      if (fail) throw boom;
      return 'ok';
    });
    const { out } = probe<string>('k-err', fetcher);
    await waitFor(() => expect(out.current.state.error).toBe(boom));
    expect(out.current.state.loading).toBe(false);
    expect(out.current.state.data).toBeUndefined();
    fail = false;
    await act(() => out.current.state.refresh());
    await waitFor(() => expect(out.current.state.data).toBe('ok'));
    expect(out.current.state.error).toBeUndefined();
  });

  test('a new key gets its own handle and data; back to null goes idle', async () => {
    let calls = 0;
    const fetcher = jest.fn(async (_c: ShelfClient, _s: AbortSignal) => `v${++calls}`);
    const { out, rerender } = probe<string>('a', fetcher);
    await waitFor(() => expect(out.current.state.data).toBe('v1'));
    const first = out.current.handle;
    rerender('b');
    await waitFor(() => expect(out.current.state.data).toBe('v2'));
    expect(out.current.handle).not.toBe(first);
    rerender(null);
    expect(out.current.handle).toBeNull();
    expect(out.current.state.data).toBeUndefined();
    expect(out.current.state.loading).toBe(false);
  });
});

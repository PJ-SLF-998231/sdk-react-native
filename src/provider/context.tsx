import React, { createContext, useContext, useEffect, useMemo, useRef } from 'react';
import { useColorScheme } from 'react-native';
import { createCache, disposeCache } from '../cache/cache';
import { createSwr } from '../cache/swr';
import type { CacheStore, Swr } from '../cache/types';
import { createShelfClient } from '../core/client';
import type { ShelfClient } from '../core/client';
import type { StorageAdapter } from '../core/storage-adapter';
import type { GetHeaders, ShelfErrorLike } from '../core/types';
import { resolveTheme, createTheme } from '../theme/tokens';
import type { ShelfTheme, ThemeMode, ThemeOverrides } from '../theme/tokens';

export interface OfflineSettings {
  /** Keep and show cached data (stale-while-revalidate). Default true. False: nothing is persisted or served from the cache. */
  enabled?: boolean;
  /** Fresh window in ms before a revalidateAll() refetches. Default 30_000. */
  staleMs?: number;
}

/** What entries take to find their client when there is no provider: a client, or baseUrl + getHeaders. */
export interface ShelfConnectionProps {
  client?: ShelfClient;
  baseUrl?: string;
  getHeaders?: GetHeaders;
  fetch?: typeof fetch;
  onAuthLost?: (error: ShelfErrorLike) => void;
  /** Per-user cache isolation key. Without it (or without `storage`) the cache is memory-only. */
  cacheScope?: string;
  storage?: StorageAdapter;
  offline?: OfflineSettings;
  theme?: ThemeMode | ShelfTheme;
  themeOverrides?: ThemeOverrides;
}

export interface ShelfContextValue {
  client: ShelfClient;
  cache: CacheStore;
  swr: Swr;
  theme: ShelfTheme;
  offline: Required<OfflineSettings>;
  /** The host's storage adapter and cache scope, as given; the upload outbox persists its queue on them. */
  storage?: StorageAdapter;
  scope?: string;
}

const Ctx = createContext<ShelfContextValue | null>(null);

function isTheme(t: ThemeMode | ShelfTheme | undefined): t is ShelfTheme {
  return typeof t === 'object' && t !== null;
}

/** Builds client + cache + swr + theme from connection props. Stable while baseUrl/client/scope/storage stay the same. */
function useBuild(props: ShelfConnectionProps, active: boolean): ShelfContextValue | null {
  const headersRef = useRef(props.getHeaders);
  headersRef.current = props.getHeaders;
  const authRef = useRef(props.onAuthLost);
  authRef.current = props.onAuthLost;
  const scheme = useColorScheme();

  const offlineEnabled = props.offline?.enabled !== false;
  const staleMs = props.offline?.staleMs ?? 30_000;
  const { client: given, baseUrl, fetch: fetchImpl, cacheScope, storage } = props;

  const core = useMemo(() => {
    if (!active) return null;
    if (!given && !baseUrl) {
      throw new Error('Shelf: pass a `client`, or `baseUrl` (with `getHeaders`), or render inside <ShelfProvider>.');
    }
    const cache = createCache({
      storage: offlineEnabled ? storage : undefined,
      baseUrl: given?.baseUrl ?? (baseUrl as string),
      cacheScope: offlineEnabled ? cacheScope : undefined,
    });
    const swr = createSwr(cache, { onAuthLost: () => undefined });
    const client =
      given ??
      createShelfClient({
        baseUrl: baseUrl as string,
        getHeaders: () => (headersRef.current ? headersRef.current() : {}),
        fetch: fetchImpl,
        onAuthLost: (e) => {
          void swr.purge();
          authRef.current?.(e);
        },
      });
    return { client, cache, swr };
  }, [active, given, baseUrl, fetchImpl, cacheScope, storage, offlineEnabled]);

  useEffect(
    () => () => {
      if (!core) return;
      core.swr.destroy();
      disposeCache(core.cache);
    },
    [core],
  );

  const theme = useMemo(() => {
    const base = isTheme(props.theme) ? props.theme : resolveTheme(props.theme, scheme === 'dark' ? 'dark' : 'light');
    return props.themeOverrides ? createTheme(props.themeOverrides, base) : base;
  }, [props.theme, props.themeOverrides, scheme]);

  return useMemo(() => (core ? { ...core, theme, offline: { enabled: offlineEnabled, staleMs }, storage, scope: cacheScope } : null), [core, theme, offlineEnabled, staleMs, storage, cacheScope]);
}

export function ShelfProvider(props: ShelfConnectionProps & { children?: React.ReactNode }): React.ReactElement {
  const value = useBuild(props, true);
  return <Ctx.Provider value={value}>{props.children}</Ctx.Provider>;
}

/** The nearest provider's value, or null when there is none. */
export function useShelfContext(): ShelfContextValue | null {
  return useContext(Ctx);
}

/**
 * Resolver for entries (screens/components). Order: explicit `client` or `baseUrl` props win, then the nearest
 * <ShelfProvider>. With neither it throws a clear error. This is what lets every entry work with no provider:
 *
 *   <ShelfFolders client={client} />                         // a ready client
 *   <ShelfFolders baseUrl="..." getHeaders={getHeaders} />   // built for you (memory-only cache unless storage+cacheScope)
 */
export function useShelf(props: ShelfConnectionProps = {}): ShelfContextValue {
  const ctx = useContext(Ctx);
  const explicit = Boolean(props.client || props.baseUrl);
  const built = useBuild(props, explicit || !ctx);
  const value = explicit ? built : (ctx ?? built);
  if (!value) throw new Error('Shelf: no client. Pass `client`, or `baseUrl` and `getHeaders`, or render inside <ShelfProvider>.');
  return value;
}

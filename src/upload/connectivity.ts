import { MissingPeerError } from '../core/peer';

// Metro resolves this literal `require` at bundle time; see scripts/fix-optional-requires.mjs.
declare const require: (id: string) => any;

/** Tells the outbox whether the device can reach the network. */
export interface ConnectivitySource {
  /** Calls `listener` with the current state (soon after subscribing) and on every change. Returns the unsubscribe. */
  subscribe(listener: (online: boolean) => void): () => void;
  /** False when nothing is being tracked (the optional netinfo peer is missing): the source then never reports offline. */
  readonly tracked: boolean;
}

/** The subset of @react-native-community/netinfo this module uses. */
export interface NetInfoLike {
  addEventListener(listener: (state: { isConnected: boolean | null; isInternetReachable?: boolean | null }) => void): () => void;
}

export function netInfoIsOnline(state: { isConnected: boolean | null; isInternetReachable?: boolean | null }): boolean {
  // `null` means "not known yet"; only an explicit false counts as offline.
  return state.isConnected !== false && state.isInternetReachable !== false;
}

/** Always online, tracks nothing. The fallback when netinfo is not installed. */
export const alwaysOnline: ConnectivitySource = { tracked: false, subscribe: () => () => undefined };

export function createNetInfoConnectivity(module: NetInfoLike): ConnectivitySource {
  return {
    tracked: true,
    subscribe(listener) {
      return module.addEventListener((s) => listener(netInfoIsOnline(s)));
    },
  };
}

let shared: ConnectivitySource | undefined;

/**
 * The netinfo-backed source, loading `@react-native-community/netinfo` lazily. Without that optional peer it falls
 * back to {@link alwaysOnline} (uploads are then only retried by backoff timers, not on reconnect), and logs once in
 * development. Pass `{ module }` to skip the lazy require, or `{ strict: true }` to throw a MissingPeerError instead.
 */
export function getDefaultConnectivity(options: { module?: NetInfoLike; strict?: boolean } = {}): ConnectivitySource {
  if (options.module) return createNetInfoConnectivity(options.module);
  if (shared) return shared;
  try {
    const mod = require('@react-native-community/netinfo');
    shared = createNetInfoConnectivity((mod.default ?? mod) as NetInfoLike);
  } catch {
    if (options.strict) throw new MissingPeerError('@react-native-community/netinfo', 'online/offline detection');
    if (typeof __DEV__ !== 'undefined' && __DEV__) {
      console.warn('@pj-slf-998231/sdk-react-native: @react-native-community/netinfo is not installed; the outbox assumes the device is always online and will not retry on reconnect.');
    }
    shared = alwaysOnline;
  }
  return shared;
}

/** Test hook: forget the cached default source. */
export function resetDefaultConnectivity(): void {
  shared = undefined;
}

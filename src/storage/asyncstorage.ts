import { MissingPeerError } from '../core/peer';
import type { StorageAdapter } from '../core/storage-adapter';

// Metro resolves this literal `require` at bundle time; see scripts/fix-optional-requires.mjs.
declare const require: (id: string) => any;

/** The subset of @react-native-async-storage/async-storage this adapter uses. */
export interface AsyncStorageLike {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
  getAllKeys(): Promise<readonly string[]>;
  multiRemove?(keys: readonly string[]): Promise<void>;
}

export interface AsyncStorageAdapterOptions {
  /** Pass the module yourself (`import AsyncStorage from '@react-native-async-storage/async-storage'`) to skip the lazy require. */
  module?: AsyncStorageLike;
}

function load(): AsyncStorageLike {
  let mod: { default?: AsyncStorageLike } & Partial<AsyncStorageLike>;
  try {
    // Lazy: the peer is only required when an adapter is created, and only from this subpath.
    mod = require('@react-native-async-storage/async-storage');
  } catch {
    throw new MissingPeerError('@react-native-async-storage/async-storage', 'the asyncstorage storage adapter');
  }
  return (mod.default ?? mod) as AsyncStorageLike;
}

export function createAsyncStorageAdapter(options: AsyncStorageAdapterOptions = {}): StorageAdapter {
  const storage = options.module ?? load();
  return {
    get: (key) => storage.getItem(key),
    set: (key, value) => storage.setItem(key, value),
    delete: (key) => storage.removeItem(key),
    async list(prefix = '') {
      const keys = await storage.getAllKeys();
      return keys.filter((k) => k.startsWith(prefix));
    },
  };
}

import type { StorageAdapter } from '../core/storage-adapter';

/** Non-persistent adapter: the default for tests and for hosts that want no data kept on the device. */
export function createMemoryAdapter(): StorageAdapter {
  const map = new Map<string, string>();
  return {
    async get(key) {
      return map.has(key) ? (map.get(key) as string) : null;
    },
    async set(key, value) {
      map.set(key, value);
    },
    async delete(key) {
      map.delete(key);
    },
    async list(prefix = '') {
      return [...map.keys()].filter((k) => k.startsWith(prefix));
    },
  };
}

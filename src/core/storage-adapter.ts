/**
 * Async string key/value storage the cache sits on. Values are strings (the cache serialises to JSON).
 * Implementations must be safe to call concurrently.
 */
export interface StorageAdapter {
  /** Resolves null when the key is absent. */
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  /** Deleting an absent key is not an error. */
  delete(key: string): Promise<void>;
  /** Keys starting with `prefix` (all keys when omitted), in no particular order. */
  list(prefix?: string): Promise<string[]>;
}


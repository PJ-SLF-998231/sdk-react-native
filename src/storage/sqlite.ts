import { MissingPeerError } from '../core/peer';
import type { StorageAdapter } from '../core/storage-adapter';

// Metro resolves this literal `require` at bundle time; see scripts/fix-optional-requires.mjs.
declare const require: (id: string) => any;

/** The subset of an expo-sqlite (SDK 51+) async database this adapter uses. */
export interface SqliteDatabaseLike {
  execAsync(sql: string): Promise<void>;
  runAsync(sql: string, ...params: unknown[]): Promise<unknown>;
  getFirstAsync<T>(sql: string, ...params: unknown[]): Promise<T | null>;
  getAllAsync<T>(sql: string, ...params: unknown[]): Promise<T[]>;
}

export interface SqliteAdapterOptions {
  /** Database file name. Default `shelf-sdk.db`. */
  name?: string;
  /** Table name. Default `shelf_kv`. Letters, digits and underscore only. */
  table?: string;
  /** An already-open database (skips the lazy require of expo-sqlite). */
  database?: SqliteDatabaseLike;
}

function open(name: string): Promise<SqliteDatabaseLike> {
  let mod: { openDatabaseAsync(name: string): Promise<SqliteDatabaseLike> };
  try {
    // Lazy: the peer is only required when an adapter is created, and only from this subpath.
    mod = require('expo-sqlite');
  } catch {
    throw new MissingPeerError('expo-sqlite', 'the sqlite storage adapter');
  }
  return mod.openDatabaseAsync(name);
}

export function createSqliteAdapter(options: SqliteAdapterOptions = {}): StorageAdapter {
  const table = options.table ?? 'shelf_kv';
  if (!/^[A-Za-z0-9_]+$/.test(table)) throw new Error(`invalid table name "${table}"`);
  let ready: Promise<SqliteDatabaseLike> | null = null;

  function db(): Promise<SqliteDatabaseLike> {
    if (!ready) {
      ready = (async () => {
        const d = options.database ?? (await open(options.name ?? 'shelf-sdk.db'));
        await d.execAsync(`CREATE TABLE IF NOT EXISTS ${table} (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)`);
        return d;
      })();
      ready.catch(() => {
        ready = null; // let a later call retry
      });
    }
    return ready;
  }

  return {
    async get(key) {
      const row = await (await db()).getFirstAsync<{ value: string }>(`SELECT value FROM ${table} WHERE key = ?`, key);
      return row ? row.value : null;
    },
    async set(key, value) {
      await (await db()).runAsync(`INSERT OR REPLACE INTO ${table} (key, value) VALUES (?, ?)`, key, value);
    },
    async delete(key) {
      await (await db()).runAsync(`DELETE FROM ${table} WHERE key = ?`, key);
    },
    async list(prefix = '') {
      const rows = await (await db()).getAllAsync<{ key: string }>(
        `SELECT key FROM ${table} WHERE substr(key, 1, ?) = ?`,
        prefix.length,
        prefix,
      );
      return rows.map((r) => r.key);
    },
  };
}

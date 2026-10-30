import { createMemoryAdapter } from '../storage';
import { createAsyncStorageAdapter } from '../storage/asyncstorage';
import { createSqliteAdapter } from '../storage/sqlite';
import type { SqliteDatabaseLike } from '../storage/sqlite';
import { MissingPeerError } from '../core/peer';
import type { StorageAdapter } from '../core/storage-adapter';

/** Same in-memory behaviour as AsyncStorage's API. */
function fakeAsyncStorage() {
  const m = new Map<string, string>();
  return {
    getItem: async (k: string) => (m.has(k) ? (m.get(k) as string) : null),
    setItem: async (k: string, v: string) => void m.set(k, v),
    removeItem: async (k: string) => void m.delete(k),
    getAllKeys: async () => [...m.keys()],
  };
}

/** Interprets exactly the statements the adapter issues. It is a fake: real SQL is exercised on device. */
function fakeSqlite(): SqliteDatabaseLike & { statements: string[] } {
  const rows = new Map<string, string>();
  const statements: string[] = [];
  return {
    statements,
    async execAsync(sql) {
      statements.push(sql);
    },
    async runAsync(sql, ...p) {
      statements.push(sql);
      if (sql.startsWith('INSERT OR REPLACE')) rows.set(p[0] as string, p[1] as string);
      else if (sql.startsWith('DELETE')) rows.delete(p[0] as string);
      else throw new Error('unexpected ' + sql);
    },
    async getFirstAsync<T>(sql: string, ...p: unknown[]) {
      statements.push(sql);
      return (rows.has(p[0] as string) ? { value: rows.get(p[0] as string) } : null) as T | null;
    },
    async getAllAsync<T>(sql: string, ...p: unknown[]) {
      statements.push(sql);
      const [len, prefix] = p as [number, string];
      return [...rows.keys()].filter((k) => k.slice(0, len) === prefix).map((key) => ({ key })) as T[];
    },
  };
}

const adapters: [string, () => StorageAdapter][] = [
  ['memory', () => createMemoryAdapter()],
  ['asyncstorage', () => createAsyncStorageAdapter({ module: fakeAsyncStorage() })],
  ['sqlite', () => createSqliteAdapter({ database: fakeSqlite() })],
];

describe.each(adapters)('%s adapter contract', (_name, make) => {
  test('get/set/delete round-trip, overwrite, and absent keys', async () => {
    const a = make();
    expect(await a.get('k')).toBeNull();
    await a.set('k', 'v1');
    await a.set('k', 'v2');
    expect(await a.get('k')).toBe('v2');
    await a.delete('k');
    expect(await a.get('k')).toBeNull();
    await expect(a.delete('missing')).resolves.toBeUndefined();
  });

  test('list filters by prefix', async () => {
    const a = make();
    await Promise.all([a.set('a:1', 'x'), a.set('a:2', 'x'), a.set('b:1', 'x')]);
    expect((await a.list('a:')).sort()).toEqual(['a:1', 'a:2']);
    expect((await a.list()).sort()).toEqual(['a:1', 'a:2', 'b:1']);
    expect(await a.list('zzz')).toEqual([]);
  });

  test('stores unicode and large values untouched', async () => {
    const a = make();
    const v = 'é漢字🙂'.repeat(50_000);
    await a.set('big', v);
    expect(await a.get('big')).toBe(v);
  });
});

test('sqlite creates its table once and retries after an open failure', async () => {
  const db = fakeSqlite();
  const a = createSqliteAdapter({ database: db, table: 'kv_x' });
  await Promise.all([a.get('1'), a.get('2'), a.set('3', 'x')]);
  expect(db.statements.filter((s) => s.startsWith('CREATE TABLE IF NOT EXISTS kv_x'))).toHaveLength(1);
  expect(() => createSqliteAdapter({ table: 'x; DROP' })).toThrow(/invalid table/);
  let n = 0;
  const flaky: SqliteDatabaseLike = { ...fakeSqlite(), execAsync: async () => { if (n++ === 0) throw new Error('locked'); } };
  const b = createSqliteAdapter({ database: flaky });
  await expect(b.get('k')).rejects.toThrow('locked');
  await expect(b.get('k')).resolves.toBeNull();
});

test('asyncstorage and sqlite without their peers fail with a clear MissingPeerError, only when created/used', async () => {
  expect(() => createAsyncStorageAdapter()).toThrow(MissingPeerError);
  expect(() => createAsyncStorageAdapter()).toThrow(/@react-native-async-storage\/async-storage/);
  const a = createSqliteAdapter(); // nothing is required until first use
  const err = await a.get('k').catch((e) => e);
  expect(err).toBeInstanceOf(MissingPeerError);
  expect(err.peer).toBe('expo-sqlite');
  expect(err.message).toMatch(/expo install expo-sqlite/);
});

test('the lazy require loads the peer when it is installed (module default export)', async () => {
  let a!: StorageAdapter;
  jest.isolateModules(() => {
    jest.doMock('@react-native-async-storage/async-storage', () => ({ __esModule: true, default: fakeAsyncStorage() }), { virtual: true });
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    a = require('../storage/asyncstorage').createAsyncStorageAdapter();
  });
  await a.set('k', 'v');
  expect(await a.get('k')).toBe('v');
});

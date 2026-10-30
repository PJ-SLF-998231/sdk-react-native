import type { AuthedSource, PreviewSize } from '../core/types';
import { loadFileSystem } from './peers';
import type { FileSystemLike } from './peers';

/** Where a thumbnail can be read from: a local file, or (memory fallback) the authenticated remote URL. */
export interface ThumbSource {
  uri: string;
  headers?: Record<string, string>;
}

/**
 * Where thumbnails live between sessions. Implement it to use your own store (an image library's cache, a DB, ...).
 * Keys are opaque and already include the document id, size and revision, so a changed document is a new key.
 */
export interface ThumbnailCache {
  /** The cached thumbnail, marking it recently used; null on a miss. */
  get(key: string): Promise<ThumbSource | null>;
  /** Fetches `source` (URL + auth headers), stores it and returns where to read it from. Rejects when the fetch fails. */
  put(key: string, source: AuthedSource): Promise<ThumbSource>;
  /** Empties the cache (call on sign-out). */
  clear(): Promise<void>;
}

/** Long edge in pixels of each rendition (api/internal/thumbnails: small 360x270 card, medium 800, large 2000). */
export const PREVIEW_SIZE_PX: Record<PreviewSize, number> = { small: 360, medium: 800, large: 2000 };
const ORDER: PreviewSize[] = ['small', 'medium', 'large'];

/**
 * The smallest available rendition whose long edge covers `neededPx`; the largest available one when none does;
 * null when the document has no preview. `neededPx` is dp times the screen's pixel ratio.
 */
export function pickPreviewSize(available: readonly string[] | undefined | null, neededPx: number): PreviewSize | null {
  const have = ORDER.filter((s) => available?.includes(s));
  if (have.length === 0) return null;
  return have.find((s) => PREVIEW_SIZE_PX[s] >= neededPx) ?? (have[have.length - 1] as PreviewSize);
}

export function thumbnailKey(doc: { id: string; edited_at?: string | null; parsed_at?: string | null; created_at?: string }, size: string): string {
  return `${doc.id}.${size}.${doc.edited_at ?? doc.parsed_at ?? doc.created_at ?? ''}`;
}

export interface MemoryThumbnailCacheOptions {
  /** Entries kept. Default 300. */
  maxEntries?: number;
}

/**
 * The fallback when no file system is available. It does not store pixels: it remembers the authenticated source per
 * key (least recently used out), so React Native's own image cache does the byte caching for the session.
 */
export function createMemoryThumbnailCache(options: MemoryThumbnailCacheOptions = {}): ThumbnailCache {
  const max = options.maxEntries ?? 300;
  const map = new Map<string, ThumbSource>();
  return {
    async get(key) {
      const hit = map.get(key);
      if (!hit) return null;
      map.delete(key);
      map.set(key, hit);
      return hit;
    },
    async put(key, source) {
      const value: ThumbSource = { uri: source.uri, headers: source.headers };
      map.delete(key);
      map.set(key, value);
      while (map.size > max) map.delete(map.keys().next().value as string);
      return value;
    },
    async clear() {
      map.clear();
    },
  };
}

export interface FileThumbnailCacheOptions {
  /** Defaults to the lazily required `expo-file-system`. */
  fileSystem?: FileSystemLike;
  /** Directory URI (trailing slash optional). Default `<cacheDirectory>shelf-thumbnails/`. */
  directory?: string;
  /** Byte cap; least recently used files are deleted past it. Default 64 MB. */
  maxBytes?: number;
  /** Simultaneous downloads. Default 4. */
  concurrency?: number;
}

interface IndexEntry {
  file: string;
  size: number;
}

const INDEX_FILE = 'index.json';
const safeName = (key: string): string => `${key.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120)}.img`;

/**
 * On-disk thumbnails with an LRU byte cap. Files are downloaded natively with the auth headers straight to disk (no
 * bytes pass through JS); an index file keeps recency across restarts.
 */
export function createFileThumbnailCache(options: FileThumbnailCacheOptions = {}): ThumbnailCache {
  const fs = options.fileSystem ?? loadFileSystem();
  const maxBytes = options.maxBytes ?? 64 * 1024 * 1024;
  const concurrency = options.concurrency ?? 4;
  const base = options.directory ?? `${fs.cacheDirectory ?? ''}shelf-thumbnails/`;
  const dir = base.endsWith('/') ? base : `${base}/`;
  let index = new Map<string, IndexEntry>(); // insertion order = recency, oldest first
  const verified = new Set<string>();
  const inflight = new Map<string, Promise<ThumbSource>>();
  let ready: Promise<void> | null = null;
  let persistChain: Promise<void> = Promise.resolve();
  let running = 0;
  const waiting: Array<() => void> = [];

  const init = (): Promise<void> =>
    (ready ??= (async () => {
      try {
        await fs.makeDirectoryAsync(dir, { intermediates: true });
      } catch {
        /* exists */
      }
      try {
        const raw = JSON.parse(await fs.readAsStringAsync(dir + INDEX_FILE)) as Array<[string, IndexEntry]>;
        if (Array.isArray(raw)) index = new Map(raw.filter((e) => Array.isArray(e) && typeof e[1]?.file === 'string'));
      } catch {
        index = new Map(); // no index yet, or unreadable: start empty (orphan files are overwritten or evicted by clear)
      }
    })());

  const persist = (): void => {
    const snapshot = JSON.stringify([...index.entries()]);
    persistChain = persistChain.then(() => fs.writeAsStringAsync(dir + INDEX_FILE, snapshot)).catch(() => undefined);
  };

  async function slot<T>(run: () => Promise<T>): Promise<T> {
    if (running >= concurrency) await new Promise<void>((r) => waiting.push(r));
    running++;
    try {
      return await run();
    } finally {
      running--;
      waiting.shift()?.();
    }
  }

  async function evict(): Promise<void> {
    let total = 0;
    for (const e of index.values()) total += e.size;
    while (total > maxBytes && index.size > 1) {
      const oldest = index.entries().next().value as [string, IndexEntry];
      index.delete(oldest[0]);
      verified.delete(oldest[0]);
      total -= oldest[1].size;
      await fs.deleteAsync(dir + oldest[1].file, { idempotent: true }).catch(() => undefined);
    }
  }

  return {
    async get(key) {
      await init();
      const entry = index.get(key);
      if (!entry) return null;
      if (!verified.has(key)) {
        const info = await fs.getInfoAsync(dir + entry.file).catch(() => ({ exists: false }));
        if (!info.exists) {
          index.delete(key);
          persist();
          return null;
        }
        verified.add(key);
      }
      index.delete(key);
      index.set(key, entry);
      return { uri: dir + entry.file };
    },

    put(key, source) {
      const existing = inflight.get(key);
      if (existing) return existing;
      const p = slot(async () => {
        await init();
        const file = safeName(key);
        const res = await fs.downloadAsync(source.uri, dir + file, { headers: source.headers });
        if (res.status < 200 || res.status >= 300) {
          await fs.deleteAsync(dir + file, { idempotent: true }).catch(() => undefined);
          throw new Error(`thumbnail download failed (${res.status})`);
        }
        const info = await fs.getInfoAsync(dir + file);
        index.delete(key);
        index.set(key, { file, size: info.size ?? 0 });
        verified.add(key);
        await evict();
        persist();
        return { uri: dir + file } as ThumbSource;
      }).finally(() => inflight.delete(key));
      inflight.set(key, p);
      return p;
    },

    async clear() {
      await init();
      index = new Map();
      verified.clear();
      await fs.deleteAsync(dir, { idempotent: true }).catch(() => undefined);
      await fs.makeDirectoryAsync(dir, { intermediates: true }).catch(() => undefined);
    },
  };
}

let defaultCache: ThumbnailCache | null = null;

/** The cache used when a component is not given one: on disk when expo-file-system is installed, else in memory. */
export function getDefaultThumbnailCache(): ThumbnailCache {
  if (defaultCache) return defaultCache;
  try {
    defaultCache = createFileThumbnailCache();
  } catch {
    defaultCache = createMemoryThumbnailCache();
  }
  return defaultCache;
}

/** Replace the process-wide default (pass null to re-detect). */
export function setDefaultThumbnailCache(cache: ThumbnailCache | null): void {
  defaultCache = cache;
}

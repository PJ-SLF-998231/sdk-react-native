import { useCallback, useMemo, useRef, useState } from 'react';
import type { ShelfConnectionProps } from '../provider';
import type { ListFilesResult, ShelfItem } from '../core/types';
import { useResource } from './resource';
import type { ResourceState } from './resource';

export interface UseDocumentsOptions extends ShelfConnectionProps {
  /** Page size for the first request and for loadMore. Default 100. */
  pageSize?: number;
  /** Include documents of sub-folders. */
  recursive?: boolean;
}

export const DEFAULT_PAGE_SIZE = 100;

/** Cache key of a folder's document list (`undefined`/null = the library root). Exported for tests and prefetching. */
export const documentsKey = (folderId?: string | null, recursive = false): string => `files:${folderId ?? ''}:${recursive ? 'r' : 'd'}`;

const sameItem = (a: ShelfItem, b: ShelfItem): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * Revalidation fetches only the first page. If more pages were loaded before, keep them after the fresh first page
 * (minus duplicates) instead of collapsing a long list back to one page; the cursor stays that of the last page held.
 */
export function mergeFirstPage(prev: ListFilesResult | undefined, next: ListFilesResult): ListFilesResult {
  if (!prev) return next;
  let merged = next;
  if (prev.items.length > next.items.length && next.next_cursor) {
    const head = new Set(next.items.map((i) => i.id));
    merged = { items: [...next.items, ...prev.items.slice(next.items.length).filter((i) => !head.has(i.id))], next_cursor: prev.next_cursor };
  }
  if (merged.next_cursor === prev.next_cursor && merged.items.length === prev.items.length && merged.items.every((it, i) => sameItem(it, prev.items[i] as ShelfItem))) return prev;
  return merged;
}

export interface UseDocumentsResult extends Omit<ResourceState<ListFilesResult>, 'data'> {
  /** [] until something is loaded or cached. */
  items: ShelfItem[];
  /** False until the first data (cache or network) arrived. */
  ready: boolean;
  hasMore: boolean;
  loadingMore: boolean;
  loadMore: () => Promise<void>;
}

/** The documents of a folder (GET /files?folder_id), paginated, rendered from the cache first and revalidated. */
export function useDocuments(folderId?: string | null, options: UseDocumentsOptions = {}): UseDocumentsResult {
  const { pageSize = DEFAULT_PAGE_SIZE, recursive = false, ...conn } = options;
  const { state, handle, client } = useResource<ListFilesResult>(
    conn,
    documentsKey(folderId, recursive),
    (c, signal) => c.listFiles({ ...(folderId ? { folder_id: folderId } : {}), limit: pageSize, ...(recursive ? { recursive: true } : {}) }, { signal }),
    mergeFirstPage,
  );
  const [loadingMore, setLoadingMore] = useState(false);
  const busy = useRef(false);
  const data = state.data;
  const cursor = data?.next_cursor ?? null;
  const loadMore = useCallback(async () => {
    if (!handle || !cursor || busy.current) return;
    busy.current = true;
    setLoadingMore(true);
    try {
      const page = await client.listFiles({ ...(folderId ? { folder_id: folderId } : {}), limit: pageSize, cursor, ...(recursive ? { recursive: true } : {}) });
      const have = handle.snapshot().data;
      if (!have || have.next_cursor !== cursor) return; // the list changed under us; the next scroll retries
      const seen = new Set(have.items.map((i) => i.id));
      handle.set({ items: [...have.items, ...page.items.filter((i) => !seen.has(i.id))], next_cursor: page.next_cursor ?? null });
    } catch {
      /* a failed page is retried by the next onEndReached; the list stays as it was */
    } finally {
      busy.current = false;
      setLoadingMore(false);
    }
  }, [handle, client, cursor, folderId, pageSize, recursive]);
  return useMemo(() => {
    const { data: _d, ...rest } = state;
    return { ...rest, items: data?.items ?? EMPTY, ready: data !== undefined, hasMore: Boolean(cursor), loadingMore, loadMore };
  }, [state, data, cursor, loadingMore, loadMore]);
}

const EMPTY: ShelfItem[] = [];

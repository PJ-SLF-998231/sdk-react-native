import { useMemo } from 'react';
import type { ShelfConnectionProps } from '../provider';
import type { ShelfFolder } from '../core/types';
import { useResource } from './resource';
import type { ResourceState } from './resource';

export const foldersKey = (): string => 'folders';

function sameFolders(a: ShelfFolder[], b: ShelfFolder[]): boolean {
  return a.length === b.length && a.every((f, i) => JSON.stringify(f) === JSON.stringify(b[i]));
}

/** All folders the credential can see (GET /folders), cached; revalidated in the background. */
export function useFolders(options: ShelfConnectionProps = {}): ResourceState<ShelfFolder[]> {
  return useResource<ShelfFolder[]>(options, foldersKey(), (c, signal) => c.folders({ signal }), (prev, next) => (prev && sameFolders(prev, next) ? prev : next)).state;
}

/** The chain of folders from the root down to `folderId` (inclusive); [] for an unknown id or null. Cycle-safe. */
export function folderPath(folders: readonly ShelfFolder[] | undefined, folderId: string | null | undefined): ShelfFolder[] {
  if (!folders || !folderId) return [];
  const byId = new Map(folders.map((f) => [f.id, f]));
  const out: ShelfFolder[] = [];
  const seen = new Set<string>();
  let cur = byId.get(folderId);
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    out.unshift(cur);
    cur = cur.parent_id ? byId.get(cur.parent_id) : undefined;
  }
  return out;
}

export interface UseFolderResult extends ResourceState<ShelfFolder[]> {
  folder: ShelfFolder | undefined;
  /** Root-to-folder chain, for breadcrumbs. */
  path: ShelfFolder[];
  children: ShelfFolder[];
}

/** One folder, its ancestors and its direct children, derived from the cached folder list (there is no per-folder route). */
export function useFolder(folderId: string | null | undefined, options: ShelfConnectionProps = {}): UseFolderResult {
  const state = useFolders(options);
  const folders = state.data;
  return useMemo(() => {
    const path = folderPath(folders, folderId);
    return {
      ...state,
      folder: path[path.length - 1],
      path,
      children: folderId && folders ? folders.filter((f) => f.parent_id === folderId) : [],
    };
  }, [state, folders, folderId]);
}

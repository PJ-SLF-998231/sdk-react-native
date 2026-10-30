import { useMemo } from 'react';
import type { ShelfConnectionProps } from '../provider';
import type { ShelfDocument, ShelfSite } from '../core/types';
import { ShelfError } from '../core/errors';
import { useResource } from './resource';
import type { ResourceState } from './resource';

export const documentKey = (id: string): string => `file:${id}`;
export const siteKey = (id: string): string => `site:${id}`;

/** One document with its extracted text (GET /files/{id}). Pass null/undefined to stay idle. */
export function useDocument(id: string | null | undefined, options: ShelfConnectionProps = {}): ResourceState<ShelfDocument> {
  return useResource<ShelfDocument>(options, id ? documentKey(id) : null, (c, signal) => c.getFile(id as string, { signal })).state;
}

export interface UseDocumentTextResult extends Omit<ResourceState<ShelfDocument>, 'data'> {
  /** The extracted text; '' while loading, when none yet, and when the document is not parsed. */
  text: string;
  document: ShelfDocument | undefined;
}

/** The document's extracted text. Shares the document's cache entry (the API has no separate text route). */
export function useDocumentText(id: string | null | undefined, options: ShelfConnectionProps = {}): UseDocumentTextResult {
  const state = useDocument(id, options);
  return useMemo(() => {
    const { data, ...rest } = state;
    return { ...rest, document: data, text: data?.parsed_text ?? '' };
  }, [state]);
}

/** The document's generated site (GET /files/{id}/site). A 404 (no site, or an API that predates sites) is `status: 'none'`. */
export function useDocumentSite(id: string | null | undefined, options: ShelfConnectionProps = {}): ResourceState<ShelfSite> {
  return useResource<ShelfSite>(options, id ? siteKey(id) : null, async (c, signal) => {
    try {
      return await c.getSite(id as string, { signal });
    } catch (e) {
      if (e instanceof ShelfError && e.status === 404) return { file_id: id as string, status: 'none' };
      throw e;
    }
  }).state;
}

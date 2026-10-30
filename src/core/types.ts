/** Wire JSON stays snake_case; these types mirror the Shelf integration API. */

/** Request headers, resolved per request (so a rotating token or a session cookie header is fine). */
export type HeadersLike = Record<string, string>;
export type GetHeaders = () => HeadersLike | Promise<HeadersLike>;

export interface ShelfClientOptions {
  /** Base URL of the integration API or of your proxy for it (a path prefix such as /api/shelf is fine). */
  baseUrl: string;
  /**
   * Called before every request (async is fine); its result is merged into the request headers.
   * Return `{ Authorization: 'Bearer ...' }` or whatever your proxy expects. The SDK never takes a raw key prop.
   */
  getHeaders?: GetHeaders;
  /** Replaces the global `fetch` (tests, certificate pinning, instrumentation). */
  fetch?: typeof fetch;
  /** Runs once per failing request when the session is no longer authorised (401 or proxy 503 `not_configured`). */
  onAuthLost?: (error: ShelfErrorLike) => void;
}

/** Structural view of ShelfError so types.ts has no runtime import. */
export interface ShelfErrorLike extends Error {
  readonly status: number;
  readonly code: string;
  readonly field?: string;
}

export interface ShelfItem {
  id: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  folder_id: string | null;
  parse_status: string;
  created_at: string;
  edited_at: string | null;
  parsed_at: string | null;
  /** Names of the thumbnails that exist: any of small, medium, large. Always an array. */
  preview_sizes: string[];
  parsed_meta?: Record<string, unknown> | null;
  word_count?: number | null;
  /** True when the document has a generated document site. Absent on older APIs: no site. */
  has_site?: boolean;
}

export type PreviewSize = 'small' | 'medium' | 'large';

/** The single-document route's shape: the list item plus the extracted text and a download link. */
export type ShelfDocument = ShelfItem & { parsed_text?: string | null; download_url?: string };

export interface RequestOptions {
  signal?: AbortSignal;
}

export interface ThumbnailRequestOptions extends RequestOptions {
  /** Sent as `If-None-Match`; a matching ETag answers `{status: 304}`. */
  etag?: string | null;
}

export type ThumbnailResult =
  | { status: 200; bytes: ArrayBuffer; type: string; etag: string | null }
  | { status: 304 };

export interface OriginalResult {
  bytes: ArrayBuffer;
  type: string;
}

/** What `<Image source>` and download helpers need for an authenticated URL. */
export interface AuthedSource {
  uri: string;
  headers: HeadersLike;
}

export interface ShelfFolder {
  id: string;
  name: string;
  parent_id?: string | null;
  item_count?: number;
  total_item_count?: number;
  [key: string]: unknown;
}

export interface ShelfInfo {
  [key: string]: unknown;
}

export interface ListFilesParams {
  folder_id?: string;
  limit?: number;
  cursor?: string;
  recursive?: boolean;
}

export interface ListFilesResult {
  items: ShelfItem[];
  next_cursor?: string | null;
}

/**
 * A file to upload. On React Native pass `{ uri, name, type }` (a file:// or content:// URI from the camera,
 * picker or scanner): the bytes are streamed from disk by the native networking layer, never read into JS.
 * A `Blob` is accepted for tests and small in-memory payloads; never build one from base64.
 */
export type UploadFile = { uri: string; name: string; type: string } | Blob;

export interface UploadOptions {
  folder_id?: string;
  /** Only used with a Blob; a `{uri, name, type}` part carries its own name. */
  filename?: string;
  /** Idempotency / de-duplication reference (a client-generated id, e.g. for an offline retry). */
  client_ref?: string;
  on_duplicate?: string;
}

export interface UpdateFileInput {
  filename?: string;
  folder_id?: string;
}

export interface CreateFolderInput {
  name: string;
  parent_id?: string | null;
}

export interface UpdateFolderInput {
  name?: string;
  parent_id?: string | null;
}

export type SiteStatus = 'none' | 'building' | 'ready' | 'failed';

/** GET /files/{id}/site. `spec` is data (a version-1 document-site spec); render it, never evaluate it. */
export interface ShelfSite {
  file_id: string;
  status: SiteStatus;
  stale?: boolean;
  error_code?: string | null;
  error?: string | null;
  requested_at?: string | null;
  updated_at?: string | null;
  spec?: unknown;
}

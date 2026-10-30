import { ShelfError, isAuthLost } from './errors';
import { credentialFingerprint } from './fingerprint';
import { bindAuthSession, createAuthSession } from './session';
import type {
  AuthedSource,
  CreateFolderInput,
  HeadersLike,
  ListFilesParams,
  ListFilesResult,
  OriginalResult,
  RequestOptions,
  ShelfClientOptions,
  ShelfDocument,
  ShelfFolder,
  ShelfInfo,
  ShelfItem,
  ShelfSite,
  ThumbnailRequestOptions,
  ThumbnailResult,
  UpdateFileInput,
  UpdateFolderInput,
  UploadFile,
  UploadOptions,
} from './types';

export interface ShelfClient {
  /** The base URL this client talks to, trailing slashes removed. */
  readonly baseUrl: string;
  /** GET / */
  info(opts?: RequestOptions): Promise<ShelfInfo>;
  /** GET /folders */
  folders(opts?: RequestOptions): Promise<ShelfFolder[]>;
  /** GET /files */
  listFiles(params?: ListFilesParams, opts?: RequestOptions): Promise<ListFilesResult>;
  /** GET /files/{id}: the document with its extracted text (`parsed_text`). */
  getFile(id: string, opts?: RequestOptions): Promise<ShelfDocument>;
  /** The document's extracted text ('' when none yet). Reads GET /files/{id}; there is no separate text route. */
  getText(id: string, opts?: RequestOptions): Promise<string>;
  /** POST /files, multipart. Send `client_ref` for a retry-safe upload. */
  upload(file: UploadFile, opts?: UploadOptions, req?: RequestOptions): Promise<ShelfItem>;
  /** PATCH /files/{id} */
  updateFile(id: string, patch: UpdateFileInput, req?: RequestOptions): Promise<ShelfItem>;
  /** DELETE /files/{id} */
  deleteFile(id: string, req?: RequestOptions): Promise<void>;
  /**
   * POST /folders (the integration API's `POST /integration/folders`). `read_write` keys only. Rejects with a
   * ShelfError: 403 `forbidden` (read key), 404 `not_found` (parent outside the key's tree), 400 `invalid_input`
   * (empty/long name, null parent), 409 `conflict` (sibling has the name, or nested past 64 levels).
   */
  createFolder(input: CreateFolderInput, req?: RequestOptions): Promise<ShelfFolder>;
  /**
   * PATCH /folders/{id}: rename, move, or both. As createFolder, plus 404 for a folder outside the key's tree
   * (the same answer as one that does not exist), 403 `forbidden` for the key's own folder, and 409 for a move
   * into itself or its own subtree.
   */
  updateFolder(id: string, patch: UpdateFolderInput, req?: RequestOptions): Promise<ShelfFolder>;
  /** DELETE /folders/{id}: the folder, its subfolders and their documents go to the owner's trash (204). 403 for the key's own folder, 404 outside the tree. */
  deleteFolder(id: string, req?: RequestOptions): Promise<void>;
  /** `size` is a preview size name as listed in `preview_sizes`: small, medium or large. */
  thumbnailUrl(id: string, size?: string | number): string;
  /** Fetches a thumbnail with the client's credentials; with `etag` a matching answer is `{status: 304}`. */
  thumbnail(id: string, size: string | number, opts?: ThumbnailRequestOptions): Promise<ThumbnailResult>;
  originalUrl(id: string, filename: string): string;
  /** The original file's bytes, fetched with the client's credentials. */
  original(id: string, filename: string, opts?: RequestOptions): Promise<OriginalResult>;
  /** `{uri, headers}` for `<Image source>` / a file download: the URL plus the current auth headers. */
  authedSource(url: string): Promise<AuthedSource>;
  /** GET /files/{id}/site. 404 when the document has none or the API predates sites. */
  getSite(id: string, opts?: RequestOptions): Promise<ShelfSite>;
}

export function createShelfClient(options: ShelfClientOptions): ShelfClient {
  const base = options.baseUrl.replace(/\/+$/, '');
  const doFetch: typeof fetch = (input, init) => (options.fetch ?? globalThis.fetch)(input, init);
  const enc = encodeURIComponent;

  const session = createAuthSession();
  if (options.onAuthLost) session.onAuthLost(() => options.onAuthLost);

  /** The headers for one request, and the fingerprint of the credential in them (for the auth session). */
  async function resolveHeaders(accept: string, extra?: HeadersLike): Promise<{ headers: HeadersLike; fingerprint: string }> {
    const fromHost = options.getHeaders ? await options.getHeaders() : {};
    const fingerprint = credentialFingerprint(fromHost);
    session.observeCredential(fingerprint);
    return { headers: { ...extra, ...fromHost, Accept: accept }, fingerprint };
  }

  session.setCredentialReader(async () => credentialFingerprint(options.getHeaders ? await options.getHeaders() : {}));

  async function authHeaders(accept: string, extra?: HeadersLike): Promise<HeadersLike> {
    return (await resolveHeaders(accept, extra)).headers;
  }

  async function send(path: string, init: RequestInit, accept: string, signal?: AbortSignal, extra?: HeadersLike, allow304 = false): Promise<Response> {
    const token = session.begin();
    const { headers, fingerprint } = await resolveHeaders(accept, extra);
    const res = await doFetch(base + path, { ...init, headers, ...(signal ? { signal } : {}) });
    if (!res.ok && !(allow304 && res.status === 304)) {
      const err = await toError(res);
      if (isAuthLost(err)) session.reportAuthFailure(err, { fingerprint });
      throw err;
    }
    session.reportSuccess(token);
    return res;
  }

  async function request<T>(path: string, init: RequestInit = {}, req?: RequestOptions, extra?: HeadersLike): Promise<T> {
    const res = await send(path, init, 'application/json', req?.signal, extra);
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  const json = { 'Content-Type': 'application/json' };

  const client: ShelfClient = {
    baseUrl: base,

    info: (o) => request<ShelfInfo>('/', {}, o),

    async folders(o) {
      const body = await request<ShelfFolder[] | { folders?: ShelfFolder[] | null; items?: ShelfFolder[] | null } | null>('/folders', {}, o);
      if (Array.isArray(body)) return body;
      return body?.folders ?? body?.items ?? [];
    },

    listFiles(params = {}, o) {
      const q: string[] = [];
      const add = (k: string, v: string) => q.push(`${enc(k)}=${enc(v)}`);
      if (params.folder_id) add('folder_id', params.folder_id);
      if (params.limit !== undefined) add('limit', String(params.limit));
      if (params.cursor) add('cursor', params.cursor);
      if (params.recursive !== undefined) add('recursive', String(params.recursive));
      return request<unknown>('/files' + (q.length ? `?${q.join('&')}` : ''), {}, o).then(normaliseList);
    },

    getFile: (id, o) => request<ShelfDocument>(`/files/${enc(id)}`, {}, o).then(normaliseItem),

    async getText(id, o) {
      const doc = await request<ShelfDocument>(`/files/${enc(id)}`, {}, o);
      return doc?.parsed_text ?? '';
    },

    upload(file, opts = {}, req) {
      const form = new FormData();
      if (isBlob(file)) {
        const name = opts.filename ?? (file as { name?: string }).name;
        // The standard 3-argument append (filename) is a web/Node API; React Native's typings only declare two.
        if (name) (form as unknown as { append(k: string, v: Blob, n: string): void }).append('file', file, name);
        else form.append('file', file);
      } else {
        // React Native: the networking layer reads the file at `uri` and streams it into the multipart body.
        form.append('file', file as unknown as Blob);
      }
      if (opts.folder_id) form.append('folder_id', opts.folder_id);
      if (opts.client_ref) form.append('client_ref', opts.client_ref);
      if (opts.on_duplicate) form.append('on_duplicate', opts.on_duplicate);
      // No Content-Type: fetch sets multipart/form-data with the boundary.
      return request<ShelfItem>('/files', { method: 'POST', body: form }, req).then(normaliseItem);
    },

    updateFile: (id, patch, req) =>
      request<ShelfItem>(`/files/${enc(id)}`, { method: 'PATCH', body: JSON.stringify(patch) }, req, json).then(normaliseItem),

    async deleteFile(id, req) {
      await request<void>(`/files/${enc(id)}`, { method: 'DELETE' }, req);
    },

    createFolder: (input, req) => request<ShelfFolder>('/folders', { method: 'POST', body: JSON.stringify(input) }, req, json),

    updateFolder: (id, patch, req) =>
      request<ShelfFolder>(`/folders/${enc(id)}`, { method: 'PATCH', body: JSON.stringify(patch) }, req, json),

    async deleteFolder(id, req) {
      await request<void>(`/folders/${enc(id)}`, { method: 'DELETE' }, req);
    },

    thumbnailUrl: (id, size) => `${base}/files/${enc(id)}/thumbnail` + (size !== undefined ? `?size=${enc(String(size))}` : ''),

    async thumbnail(id, size, opts = {}) {
      const res = await send(
        `/files/${enc(id)}/thumbnail?size=${enc(String(size))}`,
        {},
        'image/*',
        opts.signal,
        opts.etag ? { 'If-None-Match': opts.etag } : undefined,
        true,
      );
      if (res.status === 304) return { status: 304 };
      return thumbResult(res);
    },

    originalUrl: (id, filename) => `${base}/files/${enc(id)}/original/${enc(filename)}`,

    async original(id, filename, opts = {}) {
      const res = await send(`/files/${enc(id)}/original/${enc(filename)}`, {}, '*/*', opts.signal);
      return { bytes: await res.arrayBuffer(), type: res.headers.get('Content-Type') ?? 'application/octet-stream' };
    },

    async authedSource(url) {
      return { uri: url, headers: await authHeaders('*/*') };
    },

    getSite: (id, o) => request<ShelfSite>(`/files/${enc(id)}/site`, {}, o),
  };
  bindAuthSession(client, session);
  return client;

  async function thumbResult(res: Response): Promise<ThumbnailResult> {
    const bytes = await res.arrayBuffer();
    return { status: 200, bytes, type: res.headers.get('Content-Type') ?? 'application/octet-stream', etag: res.headers.get('ETag') };
  }
}

function isBlob(f: UploadFile): f is Blob {
  return typeof Blob !== 'undefined' && f instanceof Blob;
}

/** The API answers `{files: [...], next_cursor}`; any list may arrive as null or be missing. */
function normaliseList(body: unknown): ListFilesResult {
  const b = (body ?? {}) as { files?: ShelfItem[] | null; items?: ShelfItem[] | null; next_cursor?: string | null };
  const rows = Array.isArray(b.files) ? b.files : Array.isArray(b.items) ? b.items : [];
  return { items: rows.map(normaliseItem), next_cursor: b.next_cursor ?? null };
}

function normaliseItem<T extends ShelfItem>(item: T): T {
  return Array.isArray(item?.preview_sizes) ? item : { ...item, preview_sizes: [] };
}

async function toError(res: Response): Promise<ShelfError> {
  let code = 'http_error';
  let message = res.statusText || `HTTP ${res.status}`;
  let field: string | undefined;
  try {
    const body = (await res.json()) as { code?: string; message?: string; error?: string; field?: string };
    if (body.code) code = body.code;
    else if (body.error) code = body.error;
    if (body.message) message = body.message;
    if (body.field) field = body.field;
  } catch {
    /* non-JSON error body */
  }
  return new ShelfError(res.status, code, message, field);
}

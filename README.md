# @pj-slf-998231/sdk-react-native

React Native SDK for the Shelf integration API. Work in progress.

## Core (U2)

- `createShelfClient({ baseUrl, getHeaders, fetch?, onAuthLost? })`: typed client, `ShelfError`, `isAuthLost`, `isOfflineError`.
- Storage: `createMemoryAdapter()` from `/storage`; `createAsyncStorageAdapter()` from `/storage/asyncstorage`; `createSqliteAdapter()` from `/storage/sqlite`.
- Cache: `createCache({ storage, baseUrl, cacheScope })`, `createSwr(cache)`, `clearCache()` (call on sign-out).
- Theme (`/theme`): light by default, `'dark'` opt-in, `'system'` only when asked; fonts are the host's job.
- `<ShelfProvider>` is optional; entries resolve their client through `useShelf({ client })` or `useShelf({ baseUrl, getHeaders })`.

See `docs/decisions/0001-core-client.md`.

## Upload outbox (U3)

`@pj-slf-998231/sdk-react-native/upload` is a persistent, local-first upload queue; `/hooks` re-exports `useOutbox` and
`useOnlineStatus`.

```tsx
const { enqueue, items, online } = useUpload({ folderId });         // inside <ShelfProvider storage={...}>, or pass
await enqueue({ uri: 'file:///.../scan.pdf', name: 'scan.pdf', type: 'application/pdf' }); // client / baseUrl+getHeaders
items.map((i) => <UploadStatusBadge key={i.id} item={i} />);
<OfflineBanner />
const outbox = createOutbox({ client, storage, scope: userId });  // headless, no React
```

- **Persistence.** Each item is written to the `StorageAdapter` before any upload starts and removed when it is done.
  After a restart a new outbox over the same storage resumes the rest. Without a `storage` (prop or provider) the queue
  is memory-only and does not survive a restart: pass a persistent adapter. `scope` (default: the provider's
  `cacheScope`) keeps users apart; it is hashed in the keys.
- **Idempotency.** Every item has one stable `client_ref` (its id), sent on every attempt, so a retry after a timeout
  cannot create a second document.
- **Retries.** Retriable failures (no response, 408, 429, 5xx) back off exponentially with full jitter (1 s base, 60 s
  cap, 8 attempts) and then show as `failed`; other 4xx fail at once. `retry(id)` re-queues with the same `client_ref`.
  A 401 / proxy `not_configured` (revoked key) purges the persisted queue and pauses it; `resume()` lifts the pause.
- **Concurrency** is at most 3. Files are sent as `{ uri, name, type }` multipart parts and streamed by the native
  networking layer; nothing is read into JS memory or base64-encoded.
- **Reconnect.** With the optional peer `@react-native-community/netinfo` the outbox holds uploads while offline and
  retries the moment the network returns. **Without it the device is assumed always online** (`useOnlineStatus()` returns
  `tracked: false`, a dev warning is logged once) and failed uploads are retried only by their backoff timers.
- **Progress.** `fetch` has no upload progress, so `progress` is 0 while uploading and 1 when done. Supply
  `upload: (call) => ...` (for example an `XMLHttpRequest` uploader calling `call.onProgress`) for a real bar.
- **Sharing.** `useOutbox`/`useUpload` share one outbox per client + storage + scope, so every screen sees the same
  queue and uploads continue when a screen unmounts. With `baseUrl` and no provider each hook builds its own client, so
  mount a `ShelfProvider` (or pass one `client`) when more than one component enqueues.

## Camera and picker (U4)

Two small entries that put a file into Shelf. Neither pulls in folder, document or list code (`npm run check:size`
enforces it and prints each entry's size).

```tsx
import { CameraButton } from '@pj-slf-998231/sdk-react-native/camera';
import { DocumentPickerButton, PhotoLibraryButton } from '@pj-slf-998231/sdk-react-native/picker';

<CameraButton mode="photo" folderId={folderId} onUploaded={(doc) => ...} onError={(e) => ...} />
<CameraButton mode="scan" folderId={folderId} />
<DocumentPickerButton multiple type={['application/pdf', 'image/*']} folderId={folderId} />
<PhotoLibraryButton multiple folderId={folderId} />
```

Each works inside `<ShelfProvider>` or with `client` / `baseUrl` + `getHeaders`. Common props: `folderId`, `onCaptured(file)`,
`onUploaded(result)`, `onError(err)`, `label`, `icon`, `theme`, `disabled`, and `children` (a node for the label, or a render
prop `({ onPress, state, disabled }) => node` to draw the whole button). `useCaptureUpload({ adapter, ... })` is the headless
version (`capture()`, `state`, `denied`, `openSettings()`, `dismiss()`).

- **Offline-safe by default.** Captured files go to the U3 outbox (persisted first, retried, `client_ref` for idempotency),
  so a photo taken on a train still arrives. `uploadMode="direct"` uploads at once instead; a failure then only reaches
  `onError`. In outbox mode `onUploaded` fires when the queued upload finishes, which can be much later, and only while
  the component using the hook is mounted; the queue itself keeps going either way (watch it with `useOutbox`).
- **No base64.** Adapters hand over file URIs (`file://`), which the networking layer streams.
- **Permissions.** A refused camera permission puts the button in `denied`: it explains, offers "Open Settings"
  (`Linking.openSettings()`) and "Not now", and calls `onError(ShelfPermissionDeniedError)`. Hide the notice with
  `hideDenied`.
- **Optional peers, loaded lazily:** photo uses `expo-image-picker`, scan uses `react-native-document-scanner-plugin`
  (needs a development build, not Expo Go), documents use `expo-document-picker`, the photo library uses
  `expo-image-picker`. A missing one throws `ShelfMissingPeerError` (`packageName`, `installCommand`) when the button is
  used, not at import or render, and the button shows the message and calls `onError`.
- **Your own source (bare RN, expo-camera).** Pass `adapter={{ capture: async (request) => [{ uri, name, type }] }}`;
  return `[]` for cancel and throw `ShelfPermissionDeniedError` for a refused permission. `expo-camera` is not wrapped
  because it needs a viewfinder screen of your own.
- A multi-page scan is uploaded as one image per page (no PDF assembly in the SDK).

## Folders, documents and hooks (U5)

```tsx
import { FolderList, FolderHeader } from '@pj-slf-998231/sdk-react-native/folders';
import { DocumentList } from '@pj-slf-998231/sdk-react-native/documents';
import { useFolder, useDocuments, useDocumentText, useDocumentSite } from '@pj-slf-998231/sdk-react-native/hooks';

<FolderHeader folderId={id} onNavigate={(f) => go(f?.id)} />
<FolderList parentId={id} onPressFolder={(f) => go(f.id)} />
<DocumentList folderId={id} onPressDocument={(d) => open(d.id)} />                // rows
<DocumentList folderId={id} variant="card" columns={3} listComponent="flashlist" />  // grid, FlashList if installed
```

All of them work inside `<ShelfProvider>` or with `client` / `baseUrl` + `getHeaders` props, and are stale-while-revalidate:
the cached copy is on screen as soon as the cache is read and a background request replaces it. With `storage` +
`cacheScope` the cache is persisted per user; otherwise it lives in memory. A failed refresh keeps the cached data
(`error` / `offline` are set; the list shows "Offline: showing saved documents").

- **Hooks** (`/hooks`, headless): `useFolders()`, `useFolder(id)` (folder, root-to-folder `path`, `children`, derived from
  the folder list; the API has no per-folder route), `useDocuments(folderId, { pageSize, recursive })` (`items`,
  `hasMore`, `loadMore`), `useDocument(id)`, `useDocumentText(id)` (`text`; shares the document's cache entry) and
  `useDocumentSite(id)` (a 404 is `status: 'none'`). U6 builds the document screen on the last two.
  A revalidation refetches page 1 and keeps further loaded pages behind it.
- **Folder writes are hidden.** Integration keys have no folder writes, so "New folder" (`FolderHeader.onCreateFolder`),
  Rename and Delete (`FolderList.onRenameFolder` / `onDeleteFolder`, `FolderCard.onRename` / `onDelete`) render only
  when you pass the handler. The SDK does not run the flow; call `client.createFolder` etc. yourself behind a proxy that
  allows it.
- **Virtualised lists.** `DocumentList` is a `FlatList` by default with fixed-height items and `getItemLayout`
  (`windowSize` 7, `initialNumToRender` 10, `maxToRenderPerBatch` 10, `removeClippedSubviews`). `listComponent="flashlist"`
  uses the optional peer `@shopify/flash-list` (loaded lazily; a missing peer falls back to `FlatList` with one warning),
  or pass any FlatList-compatible component. `listProps` overrides any list prop. Further pages load on scroll.
- **Thumbnails** load only for mounted rows, using the smallest `preview_sizes` rendition that covers the box at the
  device pixel ratio (small 360 px, medium 800, large 2000 on the long edge). They are downloaded natively with the auth
  headers straight to disk by the default `ThumbnailCache` (optional peer `expo-file-system`, LRU capped at 64 MB, index
  persisted); without the peer an in-memory fallback is used. Supply your own: `thumbnailCache={{ get, put, clear }}`
  or `setDefaultThumbnailCache(...)`. Empty the disk cache on sign-out with `getDefaultThumbnailCache().clear()`
  (`clearCache()` covers data, not pictures).
- **Entry graph.** `folders`, `documents` and `hooks` never import camera, picker or document code, and `npm run
  check:size` checks both the source graph and the built bytes (markers in both directions).

### Performance

`src/__tests__/perf.test.tsx` seeds 2,000 documents in one folder (memory storage adapter, per-user cache scope), mounts
`DocumentList`, and times a cold start (fresh storage read and cache) to the first row rendered from the cache, with the
network pending. Result in jest (react-test-renderer on Node, so a floor rather than a device number):

- **2,000 items: 4-10 ms to first list render from cache** (3 runs per invocation, 10 rows mounted of 2,000),
  after one untimed warm-up render. The very first render in a fresh jest process, with no warm-up, took 87 ms.
  The test asserts < 100 ms and < 40 mounted rows, and prints the numbers.
- Not measured here (needs a device): JS bundle load, the AsyncStorage / SQLite read of the persisted entry (the memory
  adapter has no I/O), native image decoding, and scroll frame rate.

## Document screen (U6)

```tsx
import { DocumentScreen } from '@pj-slf-998231/sdk-react-native/document';

<DocumentScreen
  documentId={id}
  baseUrl="https://your-proxy.example.com/api/shelf"   // or client={client}, or render inside <ShelfProvider>
  getHeaders={() => ({ Authorization: `Bearer ${token}` })}
  tabs={['text', 'preview', 'content']}   // ordered subset; this is the default order
  initialTab="preview"
  showPreviewSizes
  onUnknownBlock={(r) => log(r)}
/>
```

- **Tabs.** Text, Preview and Content. `tabs` picks and orders them. Content is shown only when the document's
  `has_site` is true (so it is absent while the document is still loading). `initialTab` applies when that tab is visible.
- **Standalone pieces** (each takes `documentId` plus `client` or `baseUrl` + `getHeaders`, or uses the provider):
  `DocumentTextView` (selectable, scales with the system font size, cut into chunks on a virtualised list so very long
  text does not freeze), `DocumentPreview` (thumbnail endpoint at the chosen size, `showSizes` lists `preview_sizes`; a
  file with no rendition shows a message and "Open original" through `Linking`), `DocumentContentView` (the generated
  site) and `SiteRenderer` (the same renderer for a spec you already hold).
- **Site spec.** All eight block types of `document-site.schema.json` v1 are drawn (hero, summary, key facts, amount,
  parties, timeline, table, source) in the fixed layout order. A block type this version does not know, a known block
  with unusable props, a repeated single-use block or a spec of another version is skipped and reported once through
  `onUnknownBlock({ type, index, reason, block })`; the rest still renders. `http(s)` links in the text open through
  `Linking` (or `onOpenLink`). Pending states: `none` with an expected site and `building` show "Content is being
  prepared" and are re-read every `pollMs` (default 10 s); a stale or rebuilding site with a spec shows "Updating…".
- **Pinch to zoom** is on the Preview image when the optional peers `react-native-gesture-handler` and
  `react-native-reanimated` are installed (the host renders a `GestureHandlerRootView`); without them the image is plain.
- **Entry graph.** `document` imports core, cache, provider, theme, shared and `hooks/useDocument` only. It builds its
  picture from `client.thumbnailUrl` and `client.authedSource` rather than importing the `documents` thumbnail cache (that
  would pull `expo-file-system` and the list code into a detail-only bundle), and it never reaches camera, picker or upload.

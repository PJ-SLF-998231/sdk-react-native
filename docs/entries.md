# Entries and optional peers

Every entry is a subpath of `@pj-slf-998231/sdk-react-native` (see `exports` in `package.json`). Install the SDK, then
only the peers of the entries you import. `react` (>= 18) and `react-native` (>= 0.74) are always required.

Legend: **needs** = the entry cannot do its main job without it; **optional** = used lazily by one feature, with a
fallback or a clear `ShelfMissingPeerError` when absent.

| Entry | Main exports | Peers | Native config | Reaches (source areas) |
|---|---|---|---|---|
| `.` | `createShelfClient`, `ShelfProvider`, `useShelf`, `clearCache`, `clearAll`, `registerClearAllHook`, `createCache`, `createSwr`, errors, `getAuthSession` / `createAuthSession` / `credentialFingerprint`, theme tokens | none | none | core, cache, provider, theme |
| `/camera` | `CameraButton`, `useCaptureUpload`, `createPhotoCaptureAdapter`, `createScanAdapter` | needs `expo-image-picker` for `mode="photo"`; needs `react-native-document-scanner-plugin` for `mode="scan"` (dev build); optional `@react-native-community/netinfo` | camera permission (iOS `NSCameraUsageDescription`, Android `CAMERA`) | core, cache, provider, theme, upload, shared, storage (memory) |
| `/picker` | `DocumentPickerButton`, `PhotoLibraryButton` | needs `expo-document-picker` (documents) / `expo-image-picker` (photo library); optional netinfo | iOS `NSPhotoLibraryUsageDescription` (library); none for documents | same as camera |
| `/upload` | `createOutbox`, `useUpload`, `useOutbox`, `useOnlineStatus`, `UploadStatusBadge`, `OfflineBanner` (both show the pause reason), `OutboxPauseReason` | optional `@react-native-community/netinfo` | none | core, cache, provider, storage, theme |
| `/folders` | `FolderList`, `FolderCard`, `FolderBreadcrumb`, `FolderHeader` | none | none | core, cache, provider, theme, hooks, shared |
| `/documents` | `DocumentList`, `DocumentRow`, `DocumentCard`, thumbnail cache (`getDefaultThumbnailCache`, `setDefaultThumbnailCache`) | optional `@shopify/flash-list` (`listComponent="flashlist"`), optional `expo-file-system` (disk thumbnail cache; memory fallback) | none | core, cache, provider, theme, hooks, shared |
| `/document` | `DocumentScreen`, `DocumentTextView`, `DocumentPreview`, `DocumentContentView`, `SiteRenderer` | optional `react-native-gesture-handler` + `react-native-reanimated` (pinch to zoom; both or neither) | none | core, cache, provider, theme, shared, hooks (`useDocument` only) |
| `/hooks` | `useFolders`, `useFolder`, `useDocuments`, `useDocument`, `useDocumentText`, `useDocumentSite`, `useOutbox`, `useOnlineStatus` | optional netinfo (through the outbox hooks) | none | core, cache, provider, storage, theme, upload |
| `/storage` | `createMemoryAdapter`, `StorageAdapter` | none | none | core, storage |
| `/storage/asyncstorage` | `createAsyncStorageAdapter` | needs `@react-native-async-storage/async-storage` | none | core, storage |
| `/storage/sqlite` | `createSqliteAdapter` | needs `expo-sqlite` | none (dev build in Expo) | core, storage |
| `/theme` | `lightTheme`, `darkTheme`, `createTheme`, `resolveTheme`, `loadShelfFonts` | optional `expo-font` (only `loadShelfFonts`) | none | core, theme |

## Sign-out and the entry graph

`clearAll()` (also `clearCache({ everything: true })`) lives in the root entry (`cache/clear.ts`) and clears the read cache,
thumbnails and the persisted upload queue. It cannot import `documents` (thumbnails) or `upload` (live queues) without
pulling them into every bundle, and `camera` / `picker` / `upload` must not reach `documents`. So those entries
register a hook with `registerClearAllHook` when they load: `upload/outbox.ts` registers each live outbox (removed on
`destroy()`), `documents/thumbnails.ts` registers the default thumbnail cache. The queue's storage keys
(`shelf:outbox:v1:<hash(scope)>:<id>`) are also deleted directly by prefix, so no entry is needed for the persisted part.
The `upload -> cache` and `documents -> cache` edges are already permitted (both areas already import cache); no new edge was added.
Plain `clearCache()` never touches `shelf:outbox:` keys.

On a 401 / `not_configured` the outbox keeps its queue and pauses (`pauseReason` `'auth'` | `'not_configured'`); only
the read cache is purged. See the README, "Storage, caching and sign-out" and Troubleshooting.

## Auth episodes (`core/session.ts`)

`onAuthLost` is once per auth-loss episode. The state lives in `core` (`session.ts`, `fingerprint.ts`) so every entry can use
it without a new graph edge: `createShelfClient` creates one `AuthSession` per client and binds it in a `WeakMap`
(`getAuthSession(client)`); the client reports each 401 / 503 `not_configured` and each success; the provider
(`useBuild`) and the outbox subscribe to it with `onAuthLost(() => latestCallback)` instead of the client's own callback,
so an injected client and shared clients behave the same. The outbox also reports refusals that come through a custom
`upload` transport and calls `session.resume()` from `resume()`. The episode ends on a success that began after it opened,
`resume()`, or a change of `credentialFingerprint(getHeaders())` (pure-JS SHA-256 over the header names/values, 16 hex
chars; the credential is never stored). See the README, "One onAuthLost per episode".

## Peer to entry

| Peer | Used by |
|---|---|
| `expo-image-picker` | `/camera` (photo), `/picker` (photo library) |
| `react-native-document-scanner-plugin` | `/camera` (`mode="scan"`) |
| `expo-document-picker` | `/picker` (documents) |
| `@react-native-community/netinfo` | `/camera`, `/picker`, `/upload`, `/hooks` (outbox reconnect and `useOnlineStatus`) |
| `@shopify/flash-list` | `/documents` |
| `expo-file-system` | `/documents` (thumbnail disk cache) |
| `react-native-gesture-handler`, `react-native-reanimated` | `/document` (zoom) |
| `@react-native-async-storage/async-storage` | `/storage/asyncstorage` |
| `expo-sqlite` | `/storage/sqlite` |
| `expo-font` | `/theme` (`loadShelfFonts`) |

## How the boundaries are enforced

- Each peer is loaded with a literal `require('<peer>')` directly inside a `try` block (one loader per file for the capture
  peers). Metro treats such a require as an optional dependency: the bundle builds when the peer is not installed and the
  call throws `ShelfMissingPeerError` at use. This is what lets an app that imports only `/camera` skip
  `expo-document-picker`, `expo-file-system`, FlashList and the rest. `example/` exercises it.
- `scripts/check-entry-graph.mjs` (`npm run check:size`) fails the build if `camera` / `picker` / `upload` reach list or
  document code, if the browsing entries reach capture code, or if any built entry matches DOM / IndexedDB patterns. It also
  prints each entry's source graph and built size.
- [size-report.md](size-report.md) repeats the camera-only check on a real Metro export of the example.

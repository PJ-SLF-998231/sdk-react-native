# Changelog

Notable changes to `@pj-slf-998231/sdk-react-native`. Versions follow semver; each one is released by its `vX.Y.Z`
tag (see `CONTRIBUTING.md`). Nothing has been released yet.

## Unreleased (0.1.0)

The first version. `package.json` says 0.1.0; it is published when the `v0.1.0` tag is pushed.

### Added

- Core: `createShelfClient` for the integration API through your own proxy (`baseUrl` and `getHeaders`, never an
  API key), with folder writes (`createFolder`, `updateFolder`, `deleteFolder`) for `read_write` keys; storage
  adapters (memory, AsyncStorage, SQLite); a stale-while-revalidate cache; `ShelfProvider`; light and dark themes.
- Upload (`/upload`): a persistent outbox with a stable `client_ref` per item, backoff with jitter and at most three
  uploads at once; `useUpload`, `useOutbox`, `useOnlineStatus`, `UploadStatusBadge` and `OfflineBanner`. On a 401 or
  the proxy's `503 not_configured` the queue pauses and keeps every file; the pause survives a restart (with a
  fingerprint of the credential) and `clearAll()` discards it on sign-out. `onAuthLost` fires once per auth-loss
  episode.
- Capture (`/camera`, `/picker`): `CameraButton` (photo, or scan with `react-native-document-scanner-plugin`),
  `DocumentPickerButton`, `PhotoLibraryButton` and `useCaptureUpload`.
- Browsing (`/folders`, `/documents`, `/hooks`): `FolderHeader`, `FolderList`, `FolderCard`, `FolderBreadcrumb`,
  `DocumentList` (virtualised, optional FlashList) with an LRU thumbnail cache, and the data hooks.
- Document (`/document`): `DocumentScreen` with Text, Preview and Content (the document's generated site) tabs.
- Every entry its own import path with its optional peers; `check:size` (`scripts/check-entry-graph.mjs`) keeps the
  capture entries free of list and document code. An example camera app and a size report.

### Documentation

- README: the proxy recipe is the same as `@pj-slf-998231/sdk`'s, with the full header allowlist, `ETag` / `304`,
  `Retry-After` and the shared per-address rate limit; "Confirm before deleting" gives Shelf's trash wording.

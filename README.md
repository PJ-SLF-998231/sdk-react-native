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

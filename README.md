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

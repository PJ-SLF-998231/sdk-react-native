# @pj-slf-998231/sdk-react-native

React Native client and UI for the Shelf integration API: capture a photo or scan, pick a file, upload it (offline-safe),
browse folders and documents, and read a document's text, preview and generated content. Every part is a separate
entry point, so an app bundles and installs only what it uses.

- [Install](#install)
- [Security model: read this first](#security-model-read-this-first)
- [Use only what you need](#use-only-what-you-need)
- [Entries and optional peers](#entries-and-optional-peers)
- [Expo setup](#expo-setup) / [Bare React Native setup](#bare-react-native-setup)
- [Storage, caching and sign-out](#storage-caching-and-sign-out)
- [Theme](#theme)
- [Component and hook reference](#component-and-hook-reference)
- [Known limits](#known-limits)
- [Troubleshooting](#troubleshooting)
- [Example app and size report](#example-app-and-size-report)

## Install

The package is private on GitHub Packages. Point the scope at it once (the token needs `read:packages`; keep it in your
CI secrets or your user `~/.npmrc`, never in the repo):

```ini
# .npmrc
@pj-slf-998231:registry=https://npm.pkg.github.com
```

```sh
npm install @pj-slf-998231/sdk-react-native
```

Required peers: `react >= 18` and `react-native >= 0.74`. Every other peer is **optional** and belongs to one entry
(table below); install only the ones for the entries you import. In an Expo app use `npx expo install <peer>` so the
version matches your SDK.

## Security model: read this first

> **A `shelf_ik_` integration key must never ship in an app binary.** Anything inside an iOS or Android build, including
> `EXPO_PUBLIC_*` variables, `app.json` `extra`, and obfuscated constants, can be extracted. A leaked key reads and writes
> the whole folder it is bound to until someone revokes it.

So this SDK has **no `apiKey` prop anywhere**. The app talks to **your own backend proxy**, which holds the key and adds
it server-side:

```
app  --(baseUrl + getHeaders(): your session token)-->  your proxy  --(Authorization: Bearer shelf_ik_...)-->  Shelf API
```

- `baseUrl` is the proxy's URL, including any path prefix (for example `https://api.example.com/api/shelf`).
- `getHeaders()` returns whatever **your** proxy needs to know who the user is, usually
  `{ Authorization: 'Bearer <the user's session token>' }`. It runs before every request (async is fine), so tokens can
  rotate and live in the platform keychain (`expo-secure-store`).
- The proxy authenticates that session, **then** adds the integration key. It is the only place the key exists.
- If the key is revoked the proxy answers `503 { code: 'not_configured' }` (or Shelf answers 401). The SDK treats both as
  "authorisation lost": `onAuthLost` fires, the read cache is purged and the upload queue **pauses and keeps every
  unsent file** (see [Troubleshooting](#troubleshooting) and [Sign-out](#storage-caching-and-sign-out)).
  `onAuthLost` fires **once per auth-loss episode**, not once per failing request (see
  [One onAuthLost per episode](#one-onauthlost-per-episode)).

### Minimal Express proxy

This is a sketch to adapt, not a drop-in. Replace `requireUser` with your own session check.

The proxy forwards `/api/shelf/<path>` to `${SHELF_API_URL}/api/v1/integration/<path>` and adds
`Authorization: Bearer ${SHELF_INTEGRATION_KEY}`. It runs behind your own session check, allows only the integration
routes, and **streams** both directions so uploads and originals are never buffered in memory. Mount it **before**
`express.json()` so request bodies are still unread streams. The recipe is the same in `@pj-slf-998231/sdk` and
`@pj-slf-998231/sdk-react-native`.

Route table (anything else: 404, do not forward). The folder-write routes (the last three) need a `read_write` key;
drop them if your integration never writes folders.

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/` | key and folder info |
| GET | `/folders` | folders reachable by the key |
| GET | `/files?folder_id&limit&cursor&recursive` | list |
| GET | `/files/{id}` | details and text |
| GET | `/files/{id}/thumbnail?size` | image preview |
| GET | `/files/{id}/site` | the document's generated site (404 when it has none) |
| GET | `/files/{id}/original/{name}` | download; stream the body |
| POST | `/files` | multipart: `file`, `folder_id`, `client_ref`, `on_duplicate`; stream the body |
| PATCH | `/files/{id}` | rename or move (JSON) |
| DELETE | `/files/{id}` | move to the Shelf trash |
| POST | `/folders` | create a folder (JSON `{ name, parent_id }`) |
| PATCH | `/folders/{id}` | rename or move a folder (JSON) |
| DELETE | `/folders/{id}` | move a folder and everything in it to the Shelf trash |

Header allowlist. Forward only these and drop everything else, in particular the caller's `Authorization`, `Cookie`
and `Host`, and any `X-Forwarded-*`, `X-Real-IP` or `Fly-Client-IP` they send.

- Request to Shelf: `Accept`, `Content-Type` (keeps the multipart boundary), `Content-Length`, `If-None-Match`, `Range`,
  `If-Range`.
- Response to the caller: `Content-Type`, `Content-Length`, `Content-Disposition`, `Content-Range`, `Accept-Ranges`,
  `ETag`, `Last-Modified`, `Cache-Control`, `Vary`, `X-Content-Type-Options`, `Retry-After`.

Why these: Shelf sends an `ETag` with thumbnails, originals and document sites (and, as it adds them, with listings and
details) and answers a matching `If-None-Match` with `304` and no body, so pass the `304` through as it is.
`Cache-Control` is `private` (or `no-store`) on everything; keep it, so no shared cache between your users stores one
user's answer. Originals and thumbnails carry `X-Content-Type-Options: nosniff`. `Range` and `If-Range` are forwarded
for originals; Shelf answers them with the whole file (`200`) today, and with `206` and `Content-Range` if it starts to
honour them. A `429` carries `Retry-After` in seconds. Drop `Content-Length` when Shelf's answer had a
`Content-Encoding`: `fetch` hands you the decoded body, so the length no longer matches.

Errors the proxy produces itself:

| Condition | Response |
| --- | --- |
| No valid user session | 401 (your own auth) |
| `SHELF_API_URL` or `SHELF_INTEGRATION_KEY` unset, or Shelf answers 401 (key revoked, expired or invalid) | `503 {"code":"not_configured"}` (fail closed) |
| Shelf unreachable or times out | 502 |
| Method or path not in the route table | 404 |
| Any other Shelf answer (304, 400, 403, 404, 409, 413, 415, 429, 5xx) | pass through the status, the allowed headers and the body |

Rate limits. Shelf allows 600 `/integration` requests a minute per client address, and behind the proxy that address is
the proxy's, so all your users share one budget. Rate-limit the route per user on your side and pass Shelf's `429` with
its `Retry-After` through.

```js
// shelf-proxy.mjs  (Node 18+, Express 4/5)
import { Readable } from 'node:stream';

const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const ALLOWED = [
  ['GET', /^\/?$/],
  ['GET', /^\/folders\/?$/],
  ['GET', /^\/files\/?$/],
  ['GET', new RegExp(`^/files/${UUID}/?$`)],
  ['GET', new RegExp(`^/files/${UUID}/thumbnail/?$`)],
  ['GET', new RegExp(`^/files/${UUID}/site/?$`)],
  ['GET', new RegExp(`^/files/${UUID}/original/[^/]+$`)],
  ['POST', /^\/files\/?$/], // multipart upload
  ['PATCH', new RegExp(`^/files/${UUID}/?$`)],
  ['DELETE', new RegExp(`^/files/${UUID}/?$`)],
  ['POST', /^\/folders\/?$/], // folder writes, read_write keys only
  ['PATCH', new RegExp(`^/folders/${UUID}/?$`)],
  ['DELETE', new RegExp(`^/folders/${UUID}/?$`)],
];
const FORWARD_REQUEST = ['accept', 'content-type', 'content-length', 'if-none-match', 'range', 'if-range'];
const FORWARD_RESPONSE = ['content-type', 'content-length', 'content-disposition', 'content-range', 'accept-ranges',
  'etag', 'last-modified', 'cache-control', 'vary', 'x-content-type-options', 'retry-after'];

const fail = (res, status, code, message) => res.status(status).set('Cache-Control', 'no-store').json({ error: code, code, message });

function allowed(method, path) {
  if (!ALLOWED.some(([m, re]) => m === method && re.test(path))) return false;
  // No dot segments or encoded separators in the file name segment.
  return !path.split('/').some((s) => {
    try { const d = decodeURIComponent(s); return d === '.' || d === '..' || d.includes('/') || d.includes('\\'); } catch { return true; }
  });
}

export async function shelfProxy(req, res) {
  if (!allowed(req.method, req.path)) return fail(res, 404, 'not_found', 'No such Shelf route');

  const base = (process.env.SHELF_API_URL ?? '').replace(/\/+$/, '');
  const key = process.env.SHELF_INTEGRATION_KEY ?? ''; // server-side secret; never sent to the browser or the app
  if (!base || !key) return fail(res, 503, 'not_configured', "Shelf isn't connected");

  const q = req.url.indexOf('?');
  const target = `${base}/api/v1/integration${req.path.replace(/\/+$/, '')}${q === -1 ? '' : req.url.slice(q)}`;
  const headers = { Authorization: `Bearer ${key}` };
  for (const h of FORWARD_REQUEST) if (req.headers[h] !== undefined) headers[h] = req.headers[h];

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), req.method === 'POST' ? 120_000 : 30_000);
  res.on('close', () => { clearTimeout(timer); if (!res.writableFinished) ctrl.abort(); }); // caller went away: stop upstream too

  let up;
  try {
    up = await fetch(target, {
      method: req.method, headers, redirect: 'manual', signal: ctrl.signal,
      ...(req.method === 'POST' || req.method === 'PATCH' ? { body: req, duplex: 'half' } : {}), // stream the upload up
    });
  } catch {
    clearTimeout(timer);
    return fail(res, 502, 'unavailable', 'Shelf is unreachable');
  }
  // Shelf refused the key: a configuration problem, never the user's login problem. Tell the SDK so it stops.
  if (up.status === 401) { clearTimeout(timer); up.body?.cancel().catch(() => {}); return fail(res, 503, 'not_configured', "Shelf isn't connected"); }

  res.status(up.status); // 304 included: it has no body
  const decoded = up.headers.has('content-encoding'); // fetch decoded the body, so Shelf's length no longer applies
  for (const h of FORWARD_RESPONSE) {
    const v = up.headers.get(h);
    if (v !== null && !(decoded && h === 'content-length')) res.setHeader(h, v);
  }
  if (!up.body) return res.end();
  const body = Readable.fromWeb(up.body);
  body.on('error', () => res.destroy());
  body.pipe(res); // stream the response (thumbnails, originals) down
}
```

```js
// app.js
import express from 'express';
import { shelfProxy } from './shelf-proxy.mjs';

const app = express();
// requireUser: verify YOUR session first (the cookie session of a web page, or the bearer token an app sends).
app.use('/api/shelf', requireUser, shelfProxy); // before express.json()
app.use(express.json());
```

Also: keep the key in your secret manager, give it the narrowest access that works (`Read only` unless the integration
writes), set a body size limit on your edge, and never log the `Authorization` header you add.

## Use only what you need

Each entry is its own import path and Metro bundles only what that path imports. These four are complete, working
shapes. `getHeaders` and `baseUrl` are the proxy settings from above. The examples marked `check` in this README's
source are type-checked against the built package (`npm run check:readme`, in CI).

### (a) A camera button only

Install the SDK and **only** `expo-image-picker` (photo mode). Import only `/camera`.

```sh
npm install @pj-slf-998231/sdk-react-native
npx expo install expo-image-picker
```

```tsx check
import { CameraButton } from '@pj-slf-998231/sdk-react-native/camera';

declare const token: string; // your user's session token for your proxy

export const Capture = () => (
  <CameraButton baseUrl="https://api.example.com/api/shelf" getHeaders={() => ({ Authorization: `Bearer ${token}` })}
    onUploaded={(doc) => console.log(doc.id)} onError={(e) => console.warn(e.message)} />
);
```

Captured photos go through a persistent outbox, so one taken offline still arrives. `mode="scan"` additionally needs
`react-native-document-scanner-plugin` (development build, not Expo Go). Nothing from folders, documents, document or
the picker is bundled: [docs/size-report.md](docs/size-report.md) proves it on an exported iOS and Android bundle, and
`example/` is this exact app.

### (b) Picker and upload queue only

```sh
npx expo install expo-document-picker expo-image-picker @react-native-community/netinfo @react-native-async-storage/async-storage
```

```tsx check
import { ShelfProvider } from '@pj-slf-998231/sdk-react-native';
import { createAsyncStorageAdapter } from '@pj-slf-998231/sdk-react-native/storage/asyncstorage';
import { DocumentPickerButton, PhotoLibraryButton } from '@pj-slf-998231/sdk-react-native/picker';
import { useOutbox } from '@pj-slf-998231/sdk-react-native/upload';
import { UploadStatusBadge, OfflineBanner } from '@pj-slf-998231/sdk-react-native/upload';

declare const BASE_URL: string;
declare const getHeaders: () => Promise<Record<string, string>>;

const storage = createAsyncStorageAdapter();

export const Uploads = ({ userId, folderId }: { userId: string; folderId: string }) => (
  <ShelfProvider baseUrl={BASE_URL} getHeaders={getHeaders} storage={storage} cacheScope={userId}>
    <OfflineBanner />
    <DocumentPickerButton multiple type={['application/pdf', 'image/*']} folderId={folderId} />
    <PhotoLibraryButton multiple folderId={folderId} />
    <QueueList />
  </ShelfProvider>
);

function QueueList() {
  const { snapshot } = useOutbox();
  return snapshot.items.map((i) => <UploadStatusBadge key={i.id} item={i} paused={snapshot.pauseReason} />);
}
```

**When the credential is refused (401 or the proxy's 503 `not_configured`) the queue is kept, never purged.** The outbox
stops draining and pauses: `snapshot.paused` is true and `snapshot.pauseReason` is `'auth'` (401, label "Needs sign-in")
or `'not_configured'` (label "Not connected"); `'manual'` is your own `pause()`. Every unsent item stays in memory and in
storage, with its file URI and `client_ref`; running uploads are aborted and go back to pending. `onAuthLost` fires once
for the episode, not once per item. `UploadStatusBadge paused={snapshot.pauseReason}` and
`OfflineBanner pauseReason={snapshot.pauseReason} pendingCount={...}` show it. `useOutbox()` also gives you `pausedReason` (the same value) and `retryNow()`.

**The pause survives an app restart.** An `'auth'` / `'not_configured'` pause is saved in the same `storage` as the queue
(key `shelf:outbox:v1:<hash(scope)>:~pause`): the reason, when it began, and a **fingerprint** of the headers in use when
the credential was refused (16 hex characters of a SHA-256; the credential itself is never stored or logged). After a
restart the outbox is paused as soon as it is ready, so the UI shows "Needs sign-in" / "Not connected" at once and the queue is
intact; nothing is sent yet. It then calls `getHeaders` once and compares fingerprints:

| At startup | What happens |
|---|---|
| Different fingerprint (the credential was refreshed) | ONE queued item is sent as a probe. Success: the pause ends and the rest drains (each file once, same `client_ref`). 401 / `not_configured`: the queue stays paused and `onAuthLost` does **not** fire again; a refusal after a later successful request is a new episode and does. |
| Same fingerprint | Stays paused until you call `resume()`, `retryNow()`, or the credential changes. |
| `getHeaders` throws, or the device is offline | Stays paused, no crash, no `onAuthLost`. (Offline: the probe goes out once the network is back.) |

`retryNow()` sends one probe item whatever the fingerprint says (use it for a "Try again" button); `resume()` lifts the pause and
drains everything. With nothing queued there is nothing to probe, so a different credential (or `retryNow()`) simply lifts
the pause. The saved pause is deleted when the pause ends and by `clearAll()`. A manual `pause()` is not persisted. Queues
saved by an earlier version have no pause record and behave as before (the first attempt pauses again if refused).
Without a persistent `storage` nothing survives a restart, pause included.

The outboxes `useOutbox()` shares per client, storage and scope are reference counted: the last screen to unmount destroys the
outbox (timers, connectivity and `clearAll` registration), and the next mount builds a new one that reloads the saved queue.
Uploads therefore keep running while any screen uses the outbox, not after all of them are gone; create your own with
`createOutbox()` (and keep it) for uploads that must outlive the UI. `clearAll()` holds live outboxes weakly.

To continue, fix the credential (the user signs in again, or the key is restored on your proxy), then call
`resume()` (from `useOutbox()` / `useUpload()` / the outbox). `getHeaders` runs before every request, so a refreshed
token is picked up by the next attempt; there is no polling. `resume()` drains the kept items once each: a file whose
earlier attempt reached the server is re-sent with the same `client_ref`, so it is not duplicated. If the credential is
still refused the queue pauses again and `onAuthLost` fires again (`resume()` ends the episode, so this is a new one). Only sign-out (`clearAll()`) discards the queue.

With a persistent `storage` the queue survives an app restart. Without one it is memory-only. NetInfo makes uploads
wait while offline and retry on reconnect; without it the device is assumed always online.

### (c) Headless hooks

No UI from the SDK; you draw everything. Needs no optional peer (add a storage adapter if you want a persisted cache).

```tsx check
import { FlatList, Text } from 'react-native';
import { useDocuments } from '@pj-slf-998231/sdk-react-native/hooks';

// Inside a <ShelfProvider>; useFolder, useFolders, useDocument, useDocumentText and useDocumentSite work the same way.
export function Docs({ folderId }: { folderId: string }) {
  const { items, loading, error, hasMore, loadMore } = useDocuments(folderId, { pageSize: 30 });
  // items: cached data first, then replaced by the network (stale-while-revalidate)
  if (error && !items.length) return <Text>Couldn't load the documents.</Text>;
  return (
    <FlatList data={items} keyExtractor={(d) => d.id} renderItem={({ item }) => <Text>{item.filename}</Text>}
      onEndReached={hasMore ? loadMore : undefined} refreshing={loading} />
  );
}
```

`hooks` also re-exports `useOutbox` / `useOnlineStatus`, which is why it pulls the upload code. Use the client directly
(`createShelfClient`, root entry) if you want no hooks at all.

### (d) A full folder browser

```sh
npx expo install @shopify/flash-list expo-file-system react-native-gesture-handler react-native-reanimated \
  @react-native-async-storage/async-storage @react-native-community/netinfo
```

```tsx check
import { FolderHeader, FolderList } from '@pj-slf-998231/sdk-react-native/folders';
import { DocumentList } from '@pj-slf-998231/sdk-react-native/documents';
import { DocumentScreen } from '@pj-slf-998231/sdk-react-native/document';

interface BrowserProps {
  folderId: string | null;
  onOpenFolder: (id: string | null | undefined) => void;
  onOpenDocument: (id: string) => void;
}

// <ShelfProvider ...> at the root, wrapped in <GestureHandlerRootView> for pinch-to-zoom
export function Browser({ folderId, onOpenFolder, onOpenDocument }: BrowserProps) {
  return (
    <>
      <FolderHeader folderId={folderId} onNavigate={(f) => onOpenFolder(f?.id)} />
      <FolderList parentId={folderId} onPressFolder={(f) => onOpenFolder(f.id)} />
      <DocumentList folderId={folderId} variant="card" columns={2} listComponent="flashlist" onPressDocument={(d) => onOpenDocument(d.id)} />
    </>
  );
}
export const Detail = ({ documentId }: { documentId: string }) => <DocumentScreen documentId={documentId} />; // Text / Preview / Content tabs
```

Add `<PhotoLibraryButton>`, `<CameraButton>` or `<DocumentPickerButton>` beside them for capture.

## Entries and optional peers

Import path = package name + the subpath. The root entry (`@pj-slf-998231/sdk-react-native`) has the client, cache,
provider, theme tokens and errors, and no UI. Details and the build-time guarantees are in
[docs/entries.md](docs/entries.md).

| Entry | Gives you | Optional peers it can use |
|---|---|---|
| `.` | `createShelfClient`, `ShelfProvider`, `useShelf`, `clearCache`, `clearAll`, errors, theme tokens | none |
| `/camera` | `CameraButton` (photo, scan), `useCaptureUpload` | `expo-image-picker` (photo), `react-native-document-scanner-plugin` (scan), `@react-native-community/netinfo` (reconnect) |
| `/picker` | `DocumentPickerButton`, `PhotoLibraryButton` | `expo-document-picker`, `expo-image-picker`, `@react-native-community/netinfo` |
| `/upload` | `createOutbox`, `useUpload`, `useOutbox`, `UploadStatusBadge`, `OfflineBanner` | `@react-native-community/netinfo` |
| `/folders` | `FolderList`, `FolderCard`, `FolderBreadcrumb`, `FolderHeader` | none |
| `/documents` | `DocumentList`, rows/cards, thumbnail cache | `@shopify/flash-list`, `expo-file-system` |
| `/document` | `DocumentScreen`, text / preview / content views, `SiteRenderer` | `react-native-gesture-handler` + `react-native-reanimated` (zoom) |
| `/hooks` | `useFolders`, `useFolder`, `useDocuments`, `useDocument`, `useDocumentText`, `useDocumentSite`, `useOutbox` | `@react-native-community/netinfo` |
| `/storage` | `createMemoryAdapter`, `StorageAdapter` type | none |
| `/storage/asyncstorage` | `createAsyncStorageAdapter` | `@react-native-async-storage/async-storage` |
| `/storage/sqlite` | `createSqliteAdapter` | `expo-sqlite` |
| `/theme` | `lightTheme`, `darkTheme`, `createTheme`, `loadShelfFonts` | `expo-font` |

"Can use" means: the peer is loaded lazily and only when that feature runs. A missing peer throws
`ShelfMissingPeerError` (fields `packageName`, `installCommand`) at use, not at import or render, and Metro does not
fail the bundle for it (the loaders are guarded `require`s that Metro treats as optional dependencies). The exceptions
are noted in [docs/entries.md](docs/entries.md).

## Expo setup

There is no config plugin in this package: native permissions come from the plugins of the peers you install.

Camera and photo-library use (`expo-image-picker`), in `app.json`:

```json
{
  "expo": {
    "plugins": [
      ["expo-image-picker", {
        "cameraPermission": "Take photos of documents to send to Shelf.",
        "photosPermission": "Choose photos to send to Shelf.",
        "microphonePermission": false
      }]
    ]
  }
}
```

- **Camera** (iOS `NSCameraUsageDescription`, Android `CAMERA`) and **photo library** (iOS `NSPhotoLibraryUsageDescription`)
  are the only permissions. Photos are chosen through the system picker.
- **Microphone is not needed.** The SDK only takes still images; set `"microphonePermission": false` so the plugin does not
  add `NSMicrophoneUsageDescription` / `RECORD_AUDIO` and your store review has nothing to explain.
- The copy strings above are examples. Say what the app does with the pictures; App Review reads them.
- `expo-document-picker` needs no permission (the system file UI grants access).
- Scan mode (`react-native-document-scanner-plugin`) and `expo-sqlite` need a **development build**
  (`npx expo prebuild` / EAS), not Expo Go. Add the scanner's camera permission as above.
- After adding plugins or native peers, rebuild the native app; a JS reload is not enough.
- If your proxy is plain `http://` during development, iOS needs an ATS exception and Android needs
  `usesCleartextTraffic`; use HTTPS for anything real. An Android emulator reaches your computer at `10.0.2.2`.

## Bare React Native setup

Install the peers with npm, then `npx pod-install` (iOS) and rebuild. Peers named `expo-*` need the Expo modules
installed in a bare app first (`npx install-expo-modules`).

`ios/<App>/Info.plist`:

```xml
<key>NSCameraUsageDescription</key>
<string>Take photos of documents to send to Shelf.</string>
<key>NSPhotoLibraryUsageDescription</key>
<string>Choose photos to send to Shelf.</string>
<!-- no NSMicrophoneUsageDescription: the SDK does not record audio -->
```

`android/app/src/main/AndroidManifest.xml`:

```xml
<uses-permission android:name="android.permission.CAMERA" />
<!-- no RECORD_AUDIO -->
```

Not using the Expo pickers? Pass your own source and keep your own permission flow:
`<CameraButton adapter={{ capture: async (request) => [{ uri, name, type }] }} />` (return `[]` for cancel, throw
`ShelfPermissionDeniedError` for a refused permission). `expo-camera` is not wrapped because it needs a viewfinder screen
of your own, so use this adapter with it.

## Storage, caching and sign-out

The cache is **local-first (stale-while-revalidate)**: lists and documents render from the cache as soon as it is read,
a background request replaces them, and a failed refresh keeps what is shown (`offline` / `error` are set).

- **Adapters** implement `StorageAdapter` (`get`, `set`, `delete`, `list(prefix)`). `createMemoryAdapter()` (`/storage`),
  `createAsyncStorageAdapter()` and `createSqliteAdapter()` (own subpaths so unused ones never load). Pass one as
  `storage` with a `cacheScope` (the user id) to persist the cache and the upload queue. Without both, the cache is
  memory-only and the queue does not survive a restart.
- **Keys** are `shelf:v1:<hash(baseUrl + cacheScope)>:<key>`; the raw scope is never stored. One entry is capped at
  1.5 MiB (a document's `parsed_text` is dropped first).
- **Opt out** with `offline={{ enabled: false }}`: nothing is persisted or served from the cache.
- **Freshness**: `offline={{ staleMs }}` (default 30 s). The host should call `swr.revalidateAll()` when the app returns to
  the foreground (`AppState`); NetInfo reconnect does it for uploads.

**Auth loss versus sign-out.** On a 401 / `not_configured` the SDK purges the read cache (a revoked key must not keep
showing stale data as live) but keeps the upload queue. Sign-out is the one thing that clears the queue.

**On sign-out, clear what the device kept, in one call:**

```ts check
import { clearAll, type StorageAdapter } from '@pj-slf-998231/sdk-react-native';

declare const storage: StorageAdapter, baseUrl: string, userId: string;

await clearAll({ storage, baseUrl, cacheScope: userId }); // omit the scope args to clear every user
// same as clearCache({ storage, baseUrl, cacheScope: userId, everything: true })
```

`clearAll` clears the cached listings and details, the thumbnails (the default thumbnail cache when you use `/documents`;
pass `thumbnails: myCache` to also clear one you injected) and the persisted upload queue, including live outboxes in
memory (running uploads are aborted). It never touches the files the queued URIs point at and never rejects. A scoped
call leaves other users' data alone. Plain `clearCache()` is narrower: it clears only the read cache and **keeps the queue
and thumbnails**. Also drop your own session token.

How it reaches `/documents` and `/upload` without breaking the entry graph: the root entry owns `clearAll`, and those
entries register themselves with it (`registerClearAllHook`) when they are loaded, so `camera`, `picker` and `upload` do
not import `documents`. An app that never loads `/documents` simply has no default thumbnail cache to clear.

## One onAuthLost per episode

A burst of requests with a dead credential (ten list fetches, three uploads, a thumbnail grid) all fail with 401 or the
proxy's 503 `not_configured`. The host's `onAuthLost` is called **once**, not once per request.

- An **episode** starts at the first 401 / 503 `not_configured` seen through a client. While it is open, further refusals
  still reject to their own callers (and keep the outbox paused) but do not call `onAuthLost` again.
- It **ends** when auth is known good again: a successful authenticated request that began after the episode opened, an
  explicit `resume()` (the outbox's, or `getAuthSession(client).resume()`), or `getHeaders` returning a different
  credential. A refusal after that is a new episode and calls `onAuthLost` again.
- The state is keyed by the **client object**, so it holds for a client you inject (`client={...}` on a provider or any
  entry, `createOutbox({ client })`), for two `<ShelfProvider>`s or components sharing that client, and for the outbox and
  the hooks together. A callback function passed to several of them is called once; distinct callbacks are called once each.
  Share the client itself: a copy (`{ ...client }`) is a different client with its own episode.
- "Different credential" is decided by a **fingerprint** of what `getHeaders` returns: SHA-256 over the header names and
  values, truncated to 64 bits (16 hex chars). The credential is never stored or logged; the fingerprint is kept in memory and,
  for a paused outbox, in storage next to the queue (see the persisted pause above).

```ts check
import { getAuthSession, credentialFingerprint, type ShelfClient, type ShelfError } from '@pj-slf-998231/sdk-react-native';

declare const client: ShelfClient, error: ShelfError, token: string;

const session = getAuthSession(client);
session.onEpisode((e) => console.log(e.type));        // 'start' | 'end' (cause: success | resume | credential)
session.active;                                         // the open episode (reason, error, fingerprint) or null
session.reportAuthFailure(error);                       // for your own transport; true when it opened an episode
session.reportSuccess();                                // ends the episode
session.resume();                                       // the host fixed the credential
credentialFingerprint({ Authorization: token });        // 16 hex chars, non-reversible
```

A restart while the outbox is paused reopens the episode silently (`session.restoreEpisode`): the host was already told, so a
refused probe after a restart does not call `onAuthLost` again.

## Theme

Light by default. Dark is opt-in, and `'system'` follows the device only when you ask for it.

```tsx
<ShelfProvider theme="dark" ... />            // or 'light' (default) or 'system'
<ShelfProvider theme={createTheme({ colors: { accent: '#0a7' } })} ... />
<ShelfProvider themeOverrides={{ fonts: { sans: 'Geist' } }} ... />
```

Fonts are the host's job (defaults are the system font). `loadShelfFonts({ Geist: require('./Geist.ttf') })` is a
convenience over `expo-font`. Every button and list also takes a `theme` prop.

## Component and hook reference

The detailed behaviour of each part (props, retries, virtualisation, site blocks) is in the module docs:
`docs/decisions/0001-core-client.md` for the client and cache, and the TypeScript types shipped with each entry.
Short version of what matters in production:

- **Outbox**: persisted before upload, stable `client_ref` per item so a retry cannot create a second document, exponential
  backoff with jitter (1 s to 60 s, 8 attempts) for network errors, 408, 429 and 5xx, other 4xx fail at once, at most 3
  concurrent uploads, files streamed as `{ uri, name, type }` parts (nothing read into JS memory, no base64).
- **Capture buttons**: common props `folderId`, `onCaptured`, `onUploaded`, `onError`, `label`, `icon`, `theme`, `disabled`,
  `uploadMode` (`'outbox'` default, `'direct'`), `hideDenied`, and `children` as a node or a render prop. `useCaptureUpload`
  is the headless version.
- **Lists**: `DocumentList` is a `FlatList` with fixed-height items and `getItemLayout`; `listComponent="flashlist"` uses
  `@shopify/flash-list` if installed. Thumbnails load only for mounted rows, using the smallest rendition that covers the
  box. A 2,000-document folder rendered its first rows from cache in 4-10 ms in jest (`src/__tests__/perf.test.tsx`; a
  floor from Node, not a device number).
- **DocumentScreen**: tabs `text`, `preview`, `content` (`tabs`, `initialTab`); Content only when the document has a
  generated site; unknown site blocks are skipped and reported through `onUnknownBlock`.
- **Folder writes** render only when you pass a handler (`FolderHeader.onCreateFolder`, `FolderList.onRenameFolder` /
  `onDeleteFolder`). `client.createFolder` / `updateFolder` (rename, move) / `deleteFolder` call the integration API's
  `POST /folders`, `PATCH /folders/{id}` and `DELETE /folders/{id}`. They need a `read_write` key (a read key gets
  403 `forbidden`), work only inside the key's folder tree (anything outside is a 404 `not_found`, the same as a missing
  folder), never touch the key's own folder (403), and answer 409 `conflict` for a duplicate sibling name, a move into
  itself or nesting past 64 levels. Delete moves the folder and its documents to the owner's trash. `parent_id` cannot
  be `null`; leave it out to create directly in the key's folder.

### Confirm before deleting

The SDK never asks for you: `FolderCard`'s delete button calls `onDeleteFolder` at once, and `client.deleteFile` /
`deleteFolder` send the request as soon as they are called. Ask first, in the handler, with the same words Shelf web and
`@pj-slf-998231/sdk` use, so people know nothing is lost:

- A document: **Move <name> to the Shelf trash? You can restore it in Shelf.**
- A folder: **Move “<name>” and everything in it to the Shelf trash? You can restore it in Shelf.**

Name the confirming button **Confirm delete** and give it the destructive style; the other is **Cancel**.

```tsx
import { Alert } from 'react-native';
import { useShelf, type ShelfDocument, type ShelfFolder } from '@pj-slf-998231/sdk-react-native';

const confirm = (message: string, run: () => void) =>
  Alert.alert('Delete', message, [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Confirm delete', style: 'destructive', onPress: run },
  ]);

export function useConfirmedDeletes(onError: (e: unknown) => void) {
  const { client } = useShelf();
  return {
    deleteDocument: (doc: ShelfDocument) =>
      confirm(`Move ${doc.filename} to the Shelf trash? You can restore it in Shelf.`, () => {
        client.deleteFile(doc.id).catch(onError);
      }),
    deleteFolder: (folder: ShelfFolder) =>
      confirm(`Move “${folder.name}” and everything in it to the Shelf trash? You can restore it in Shelf.`, () => {
        client.deleteFolder(folder.id).catch(onError);
      }),
  };
}

// <FolderList parentId={folderId} onDeleteFolder={deletes.deleteFolder} />
```

## Known limits

- **No upload progress with `fetch`.** `progress` is 0 while uploading and 1 when done. Supply
  `upload: (call) => ...` (for example an `XMLHttpRequest` uploader calling `call.onProgress`) for a real bar.
- **No per-folder read route.** `useFolder` derives from the folder list. Folder-write buttons are hidden unless you
  pass a handler, and the writes need a `read_write` key (see Folder writes above).
- **Scan is one image per page.** A multi-page scan is uploaded as separate JPEG documents; there is no PDF assembly.
- **Outbox `onUploaded` can be late** (it fires when the queued upload finishes) and only while the component is mounted.
- Not measured on a device: JS bundle load time, AsyncStorage / SQLite read time, image decoding, scroll frame rate.
- Scan mode and SQLite need a development build; they do not run in Expo Go.

## Troubleshooting

**`ShelfMissingPeerError: ... needs the optional peer "<pkg>"`.** The feature you used needs a peer you did not install.
The error carries `packageName` and `installCommand`. Install it (`npx expo install <pkg>`) and rebuild the native app.
It is thrown when the button or adapter is used, not at import. Or pass your own `adapter`.

**Metro: `Unable to resolve module @pj-slf-998231/sdk-react-native/camera`.** The package uses `exports` subpaths.
Metro enables package exports by default from Expo SDK 53 and React Native 0.79. On older setups set
`config.resolver.unstable_enablePackageExports = true` in `metro.config.js`, clear the cache (`npx expo start -c`), and
make sure TypeScript uses `"moduleResolution": "bundler"`. Developing against a local `file:` link? See
`example/metro.config.js` (`watchFolders`, one copy of `react`).

**Metro: `Unable to resolve module <peer>` from an SDK file.** A guarded optional `require` is bundled but the peer is
missing and Metro could not treat it as optional. Install that peer, or open an issue naming the entry.

**Everything is signed out / the queue stopped (401).** A 401, or the proxy's `503 not_configured`, means the integration
key was refused or revoked. The SDK purges its cached data, pauses the queue (`pauseReason` `'auth'` or
`'not_configured'`) and calls `onAuthLost` once per episode (see [One onAuthLost per episode](#one-onauthlost-per-episode)). **Queued, unsent files are kept**, in memory and in storage; no file is
lost. Fix the credential (sign in again, or restore the key on the server), then call `resume()` (from `useOutbox()` /
`useUpload()`) and the kept files upload, each once. Only `clearAll()` on sign-out discards them. The pause itself survives an app restart (the UI shows it at once; see the persisted pause above). Your own proxy
should return 401 only for an expired app session (refresh the token in `getHeaders` and retry) and never for a problem
with the Shelf key.

**Camera or photo access denied.** The button enters `denied`, shows an explanation with "Open Settings"
(`Linking.openSettings()`) and calls `onError(ShelfPermissionDeniedError)`. On iOS a refusal cannot be re-asked in-app; the
user must enable it in Settings. A missing `NSCameraUsageDescription` crashes the app on iOS: check
[Expo setup](#expo-setup) / [Bare setup](#bare-react-native-setup) and rebuild.

**Uploads stay "queued" on a device that is online.** Without `@react-native-community/netinfo` the SDK assumes online and
retries by timer only; with it installed but the network reported down, uploads wait. Check `useOnlineStatus()`.

**Queue lost after restart.** No persistent `storage` was given. Pass `createAsyncStorageAdapter()` or
`createSqliteAdapter()` to the provider.

**Android cannot reach a local proxy.** Use `http://10.0.2.2:<port>` on the emulator, your LAN IP on a device, and allow
cleartext traffic in development only.

## Example app and size report

- [`example/`](example/README.md): an Expo app that imports only `/camera`, with a dependency-free mock server.
- [`docs/size-report.md`](docs/size-report.md): exported bundle sizes against a no-SDK baseline, the marker check that list,
  document and folder code is absent, and the per-entry built sizes from `npm run check:size`.
- Contributing and release flow: [CONTRIBUTING.md](CONTRIBUTING.md), `CLAUDE.md`.

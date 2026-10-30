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
  "authorisation lost": `onAuthLost` fires, the cache is purged and the upload queue pauses (see
  [Troubleshooting](#troubleshooting)).

### Minimal Express proxy

This is a sketch to adapt, not a drop-in. It authenticates the caller (replace `requireUser` with your own), allows only
the integration routes, adds the key from the environment, and **streams** both directions so uploads are never buffered
in memory. Mount it **before** `express.json()` so request bodies are still unread streams.

```js
// shelf-proxy.mjs  (Node 18+, Express 4/5)
import express from 'express';
import { Readable } from 'node:stream';

const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
// Only the integration API's routes. Folder writes are deliberately absent (see Known limits).
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
];
const FORWARD_REQUEST = ['content-type', 'content-length', 'accept', 'if-none-match', 'range', 'if-range'];
const FORWARD_RESPONSE = ['content-type', 'content-length', 'content-disposition', 'etag', 'cache-control',
  'x-content-type-options', 'content-range', 'accept-ranges', 'last-modified', 'vary'];

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
  const key = process.env.SHELF_INTEGRATION_KEY ?? ''; // server-side secret; never sent to the app
  if (!base || !key) return fail(res, 503, 'not_configured', "Shelf isn't connected");

  const q = req.url.indexOf('?');
  const target = `${base}/api/v1/integration${req.path.replace(/\/+$/, '')}${q === -1 ? '' : req.url.slice(q)}`;
  const headers = { Authorization: `Bearer ${key}` };
  for (const h of FORWARD_REQUEST) if (req.headers[h] !== undefined) headers[h] = req.headers[h];

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), req.method === 'POST' ? 120_000 : 30_000);
  res.on('close', () => { clearTimeout(timer); if (!res.writableFinished) ctrl.abort(); }); // app went away: stop upstream too

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
  // Shelf refused the key: a configuration problem, never the app user's login problem. Tell the SDK so it stops.
  if (up.status === 401) { clearTimeout(timer); up.body?.cancel().catch(() => {}); return fail(res, 503, 'not_configured', "Shelf isn't connected"); }

  res.status(up.status);
  for (const h of FORWARD_RESPONSE) { const v = up.headers.get(h); if (v !== null) res.setHeader(h, v); }
  if (!up.body) return res.end();
  const body = Readable.fromWeb(up.body);
  body.on('error', () => res.destroy());
  body.pipe(res); // stream the response (thumbnails, originals) down
}

// app.js
const app = express();
app.use('/api/shelf', requireUser, shelfProxy); // requireUser: verify YOUR session first. Mount before express.json().
app.use(express.json());
```

Also: keep the key in your secret manager, give it the narrowest scope Shelf offers, rate-limit the route per user, set
a body size limit on your edge, and never log the `Authorization` header you add.

## Use only what you need

Each entry is its own import path and Metro bundles only what that path imports. These four are complete, working
shapes. `getHeaders` and `baseUrl` are the proxy settings from above.

### (a) A camera button only

Install the SDK and **only** `expo-image-picker` (photo mode). Import only `/camera`.

```sh
npm install @pj-slf-998231/sdk-react-native
npx expo install expo-image-picker
```

```tsx
import { CameraButton } from '@pj-slf-998231/sdk-react-native/camera';

<CameraButton baseUrl="https://api.example.com/api/shelf" getHeaders={() => ({ Authorization: `Bearer ${token}` })}
  onUploaded={(doc) => console.log(doc.id)} onError={(e) => console.warn(e.message)} />
```

Captured photos go through a persistent outbox, so one taken offline still arrives. `mode="scan"` additionally needs
`react-native-document-scanner-plugin` (development build, not Expo Go). Nothing from folders, documents, document or
the picker is bundled: [docs/size-report.md](docs/size-report.md) proves it on an exported iOS and Android bundle, and
`example/` is this exact app.

### (b) Picker and upload queue only

```sh
npx expo install expo-document-picker expo-image-picker @react-native-community/netinfo @react-native-async-storage/async-storage
```

```tsx
import { ShelfProvider } from '@pj-slf-998231/sdk-react-native';
import { createAsyncStorageAdapter } from '@pj-slf-998231/sdk-react-native/storage/asyncstorage';
import { DocumentPickerButton, PhotoLibraryButton } from '@pj-slf-998231/sdk-react-native/picker';
import { useOutbox } from '@pj-slf-998231/sdk-react-native/upload';
import { UploadStatusBadge, OfflineBanner } from '@pj-slf-998231/sdk-react-native/upload';

const storage = createAsyncStorageAdapter();

<ShelfProvider baseUrl={BASE_URL} getHeaders={getHeaders} storage={storage} cacheScope={userId}>
  <OfflineBanner />
  <DocumentPickerButton multiple type={['application/pdf', 'image/*']} folderId={folderId} />
  <PhotoLibraryButton multiple folderId={folderId} />
  <QueueList />
</ShelfProvider>

function QueueList() {
  const { items } = useOutbox();
  return items.map((i) => <UploadStatusBadge key={i.id} item={i} />);
}
```

With a persistent `storage` the queue survives an app restart. Without one it is memory-only. NetInfo makes uploads
wait while offline and retry on reconnect; without it the device is assumed always online.

### (c) Headless hooks

No UI from the SDK; you draw everything. Needs no optional peer (add a storage adapter if you want a persisted cache).

```tsx
import { ShelfProvider } from '@pj-slf-998231/sdk-react-native';
import { useFolder, useDocuments, useDocumentText } from '@pj-slf-998231/sdk-react-native/hooks';

function Docs({ folderId }: { folderId: string }) {
  const { items, loading, error, offline, hasMore, loadMore } = useDocuments(folderId, { pageSize: 30 });
  // items: cached data first, then replaced by the network (stale-while-revalidate)
  return <MyList data={items} onEnd={hasMore ? loadMore : undefined} />;
}
```

`hooks` also re-exports `useOutbox` / `useOnlineStatus`, which is why it pulls the upload code. Use the client directly
(`createShelfClient`, root entry) if you want no hooks at all.

### (d) A full folder browser

```sh
npx expo install @shopify/flash-list expo-file-system react-native-gesture-handler react-native-reanimated \
  @react-native-async-storage/async-storage @react-native-community/netinfo
```

```tsx
import { FolderHeader, FolderList } from '@pj-slf-998231/sdk-react-native/folders';
import { DocumentList } from '@pj-slf-998231/sdk-react-native/documents';
import { DocumentScreen } from '@pj-slf-998231/sdk-react-native/document';

// <ShelfProvider ...> at the root, wrapped in <GestureHandlerRootView> for pinch-to-zoom
function Browser({ folderId, onOpenFolder, onOpenDocument }) {
  return (
    <>
      <FolderHeader folderId={folderId} onNavigate={(f) => onOpenFolder(f?.id)} />
      <FolderList parentId={folderId} onPressFolder={(f) => onOpenFolder(f.id)} />
      <DocumentList folderId={folderId} variant="card" columns={2} listComponent="flashlist" onPressDocument={(d) => onOpenDocument(d.id)} />
    </>
  );
}
const Detail = ({ documentId }) => <DocumentScreen documentId={documentId} />;   // Text / Preview / Content tabs
```

Add `<PhotoLibraryButton>`, `<CameraButton>` or `<DocumentPickerButton>` beside them for capture.

## Entries and optional peers

Import path = package name + the subpath. The root entry (`@pj-slf-998231/sdk-react-native`) has the client, cache,
provider, theme tokens and errors, and no UI. Details and the build-time guarantees are in
[docs/entries.md](docs/entries.md).

| Entry | Gives you | Optional peers it can use |
|---|---|---|
| `.` | `createShelfClient`, `ShelfProvider`, `useShelf`, `clearCache`, errors, theme tokens | none |
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

**On sign-out, clear what the device kept:**

```ts
import { clearCache } from '@pj-slf-998231/sdk-react-native';
import { getDefaultThumbnailCache } from '@pj-slf-998231/sdk-react-native/documents'; // only if you use /documents

await clearCache({ storage, baseUrl, cacheScope: userId }); // cached listings and details (omit scope args for every user)
await getDefaultThumbnailCache().clear();                    // thumbnail pictures on disk
```

`clearCache` covers data, not pictures: the thumbnail disk cache (LRU, 64 MB, optional `expo-file-system`) is a separate
call. Also drop your own session token. `clearCache` removes only cached data; the persisted upload queue is separate, so
signing out with unsent uploads leaves them for the next user of that scope: wait for the queue to drain or discard it
yourself.

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
  `onDeleteFolder`).

## Known limits

- **No upload progress with `fetch`.** `progress` is 0 while uploading and 1 when done. Supply
  `upload: (call) => ...` (for example an `XMLHttpRequest` uploader calling `call.onProgress`) for a real bar.
- **Folder writes need API support.** Integration keys have no folder create / rename / delete (and no per-folder read route;
  `useFolder` derives from the list). The buttons are hidden unless you pass a handler, and `client.createFolder` etc.
  only work behind a credential or proxy that maps to the owner API.
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
key was refused or revoked. The SDK purges its cached data, **drops the queued, unsent files** (they are removed from
storage too, because nothing queued can succeed with that key), pauses the queue, and calls `onAuthLost`. Fix the key on
the server, then call `resume()` (from `useOutbox()` / `useUpload()`) and have the user capture again. Your own proxy
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

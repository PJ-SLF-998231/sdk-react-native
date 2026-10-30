# 0001. Core client: vendor a React Native client, do not depend on `@pj-slf-998231/sdk`

Status: accepted (U2). Date: 2026-10-30.

## Decision

Vendor a small, pure client in `src/core` (ported from the web SDK's `src/client.ts` and `types.ts`, branch
`feat/0.4-u1-foundations`) instead of importing the `@pj-slf-998231/sdk` root entry. Port the cache's
stale-while-revalidate engine the same way, over a new `StorageAdapter` instead of IndexedDB.

## Why not depend on the web SDK's root entry

Checked against `/Users/mother/Git/shelf-sdk` (client.ts, types.ts, cache/, storage/db.ts, README):

1. **Credentials.** `createShelfClient({ baseUrl, apiKey, fetch })` takes a static `apiKey` string. This SDK must take
   `getHeaders()` (async allowed) and never a raw key prop, so tokens can rotate and live in the host's secure store.
2. **Uploads.** `upload(file: Blob, ...)` does `form.append('file', blob, name)`. On React Native the file is a
   `{ uri, name, type }` part that the native networking layer streams from disk. Building a Blob in JS (usually from
   base64) copies the whole file through the JS thread and is the failure mode to avoid. The web signature cannot
   express it.
3. **Browser-only request options.** Every request sets `credentials: 'same-origin'` and uses the `Headers` class and
   `Response.arrayBuffer` assumptions made for browsers. Harmless but wrong for RN, where a Bearer header is the only
   auth and cookies are not the model.
4. **DOM/IndexedDB in the graph.** The root entry re-exports `clearCache`, which lazily imports `cache/clearImpl` ->
   `storage/db.ts` (IndexedDB) and `BroadcastChannel`; `swr.ts` attaches `window`/`document` listeners. The import
   graph rule for this repo (no DOM/IndexedDB in any bundle, `scripts/check-entry-graph.mjs`) cannot hold with that
   entry, and Metro would still have to parse the IndexedDB module.
5. **Distribution.** The package is private on GitHub Packages. A hard dependency makes `npm ci` in CI and in every
   consumer app need a registry token. Vendoring keeps this package self-contained.
6. **Release coupling.** The web SDK is on its own 0.x cadence with web-only breaking changes (proxy semantics, CSS,
   fonts). A copied ~200-line client is cheaper than tracking them.

The client itself (routes, `ShelfError`, `isAuthLost`, `isOfflineError`, list/item normalisation, 304 thumbnail
handling) is pure `fetch` and is kept semantically identical so behaviour and error codes match the web SDK.

## What differs from the web client

- `getHeaders()` instead of `apiKey`; `onAuthLost` callback on the client; no `credentials` option.
- `upload()` accepts `{ uri, name, type }` (streamed) or a `Blob`; `client_ref` is a multipart field.
- `authedSource(url)` returns `{ uri, headers }` for `<Image source>` because auth is a header, not a cookie.
- Cache is on a `StorageAdapter` (memory, AsyncStorage, expo-sqlite); no BroadcastChannel, no window/focus events.
  The host wires `swr.revalidateAll()` to `AppState` `active` and NetInfo reconnect.
- Cache keys are `shelf:v1:<hash(baseUrl + cacheScope)>:<key>`; the raw scope is never stored. Same 1.5 MiB entry cap,
  dropping a document's `parsed_text` first.

## API coverage and a mismatch worth knowing

The Shelf API's integration routes (`api/internal/integrations/reach.go`) are `GET /`, `GET /folders`, `GET /files`,
`GET /files/{id}`, `POST /files`, `PATCH /files/{id}`, `DELETE /files/{id}`, and (since the folder-write release)
`POST /folders`, `PATCH /folders/{id}`, `DELETE /folders/{id}`. The thumbnail, original and site routes come through the
web SDK's proxy recipe. There is **no** separate text route:

- `getText(id)` reads `parsed_text` from `GET /files/{id}`.
- `createFolder` / `updateFolder` / `deleteFolder` call the integration routes above (`read_write` keys only, subtree
  scoped; see README "Folder writes" for the status codes). **Addendum:** this section first said the integration API
  had no folder writes and that they would 404/403 with a `shelf_ik_` key. That was true when written and is no longer;
  the contract is pinned by `src/__tests__/folderWrites.test.ts`. Folder-write UI is still opt-in through handlers.

## Optional peers

`expo-sqlite`, `@react-native-async-storage/async-storage` and `expo-font` are optional peers, `require`d lazily inside
the adapter factory (and from separate subpaths `/storage/asyncstorage`, `/storage/sqlite`). A missing peer throws
`MissingPeerError` with the install command. tsup/esbuild rewrites `require("peer")` to a `__require` shim that Metro
cannot see, so `scripts/fix-optional-requires.mjs` restores the literal call after the build and fails the build if it
cannot.

## Revisit when

The web SDK splits a platform-neutral `@pj-slf-998231/sdk/core` entry with injectable auth and storage; then this
folder can be replaced by that dependency.

## Addendum (U3): entry-graph and provider changes

- The `upload` entry may reach `core`, `storage`, `theme` and `provider`; `check:size` now fails it if it reaches
  `folders`, `documents`, `document`, `camera` or `picker`. No allow-list entry was added.
- `ShelfContextValue` gained `storage` and `scope` (the host's values as given) so the outbox can persist on the
  provider's adapter. `@react-native-community/netinfo` joined the lazily required optional peers.

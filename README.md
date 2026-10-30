# @pj-slf-998231/sdk-react-native

React Native SDK for the Shelf integration API. Work in progress.

## Core (U2)

- `createShelfClient({ baseUrl, getHeaders, fetch?, onAuthLost? })`: typed client, `ShelfError`, `isAuthLost`, `isOfflineError`.
- Storage: `createMemoryAdapter()` from `/storage`; `createAsyncStorageAdapter()` from `/storage/asyncstorage`; `createSqliteAdapter()` from `/storage/sqlite`.
- Cache: `createCache({ storage, baseUrl, cacheScope })`, `createSwr(cache)`, `clearCache()` (call on sign-out).
- Theme (`/theme`): light by default, `'dark'` opt-in, `'system'` only when asked; fonts are the host's job.
- `<ShelfProvider>` is optional; entries resolve their client through `useShelf({ client })` or `useShelf({ baseUrl, getHeaders })`.

See `docs/decisions/0001-core-client.md`.

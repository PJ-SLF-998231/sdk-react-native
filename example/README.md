# Example: camera button only

A small Expo app whose only SDK import is `@pj-slf-998231/sdk-react-native/camera` (`CameraButton`). Its only SDK-related
dependency is `expo-image-picker`. It exists to prove that the camera entry bundles on its own: no folder, document, list
or picker code, and none of their optional peers installed. See [`../docs/size-report.md`](../docs/size-report.md).

This directory has its own `package.json` and lockfile and is **not** part of the root package, typecheck, tests or build.
The SDK is linked with `"@pj-slf-998231/sdk-react-native": "file:.."` and `metro.config.js` watches the repo and keeps a single
copy of `react`.

## Run it

```sh
# 1. build the SDK (the example consumes ../dist)
cd .. && npm ci && npm run build && cd example

# 2. install and start the mock proxy (no dependencies, no Shelf account)
npm install
npm run mock            # http://localhost:8787/api/shelf, accepts POST /files multipart and answers like the API

# 3. in another terminal
npx expo start          # needs a development build or the Expo Go app for expo-image-picker
```

The mock needs any `Authorization: Bearer ...` header (the app sends `Bearer demo-session`), prints each upload it
receives (name, size, `client_ref`) and stores nothing. On an Android emulator use `10.0.2.2` instead of `localhost`; on a
device use your computer's LAN IP; plain `http://` needs cleartext allowed in development.

## Point it at a real proxy

Set `EXPO_PUBLIC_SHELF_BASE_URL` to your proxy (the `baseUrl`, including its path prefix) and change `getHeaders` in
`App.js` to return your app's own session token:

```sh
EXPO_PUBLIC_SHELF_BASE_URL=https://api.example.com/api/shelf npx expo start
```

The proxy holds the `shelf_ik_` key. **Never put a Shelf key in this app**; there is no prop for it. A proxy sketch is in the
[root README](../README.md#security-model-read-this-first).

## Verify the bundle

```sh
npx expo export --platform ios --output-dir dist-ios       # also: --platform android
node scripts/size-report.mjs                               # both platforms, baseline, marker check; rewrites ../docs/size-report.md
```

`baseline/` is the same screen without the SDK, used only for the size comparison.

# Contributing

- Work happens on a branch and lands through a pull request. Never push to `main`.
- Every PR must pass CI (typecheck, test, build, `check:size`, gitleaks) before merge.
- Releases: bump `version` in `package.json`, merge, then push a tag `vX.Y.Z` equal to it; `release.yaml` publishes to GitHub Packages. Do not publish from a laptop.
- Never commit secrets or tokens.
- `scripts/check-entry-graph.mjs` guards entry boundaries: the `camera` and `picker` entries may reach only core, cache, provider, theme, upload and the shared capture helpers (and storage/memory via upload), never folders, documents, document, hooks or the storage adapters, except via the explicit allow-list, and no entry may import react-dom, indexedDB or CSS.

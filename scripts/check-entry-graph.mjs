// Builds the import graph per entry from src/, enforces the allow-list rules,
// then reports each entry's built bytes from dist/ (run `npm run build` first).
import { readFileSync, existsSync, statSync } from "node:fs";
import { dirname, join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "src");
const ENTRIES = ["camera", "picker", "upload", "folders", "documents", "document", "hooks", "storage", "theme", "storage/asyncstorage", "storage/sqlite"];
const FORBIDDEN_SPECIFIERS = [/^react-dom($|\/)/, /indexeddb/i, /\.css$/i];
const DOM_IN_BUNDLE = [/\bindexedDB\b/, /\bIDB(Database|Factory|Request|Transaction)\b/, /\bdocument\.(createElement|getElementById|querySelector|body|head)\b/, /\bwindow\.(addEventListener|location|localStorage)\b/, /\blocalStorage\b/];
// camera and picker may reach only these areas (plus themselves): the client (core), caching and the provider that
// upload needs, theme, upload, and the small shared capture helpers. Everything else (folders, documents, document,
// hooks, the storage adapters) is list/document code and must stay out of their bundles.
const CAPTURE_ENTRIES = { camera: "picker", picker: "camera" };
const CAPTURE_ALLOWED_AREAS = new Set(["core", "cache", "provider", "theme", "upload", "shared"]);
// storage/ is allowed only for what upload's default (memory) adapter needs; asyncstorage and sqlite stay out.
const CAPTURE_ALLOWED_STORAGE_FILES = new Set(["storage/memory.ts", "storage/types.ts"]);
const UPLOAD_FORBIDDEN_DIRS = ["folders", "documents", "document", "camera", "picker", "hooks"];
// Browsing entries are list/document code. They may use core, cache, provider, theme, hooks, shared helpers and (hooks only)
// the upload outbox hooks, but never the capture entries or the document-detail entry, and folders/documents do not reach
// each other (a host that shows only one of them should not ship the other).
const BROWSE_FORBIDDEN_AREAS = {
  folders: ["camera", "picker", "document", "documents", "upload"],
  documents: ["camera", "picker", "document", "folders", "upload"],
  hooks: ["camera", "picker", "document", "folders", "documents"],
};
// Names that must not appear in the built browsing entries (capture code and its optional peers), and that must appear
// in the entry that owns them, so the marker check can never pass vacuously on an empty bundle.
const CAPTURE_CODE_MARKERS = ["CameraButton", "DocumentPickerButton", "PhotoLibraryButton", "useCaptureUpload", "expo-image-picker", "expo-document-picker", "react-native-document-scanner-plugin", "expo-camera"];
const REQUIRED_MARKERS = {
  folders: ["FolderList", "FolderCard", "FolderBreadcrumb", "FolderHeader"],
  documents: ["DocumentList", "DocumentRow", "DocumentCard", "createFileThumbnailCache", 'require("expo-file-system/legacy")', 'require("@shopify/flash-list")'],
  hooks: ["useFolders", "useFolder", "useDocuments", "useDocumentText", "useDocumentSite", "useOutbox"],
  camera: ["CameraButton"],
  picker: ["DocumentPickerButton"],
};
// Explicit allow-list: "<entry> -> <area>" edges that are permitted. Keep empty unless justified.
const ALLOW = new Set([]);
const { gzipSync } = await import("node:zlib");

const importRe = /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|require\(\s*['"]([^'"]+)['"]\s*\)/g;

function resolveFile(from, spec) {
  const base = resolve(dirname(from), spec);
  for (const c of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]) {
    if (existsSync(c) && statSync(c).isFile()) return c;
  }
  return null;
}

function graph(entryFile) {
  const files = new Set();
  const bare = new Set();
  const stack = [entryFile];
  while (stack.length) {
    const f = stack.pop();
    if (files.has(f)) continue;
    files.add(f);
    const text = readFileSync(f, "utf8");
    for (const m of text.matchAll(importRe)) {
      const spec = m[1] ?? m[2] ?? m[3] ?? m[4];
      if (spec.startsWith(".")) {
        const r = resolveFile(f, spec);
        if (r) stack.push(r);
        else bare.add(spec);
      } else bare.add(spec);
    }
  }
  return { files, bare };
}

// Names that exist only in list/document code; if one shows up in a camera/picker build, the graph leaked.
const LIST_CODE_MARKERS = ["FolderList", "FolderCard", "FolderBreadcrumb", "FolderHeader", "DocumentList", "DocumentRow", "DocumentCard", "useFolders", "useFolder", "useDocuments", "useDocumentText", "useDocumentSite", "createFileThumbnailCache", "createMemoryThumbnailCache", "@shopify/flash-list", "expo-file-system"];

// The built entry plus the shared chunks it imports (relative imports/requires in dist).
function builtGraph(entryJs) {
  const seen = new Set();
  const stack = [entryJs];
  let bytes = 0;
  const all = [];
  while (stack.length) {
    const f = stack.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    const buf = readFileSync(f);
    bytes += buf.length;
    all.push(buf);
    for (const m of buf.toString("utf8").matchAll(/(?:from|import)\s*["'](\.[^"']+)["']/g)) {
      const r = resolve(dirname(f), m[1]);
      if (existsSync(r) && statSync(r).isFile()) stack.push(r);
    }
  }
  return { files: seen, bytes, gzip: gzipSync(Buffer.concat(all)).length };
}

const errors = [];
const rows = [];
const areaReports = [];
for (const entry of ["index", ...ENTRIES]) {
  // An entry is src/<entry>/index.ts, or src/<entry>.ts for subpaths such as storage/sqlite.
  const file = entry === "index" ? join(src, "index.ts") : [join(src, entry, "index.ts"), join(src, `${entry}.ts`)].find(existsSync) ?? join(src, entry, "index.ts");
  if (!existsSync(file)) { errors.push(`missing source entry ${relative(root, file)}`); continue; }
  const { files, bare } = graph(file);
  for (const spec of bare) {
    if (FORBIDDEN_SPECIFIERS.some((re) => re.test(spec))) errors.push(`${entry}: forbidden import "${spec}"`);
  }
  // Built output must not touch the DOM or IndexedDB (React Native has neither).
  const built = join(root, "dist", `${entry}.js`);
  if (existsSync(built)) {
    const code = readFileSync(built, "utf8");
    for (const re of DOM_IN_BUNDLE) if (re.test(code)) errors.push(`${entry}: built bundle matches ${re}`);
  }
  if (entry in CAPTURE_ENTRIES) {
    for (const f of files) {
      const rel = relative(src, f);
      const area = rel.split("/")[0];
      if (area === entry) continue;
      if (area === CAPTURE_ENTRIES[entry]) { errors.push(`${entry} reaches ${relative(root, f)} (the ${area} entry)`); continue; }
      if (area === "storage" ? CAPTURE_ALLOWED_STORAGE_FILES.has(rel) : CAPTURE_ALLOWED_AREAS.has(area)) continue;
      if (!ALLOW.has(`${entry} -> ${area}`)) errors.push(`${entry} reaches ${relative(root, f)} (area "${area}") without allow-list entry`);
    }
  }
  if (entry in BROWSE_FORBIDDEN_AREAS) {
    for (const f of files) {
      const area = relative(src, f).split("/")[0];
      if (BROWSE_FORBIDDEN_AREAS[entry].includes(area)) errors.push(`${entry} reaches ${relative(root, f)} (area "${area}")`);
    }
  }
  if (entry === "upload") {
    // The upload entry may use core, storage, theme and provider, but not the folder/document browsing UI.
    for (const f of files) {
      const area = relative(src, f).split("/")[0];
      if (UPLOAD_FORBIDDEN_DIRS.includes(area)) errors.push(`upload reaches ${relative(root, f)} (area "${area}")`);
    }
  }
  const out = join(root, "dist", `${entry}.js`);
  const srcBytes = [...files].reduce((n, f) => n + statSync(f).size, 0);
  const bg = existsSync(out) ? builtGraph(out) : null;
  if ((entry in CAPTURE_ENTRIES || entry === "upload") && bg) {
    for (const f of bg.files) {
      const text = readFileSync(f, "utf8");
      for (const marker of LIST_CODE_MARKERS) if (text.includes(marker)) errors.push(`${entry}: built file ${relative(root, f)} contains list/document code (${marker})`);
    }
  }
  if (bg && entry in BROWSE_FORBIDDEN_AREAS) {
    for (const f of bg.files) {
      const text = readFileSync(f, "utf8");
      for (const marker of CAPTURE_CODE_MARKERS) if (text.includes(marker)) errors.push(`${entry}: built file ${relative(root, f)} contains capture code (${marker})`);
    }
  }
  if (bg && entry in REQUIRED_MARKERS) {
    const all = [...bg.files].map((f) => readFileSync(f, "utf8")).join("\n");
    for (const marker of REQUIRED_MARKERS[entry]) if (!all.includes(marker)) errors.push(`${entry}: built output is missing expected "${marker}" (empty or mis-built entry?)`);
  }
  if (entry in CAPTURE_ENTRIES) areaReports.push({ entry, areas: [...new Set([...files].map((f) => relative(src, f).split("/")[0]))].sort() });
  rows.push({ entry, files: files.size, srcBytes, bytes: existsSync(out) ? statSync(out).size : null, builtFiles: bg?.files.size ?? null, builtBytes: bg?.bytes ?? null, gz: bg?.gzip ?? null });
}

console.log("entry".padEnd(22), "src files".padEnd(10), "src bytes".padEnd(10), "built files".padEnd(12), "built bytes".padEnd(12), "gzip");
for (const r of rows) console.log(r.entry.padEnd(22), String(r.files).padEnd(10), String(r.srcBytes).padEnd(10), String(r.builtFiles ?? "n/a").padEnd(12), String(r.builtBytes ?? "n/a (not built)").padEnd(12), r.gz ?? "");
console.log("\ncamera/picker reach only these source areas (folders, documents, document, hooks and the storage adapters are excluded):");
for (const r of areaReports) console.log(`  ${r.entry.padEnd(8)} ${r.areas.join(", ")}`);
if (rows.some((r) => r.bytes === null)) errors.push("dist is missing; run `npm run build` first");
if (errors.length) { console.error("\nFAILED:\n" + errors.map((e) => "  " + e).join("\n")); process.exit(1); }
console.log("\nentry graph OK");

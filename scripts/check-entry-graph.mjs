// Builds the import graph per entry from src/, enforces the allow-list rules,
// then reports each entry's built bytes from dist/ (run `npm run build` first).
import { readFileSync, existsSync, statSync } from "node:fs";
import { dirname, join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "src");
const ENTRIES = ["camera", "picker", "upload", "folders", "documents", "document", "hooks", "storage", "theme"];
const FORBIDDEN_SPECIFIERS = [/^react-dom($|\/)/, /indexeddb/i, /\.css$/i];
// Code areas the camera entry must not reach.
const CAMERA_FORBIDDEN_DIRS = ["folders", "documents", "document", "hooks", "storage"];
// Explicit allow-list: "<entry> -> <area>" edges that are permitted. Keep empty unless justified.
const ALLOW = new Set([]);

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

const errors = [];
const rows = [];
for (const entry of ["index", ...ENTRIES]) {
  const file = entry === "index" ? join(src, "index.ts") : join(src, entry, "index.ts");
  if (!existsSync(file)) { errors.push(`missing source entry ${relative(root, file)}`); continue; }
  const { files, bare } = graph(file);
  for (const spec of bare) {
    if (FORBIDDEN_SPECIFIERS.some((re) => re.test(spec))) errors.push(`${entry}: forbidden import "${spec}"`);
  }
  if (entry === "camera") {
    for (const f of files) {
      const area = relative(src, f).split("/")[0];
      if (CAMERA_FORBIDDEN_DIRS.includes(area) && !ALLOW.has(`camera -> ${area}`)) {
        errors.push(`camera reaches ${relative(root, f)} (area "${area}") without allow-list entry`);
      }
    }
  }
  const out = join(root, "dist", `${entry}.js`);
  rows.push({ entry, files: files.size, bytes: existsSync(out) ? statSync(out).size : null });
}

console.log("entry".padEnd(12), "src files".padEnd(10), "built bytes (esm)");
for (const r of rows) console.log(r.entry.padEnd(12), String(r.files).padEnd(10), r.bytes ?? "n/a (not built)");
if (rows.some((r) => r.bytes === null)) errors.push("dist is missing; run `npm run build` first");
if (errors.length) { console.error("\nFAILED:\n" + errors.map((e) => "  " + e).join("\n")); process.exit(1); }
console.log("\nentry graph OK");

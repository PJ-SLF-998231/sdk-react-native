// esbuild turns `require("peer")` in ESM/CJS output into a `__require` shim that Metro cannot see, so the optional
// peer would never be bundled. Put the literal `require("peer")` back for the lazily loaded optional peers.
import { readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const dist = join(resolve(dirname(fileURLToPath(import.meta.url)), ".."), "dist");
const PEERS = ["expo-sqlite", "expo-font", "@react-native-async-storage/async-storage"];
const re = new RegExp(`(?:\\b_chunk\\w+\\.)?__require(?:\\.call\\(void 0, |\\()("(?:${PEERS.map((p) => p.replace(/[/-]/g, "\\$&")).join("|")})")\\)`, "g");

const seen = new Set();
function walk(dir) {
  for (const n of readdirSync(dir)) {
    const f = join(dir, n);
    if (statSync(f).isDirectory()) walk(f);
    else if (/\.(js|cjs)$/.test(n)) {
      const text = readFileSync(f, "utf8");
      const out = text.replace(re, (_, q) => (seen.add(q), `require(${q})`));
      if (out !== text) writeFileSync(f, out);
    }
  }
}
walk(dist);
const missing = PEERS.filter((p) => !seen.has(`"${p}"`));
if (missing.length) { console.error("fix-optional-requires: no require found for", missing.join(", ")); process.exit(1); }
console.log("optional peer requires restored:", [...seen].join(" "));

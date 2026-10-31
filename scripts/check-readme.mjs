// Type-checks the README's examples against the built package, so the README cannot contradict the code. Fenced blocks
// whose info string is `tsx check` (or `ts check`) are written to .build/readme/ and compiled with `tsc -p test/docs`
// (moduleResolution bundler, strict), importing '@pj-slf-998231/sdk-react-native/...' exactly as an app would, against
// dist. Run `npm run build` first. Usage: node scripts/check-readme.mjs
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

process.chdir(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
if (!existsSync("dist/index.d.ts")) {
  console.error("check-readme: dist is missing; run npm run build first");
  process.exit(1);
}
const readme = readFileSync("README.md", "utf8");
const blocks = [...readme.matchAll(/^```(tsx|ts) check\n([\s\S]*?)^```/gm)];
// The four "Use only what you need" shapes at least; a lost marker must not make the check pass on nothing.
if (blocks.length < 4) {
  console.error(`check-readme: expected at least the four "Use only what you need" examples, found ${blocks.length} checked blocks`);
  process.exit(1);
}
const dir = ".build/readme";
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
// Each block is its own module (export {} keeps a block without imports from sharing the global scope).
blocks.forEach((m, i) => writeFileSync(`${dir}/block-${String(i + 1).padStart(2, "0")}.${m[1]}`, `${m[2]}\nexport {};\n`));
const r = spawnSync("npx", ["tsc", "-p", "test/docs"], { stdio: "inherit" });
if (r.status !== 0) {
  console.error("check-readme: a README example does not type-check (files in .build/readme/)");
  process.exit(r.status ?? 1);
}
console.log(`check-readme: ok (${blocks.length} README examples type-check against dist)`);

import { defineConfig } from "tsup";

const entries = ["camera", "picker", "upload", "folders", "documents", "document", "hooks", "storage", "theme"];

export default defineConfig({
  entry: {
    index: "src/index.ts",
    ...Object.fromEntries(entries.map((e) => [e, `src/${e}/index.ts`])),
  },
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: false,
  target: "es2020",
  splitting: true,
  external: [/^react($|\/)/, /^react-native($|\/)/, /^expo/, /^@react-native/, /^@shopify\//, "react-native-document-scanner-plugin"],
});

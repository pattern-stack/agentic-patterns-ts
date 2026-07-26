import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: {
    compilerOptions: {
      composite: false,
    },
  },
  sourcemap: true,
  clean: true,
  // `providers/cc-shim.ts` calls `createRequire(import.meta.url)` to resolve the
  // MCP SDK by absolute path. esbuild does NOT shim `import.meta` for cjs on its
  // own — it emits `var import_meta = {}`, so `import.meta.url` is `undefined`
  // and `createRequire` throws ERR_INVALID_ARG_VALUE on first require of the
  // CJS build. `shims: true` makes tsup inject the real shim
  // (`pathToFileURL(__filename).href`) into the cjs output, which is what
  // cc-shim.ts already assumed was happening.
  shims: true,
  // `bun:sqlite` is a Bun built-in loaded dynamically by storage/load.ts
  // under Bun. Mark it external so esbuild leaves the import intact instead
  // of trying to resolve it at build time (it does not exist under Node).
  external: ["bun:sqlite"],
});

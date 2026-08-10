import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: {
    compilerOptions: {
      composite: false,
    },
  },
  sourcemap: true,
  clean: true,
  // `bun:sqlite` is a Bun built-in loaded dynamically by storage/load.ts
  // under Bun. Mark it external so esbuild leaves the import intact instead
  // of trying to resolve it at build time (it does not exist under Node).
  // `vitest` is an optional peer loaded dynamically by memory/conformance.ts
  // only when a test file runs the conformance kit — peers are auto-external
  // in tsup, but the explicit entry documents intent.
  external: ["bun:sqlite", "vitest"],
});

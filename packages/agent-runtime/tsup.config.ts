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
  external: ["bun:sqlite"],
});

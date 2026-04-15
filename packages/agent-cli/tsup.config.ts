import { defineConfig } from "tsup";

export default defineConfig({
  entry: { cli: "src/cli.ts" },
  format: ["esm"],
  target: "node20",
  outDir: "dist",
  clean: true,
  splitting: false,
  sourcemap: true,
  dts: false,
  // Add a Node shebang to the compiled cli.js so `bin` works directly.
  banner: { js: "#!/usr/bin/env node" },
});

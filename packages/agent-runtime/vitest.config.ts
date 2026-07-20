import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    passWithNoTests: true,
    // Contract tests need the codex binary + real auth — run via `bun run test:contract:codex`.
    exclude: ["**/node_modules/**", "**/dist/**", "contract-tests/**"],
  },
});

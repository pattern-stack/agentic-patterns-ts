import { defineConfig } from "vitest/config";

/**
 * Codex App Server contract tests (#321).
 *
 * NOT part of the default test run or CI: these tests spawn the real `codex`
 * binary and drive live turns against the authenticated ChatGPT/API account
 * found in ~/.codex/auth.json (copied into isolated CODEX_HOME dirs — the
 * host login is never mutated). Run explicitly with:
 *
 *   bun run --filter=@agentic-patterns/runtime test:contract:codex
 *
 * Requirements: codex CLI matching fixtures/manifest.json cliVersion on PATH,
 * and a logged-in ~/.codex/auth.json.
 */
export default defineConfig({
  test: {
    globals: true,
    include: ["contract-tests/codex/**/*.contract.test.ts"],
    testTimeout: 300_000,
    hookTimeout: 120_000,
    // live sessions against a real account — never parallelize
    fileParallelism: false,
    maxConcurrency: 1,
  },
});

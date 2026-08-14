import { defineConfig } from "vitest/config";

/**
 * Claude Code per-class enforcement contract tests (B-2 / #326).
 *
 * NOT part of the default test run or CI: these spawn the real Claude Code
 * subprocess via the Claude Agent SDK and drive live turns against THIS machine's
 * Max login (host `~/.claude`), model `haiku`, cheap deterministic prompts. Run
 * explicitly with:
 *
 *   bun run --filter=@pattern-stack/agentic-runtime test:contract:cc
 *
 * Requirements: `claude` CLI on PATH + a logged-in Claude Max subscription (or
 * ANTHROPIC_API_KEY). Mirrors the Codex harness placement (R-1): separate config,
 * excluded from `bun run test`.
 */
export default defineConfig({
  test: {
    globals: true,
    include: ["contract-tests/cc/**/*.contract.test.ts"],
    testTimeout: 180_000,
    hookTimeout: 60_000,
    // live sessions against a real account — never parallelize
    fileParallelism: false,
    maxConcurrency: 1,
  },
});

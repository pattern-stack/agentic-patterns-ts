/**
 * Verifies that the discovery + playground pipeline preserves an explicit
 * per-agent runner. We don't boot the full playground here (that would
 * spin up Hono, open ports, etc.) — we instead exercise `loadAgentFile`
 * (which normalizes the exported `runner`) and reproduce the one-line
 * mapping from `playground.ts` that the change introduced.
 *
 * Fixture files live in `./fixtures/*.agent.mjs` so vite's dynamic import
 * resolver can find them at test time (temp-dir files are not resolvable
 * through vite's module graph).
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadAgentFile } from "../../helpers/discover.js";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

describe("playground per-agent runner override", () => {
  it("propagates an explicit RunnerLike from the agent file", async () => {
    const discovered = await loadAgentFile(path.join(FIXTURES, "with-runner.agent.mjs"));
    expect(discovered.runner).toBeDefined();
    expect(typeof (discovered.runner as { run: unknown }).run).toBe("function");
  });

  it("propagates an explicit RunnerFactory from the agent file", async () => {
    const discovered = await loadAgentFile(path.join(FIXTURES, "with-factory.agent.mjs"));
    expect(discovered.runner).toBeDefined();
    expect(typeof (discovered.runner as { forConversation: unknown }).forConversation).toBe(
      "function",
    );
  });

  it("leaves runner undefined when the agent file does not export one", async () => {
    const discovered = await loadAgentFile(path.join(FIXTURES, "no-runner.agent.mjs"));
    expect(discovered.runner).toBeUndefined();
  });

  it("rejects an invalid runner shape", async () => {
    await expect(loadAgentFile(path.join(FIXTURES, "bad-runner.agent.mjs"))).rejects.toThrow(
      /runner/,
    );
  });

  it("reg.runner ?? shared — explicit wins, missing falls through", () => {
    // Mirrors the exact expression in playground.ts after the widening.
    const shared = Symbol("shared-runner");
    const explicit = Symbol("explicit-runner");

    const withExplicit: { runner?: symbol } = { runner: explicit };
    const withoutExplicit: { runner?: symbol } = {};

    expect(withExplicit.runner ?? shared).toBe(explicit);
    expect(withoutExplicit.runner ?? shared).toBe(shared);
  });
});

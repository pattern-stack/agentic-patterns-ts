/**
 * Companion REGISTRATION tests (#445 Gate 2.5 N5) — the only branching logic
 * the registration file carries (`memoryScopeOf`'s type guard + default-user
 * fallback + reserved agent key) plus the load-bearing store-identity
 * invariant (the store the toolbox writes through IS `reg.memory.store` —
 * turn-1 recall and memory_save must never diverge).
 *
 * Imports the REAL `agents/companion/agent.mjs`, which imports the runtime's
 * built `dist/` — skipped when dist hasn't been built (local partial runs);
 * CI's `check` always builds first. `AP_MEMORY_DB_PATH=":memory:"` keeps the
 * user's real memory db untouched; env is set before the dynamic import
 * because the agent file boots its store at module load.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { DiscoveredAgent } from "../discover.js";
import { loadAgentsFromFile } from "../discover.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../../../..");
const AGENT_FILE = path.join(ROOT, "agents/companion/agent.mjs");
const RUNTIME_DIST = path.join(ROOT, "packages/agent-runtime/dist/index.js");

process.env.AP_MEMORY_DB_PATH = ":memory:";
process.env.AP_USER = "reg-test-user";

describe.skipIf(!existsSync(RUNTIME_DIST))(
  "companion registration (agents/companion/agent.mjs)",
  () => {
    let cached: DiscoveredAgent | undefined;
    async function companionReg(): Promise<DiscoveredAgent> {
      if (!cached) {
        const found = await loadAgentsFromFile(AGENT_FILE, ROOT);
        cached = found[0];
      }
      if (!cached) throw new Error("companion not discovered");
      return cached;
    }

    it("derives the partition with the reserved agent key, honoring AP_USER and the type guard", async () => {
      const reg = await companionReg();
      const scopeFn = reg.memory?.scope as (
        ctx?: Record<string, unknown>,
      ) => Record<string, string>;
      expect(typeof scopeFn).toBe("function");
      expect(scopeFn()).toEqual({ user: "reg-test-user", agent: "companion" });
      expect(scopeFn({ user: "guest" })).toEqual({ user: "guest", agent: "companion" });
      // Non-string / empty user falls back to the default rather than binding
      // a garbage partition (documented consequence of the no-SessionScope
      // deviation — see the #445 issue comment).
      expect(scopeFn({ user: 123 })).toEqual({ user: "reg-test-user", agent: "companion" });
      expect(scopeFn({ user: "" })).toEqual({ user: "reg-test-user", agent: "companion" });
    });

    it("binds the SAME store into the instantiated toolbox as reg.memory.store (the shared-store invariant)", async () => {
      const reg = await companionReg();
      const agent = await reg.instantiate?.({ user: "guest" });
      const capabilities = (
        agent as {
          role: {
            capabilities: Array<{
              toolbox?: { name: string; execute: (t: string, a: unknown) => Promise<unknown> };
            }>;
          };
        }
      ).role.capabilities;
      const memoryCap = capabilities.find((c) => c.toolbox?.name === "Memory");
      expect(memoryCap).toBeDefined();

      await memoryCap?.toolbox?.execute("memory_save", {
        kind: "fact",
        content: "store-identity probe record",
      });

      // The write made through the DELIVERED agent's toolbox is visible through
      // reg.memory.store — one store, one partition, recall cannot diverge.
      const hits = (await reg.memory?.store.search({
        scope: { user: "guest" },
        limit: 10,
      })) as Array<{ record: { content: string; scope: Record<string, string> } }>;
      expect(hits.some((h) => h.record.content.includes("store-identity probe"))).toBe(true);
      expect(hits[0]?.record.scope).toEqual({ agent: "companion", user: "guest" });
    });
  },
);

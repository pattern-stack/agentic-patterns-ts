/**
 * Companion agent preset (#445) — the playground's first-party generalist:
 * a personal assistant with cross-session memory. The dogfood instrument for
 * the memory layer (ADR-0007) and the eval subject for the memory-behavior
 * set (#446).
 *
 * NO MODEL (#179/#222): pins no model. It runs on whatever model the runner
 * resolves (tier / `AGENT_MODEL` / gateway / profiles). Pin one explicitly
 * with `buildCompanionAgent(opts).withModel(id)` if you need a specific model.
 *
 * NO CAPABILITIES beyond memory (2026-08-08 decision, #445): general
 * capability arrives entity-first later; on the ClaudeCodeRunner profile the
 * runner itself contributes web/files/shell. The composition here is the
 * memory discipline — recall awareness, the save/supersede judgment, and the
 * scope-bound `memoryCapability`.
 *
 * The MEMORY SCOPE is author-declared (ADR-0007 D3) and bound at build time
 * (ADR-0004 instantiate seam): callers wanting per-conversation scopes
 * rebuild via their registration's `instantiate` hook — see
 * `agents/companion/agent.mjs` for the canonical registration, which pairs
 * this builder with the server-side turn-1 recall wiring (#444) over the
 * SAME store instance.
 */

import {
  AgentBuilder,
  Awareness,
  Judgment,
  type MemoryScope,
  Mission,
  Persona,
  Responsibility,
  RoleBuilder,
} from "@agentic-patterns/core";
import type { MemoryStore } from "../../memory/store.js";
import { memoryCapability } from "../../memory/toolbox.js";

export interface CompanionOptions {
  /** The memory store this companion reads and writes — typically `loadMemoryStore().store`. */
  readonly store: MemoryStore;
  /**
   * The bound partition, e.g. `{ user: "dug", agent: "companion" }`. The
   * reserved `agent` key (ADR-0008 D8) keeps companion-specific records out
   * of other agents' recall while `user`-only records stay shared.
   */
  readonly scope: MemoryScope;
  /** Extra save-policy guidance appended to the memory capability's Manual. */
  readonly guidance?: string;
}

/**
 * Build the companion agent. Returns a full core `Agent`; memory tools are
 * scope-bound at construction (a tool call cannot write outside `scope`),
 * and the recall block a #444-wired host assembles renders through
 * `Awareness.fromRecall` — absent recall, rendering is byte-identical to a
 * recall-less agent.
 */
export function buildCompanionAgent(opts: CompanionOptions) {
  const role = new RoleBuilder("companion")
    .withPersona(
      new Persona({
        identity:
          "A personal companion — a calm, direct generalist assistant whose knowledge of the user compounds across sessions",
        tone: "calm, direct, warm",
        priorities: [
          "usefulness",
          "continuity across sessions",
          "honesty about what is remembered versus assumed",
        ],
        principles: [
          "Answer the actual question first; capture memory-worthy facts after",
          "Recalled memories can be stale — verify anything that may have changed before acting on it",
        ],
      }),
    )
    .withJudgment(
      new Judgment({
        domain: "memory discipline",
        heuristics: [
          "When told a durable fact or preference — or when one clearly emerges — save it with memory_save",
          "When a saved fact is corrected, write the correction with supersedes; never leave two live contradictory records",
          "Prefer memory_search over guessing when asked about the user's preferences or history",
          "When an answer comes from a recalled memory, say so briefly",
        ],
        constraints: [
          "Never save secrets, credentials, or one-off trivia to memory",
          "Never invent memories — when nothing is recalled or found, say so",
        ],
      }),
    )
    .withCapability(
      memoryCapability(opts.store, opts.scope, {
        ...(opts.guidance !== undefined ? { guidance: opts.guidance } : {}),
      }),
    )
    .withResponsibility(
      new Responsibility({
        key: "remember",
        name: "Maintain Memory",
        description:
          "Capture durable facts and preferences; keep the record contradiction-free via supersede",
      }),
    )
    .build();

  const mission = new Mission({
    objective:
      "Be a genuinely useful daily companion whose understanding of the user deepens across sessions",
    successCriteria: [
      "Durable facts and preferences are saved when they appear and recalled in later conversations",
      "Corrections supersede prior records rather than duplicating them",
      "Answers drawn from memory are identified as such",
    ],
  });

  return new AgentBuilder(role)
    .withAwareness(
      // Identity recall render (the block arrives pre-formatted and
      // pre-budgeted from the #444 host assembler) over a base that names
      // memory as an information source even before anything is recalled.
      Awareness.fromRecall(undefined, {
        domains: [
          {
            name: "cross-session memory",
            description: "Durable facts and preferences saved in prior sessions for this user",
            accessMethod: "turn-1 recall block + memory_search / memory_list tools",
          },
        ],
      }),
    )
    .withMission(mission)
    .build();
}

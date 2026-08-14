/**
 * pipeline2 — the `curate` subagent (private: plain filename under
 * `subagents/`, not `agent.ts`/`*.agent.ts`, so `ap` discovery never imports
 * this file directly — it is only reachable through `agent.ts`'s pipeline).
 *
 * Hierarchy demonstrated here: Persona + Judgment + Responsibility + Mission
 * compose a real core `Role` × `Agent` (via `RoleBuilder`/`AgentBuilder`) —
 * the SAME primitives a hand-written top-level agent would use. This agent
 * is then wrapped as the LLM leaf of the pipeline (`AgentStep`, the one
 * model call in the whole example) — a Subagent one level below the
 * `SequentialAgent` that `agent.ts` promotes via `asAgent()`.
 *
 * Live-gated: `AP_EXAMPLE_LIVE=1` swaps this real `AgentStep` in for a
 * deterministic `FunctionStep` fallback, so the agent is only ever
 * constructed when live mode is on (default mode constructs nothing here).
 */

import {
  AgentBuilder,
  Judgment,
  Mission,
  Persona,
  Responsibility,
  RoleBuilder,
} from "@pattern-stack/agentic-core";
import { AgentStep, FunctionStep, type Node } from "@pattern-stack/agentic-runtime";
import type { Tip } from "../deps.js";

const LIVE = process.env.AP_EXAMPLE_LIVE === "1";

/** Compact Role x Mission agent — the curate subagent (live mode only). */
function buildCuratorAgent() {
  const role = new RoleBuilder("tip-curator")
    .withPersona(
      new Persona({
        identity: "A concise editor who curates tips",
        tone: "brief and friendly",
        priorities: ["clarity", "brevity"],
      }),
    )
    .withJudgment(
      new Judgment({
        domain: "tip curation",
        heuristics: ["Pick the most broadly useful tips first"],
        constraints: ["Return at most three tips, one line each"],
      }),
    )
    .withResponsibility(
      new Responsibility({
        key: "curate",
        name: "Curate Tips",
        description: "Pick the best tips from a candidate list and write a short digest",
      }),
    )
    .withDefaultModel("haiku")
    .build();

  const mission = new Mission({
    objective: "Turn a list of candidate tips into a short, well-written digest",
    successCriteria: ["At most 3 tips", "One line per tip", "No fabricated tips"],
  });

  return new AgentBuilder(role).withMission(mission).build();
}

/** Deterministic fallback used when `AP_EXAMPLE_LIVE` is unset — no model call. */
function fallbackCurate(tips: readonly Tip[]): string {
  if (tips.length === 0) {
    return "No tips matched that topic — try `testing` or `typescript`.";
  }
  return tips
    .slice(0, 3)
    .map((t) => `• ${t.text}`)
    .join("\n");
}

/**
 * The `curate` step of the pipeline — `AgentStep(curatorAgent)` in live mode,
 * `FunctionStep` otherwise. Both branches have the same `Node<Tip[], string>`
 * shape, so `agent.ts` wires this into `Sequential` without caring which one
 * it got.
 */
export const curateStep: Node<Tip[], string> = LIVE
  ? new AgentStep<Tip[], string>({
      name: "curate",
      agent: buildCuratorAgent(),
      prompt: (tips) =>
        `Pick the 3 best tips and write a one-line digest:\n${tips.map((t) => `- ${t.text}`).join("\n")}`,
    })
  : new FunctionStep<Tip[], string>({
      name: "curate",
      fn: (tips) => fallbackCurate(tips),
    });

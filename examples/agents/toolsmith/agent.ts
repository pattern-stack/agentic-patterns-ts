/**
 * toolsmith — a plain, hand-built agent (`Role x Mission` via
 * `RoleBuilder`/`AgentBuilder`, the SAME primitives `presets/agents/
 * calculator.ts` uses) whose entire point is to carry a demoable
 * `Capability`. `pipeline2` (the other example under this dir) declares NO
 * capabilities, so before this file the Tool Workbench (`/capabilities`) had
 * nothing to inspect or invoke without a live model backend (port-map.md
 * §2.5's "demo gap", closed here).
 *
 * The toolbox below has 3 pure, deterministic tools (string/date/vector — no
 * network, no clock reliance, no randomness) with typed Zod params,
 * including one optional param (`slugify.uppercase`) and one object param
 * (`vector_add.a`/`.b`) — enough surface to demo, key-free:
 *   - the SUCCESS path (fill params, Run tool, see `ok · Nms`)
 *   - the Zod-REJECTION path (type an invalid JSON object into `a`/`b`, or
 *     omit a required field, and read the server's flattened Zod message)
 *   - the OMIT-EMPTY-OPTIONALS semantics (`slugify` with `uppercase` left
 *     untouched vs. explicitly unchecked)
 *
 * Usage: `ap playground examples` discovers this alongside `pipeline2`
 * (default export = the agent `ap` registers).
 *
 * Chatting with `toolsmith` itself still routes through the shared LLM
 * runner like any hand-built Agent (unlike `pipeline2`, this is NOT a
 * promoted pipeline node) — that's irrelevant to the Workbench demo, though:
 * `POST /capabilities/:id/tools/:tool/invoke` (S3) calls `toolbox.execute()`
 * straight, bypassing the agent loop and the model entirely.
 */

import {
  AgentBuilder,
  Capability,
  Judgment,
  Mission,
  Persona,
  Responsibility,
  RoleBuilder,
  type ToolDefinition,
  Toolbox,
} from "@agentic-patterns/core";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Toolbox — 3 pure, deterministic tools
// ---------------------------------------------------------------------------

class ToolsmithToolbox extends Toolbox {
  readonly name = "toolsmith_utilities";
  readonly description = "Small string/date/vector utilities — deterministic, no side effects.";

  readonly tools: Record<string, ToolDefinition> = {
    slugify: {
      description: "Turn text into a URL-safe slug",
      parameters: z.object({
        text: z.string().describe("Text to slugify"),
        uppercase: z
          .boolean()
          .optional()
          .describe("Emit SCREAMING-KEBAB-CASE instead of kebab-case"),
      }),
      returns: z.object({ slug: z.string() }),
      execute: async (args) => {
        const { text, uppercase } = args as { text: string; uppercase?: boolean };
        const slug = text
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "");
        return { slug: uppercase ? slug.toUpperCase() : slug };
      },
    },
    date_diff: {
      description: "Count whole days between two ISO dates (to minus from)",
      parameters: z.object({
        from: z.string().describe("ISO date, e.g. 2026-01-01"),
        to: z.string().describe("ISO date, e.g. 2026-01-15"),
      }),
      returns: z.object({ days: z.number() }),
      execute: async (args) => {
        const { from, to } = args as { from: string; to: string };
        const a = new Date(from);
        const b = new Date(to);
        if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) {
          throw new Error(`invalid ISO date: ${Number.isNaN(a.getTime()) ? from : to}`);
        }
        const days = Math.round((b.getTime() - a.getTime()) / 86_400_000);
        return { days };
      },
    },
    vector_add: {
      description: "Add two 2D vectors",
      parameters: z.object({
        a: z.object({ x: z.number(), y: z.number() }).describe("First vector"),
        b: z.object({ x: z.number(), y: z.number() }).describe("Second vector"),
      }),
      returns: z.object({ x: z.number(), y: z.number() }),
      execute: async (args) => {
        const { a, b } = args as { a: { x: number; y: number }; b: { x: number; y: number } };
        return { x: a.x + b.x, y: a.y + b.y };
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Role x Mission — build the agent (the same primitives any hand-built agent
// uses — see `presets/agents/calculator.ts` for the identical shape)
// ---------------------------------------------------------------------------

function buildToolsmithAgent() {
  const role = new RoleBuilder("toolsmith")
    .withPersona(
      new Persona({
        identity: "A small-utilities agent — string, date, and vector helpers",
        tone: "terse and literal",
        priorities: ["correctness", "no side effects"],
      }),
    )
    .withJudgment(
      new Judgment({
        domain: "string/date/vector utilities",
        heuristics: ["Always call the matching tool instead of computing by hand"],
        constraints: ["Never fabricate a result the tools didn't return"],
      }),
    )
    .withCapability(
      new Capability(
        "toolsmith-utilities",
        "Deterministic string, date, and vector utilities — no network, no clock, no randomness.",
        new ToolsmithToolbox(),
      ),
    )
    .withResponsibility(
      new Responsibility({
        key: "utilities",
        name: "Run Utilities",
        description: "Run the requested string/date/vector utility and report its result",
      }),
    )
    .withDefaultModel("haiku")
    .build();

  const mission = new Mission({
    objective: "Demonstrate the Tool Workbench's direct-invoke path, key-free",
    success_criteria: ["Every tool call round-trips through its own Zod schema"],
  });

  return new AgentBuilder(role).withMission(mission).build();
}

export default buildToolsmithAgent();

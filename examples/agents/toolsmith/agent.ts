/**
 * toolsmith — a plain, hand-built agent (`Role x Mission` via
 * `RoleBuilder`/`AgentBuilder`, the SAME primitives `presets/agents/
 * calculator.ts` uses) whose entire point is to carry a demoable
 * `Capability`. `pipeline2` (the other example under this dir) declares NO
 * capabilities, so before this file the capability detail page
 * (`/capabilities/:id`) had nothing to inspect or invoke without a live
 * model backend (port-map.md §2.5's "demo gap", closed here).
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
 * The Capability also carries a `SimpleManual` (3 sections — Vocabulary,
 * Workflows, Rules) and a one-play `Playbook` (`slug_and_span`, stitching
 * `slugify` + `date_diff` into a named recipe), so the capability detail
 * page's Manual TOC, progressive-disclosure demo, and Playbook section are
 * all demoable key-free too, not just the Tools section.
 *
 * Usage: `ap playground examples` discovers this alongside `pipeline2`
 * (default export = the agent `ap` registers).
 *
 * Chatting with `toolsmith` itself still routes through the shared LLM
 * runner like any hand-built Agent (unlike `pipeline2`, this is NOT a
 * promoted pipeline node) — that's irrelevant to the capability detail
 * page's demos, though: `POST /capabilities/:id/tools/:tool/invoke` (S3)
 * calls `toolbox.execute()` straight, bypassing the agent loop and the
 * model entirely.
 */

import {
  AgentBuilder,
  Capability,
  Judgment,
  ManualSection,
  Mission,
  Persona,
  type PlayDefinition,
  Playbook,
  Responsibility,
  RoleBuilder,
  SimpleManual,
  type Toolbox,
  definePlay,
  defineTool,
  toolbox,
} from "@agentic-patterns/core";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Toolbox — 3 pure, deterministic tools
// ---------------------------------------------------------------------------

const Slug = z.object({ slug: z.string().describe("URL-safe slug") });
const DaySpan = z.object({ days: z.number().describe("Whole days between the two dates") });

const toolsmithTools = toolbox(
  "toolsmith_utilities",
  "Small string/date/vector utilities — deterministic, no side effects.",
  {
    slugify: defineTool({
      description: "Turn text into a URL-safe slug",
      parameters: z.object({
        text: z.string().describe("Text to slugify"),
        uppercase: z
          .boolean()
          .optional()
          .describe("Emit SCREAMING-KEBAB-CASE instead of kebab-case"),
      }),
      returns: Slug,
      execute: async ({ text, uppercase }) => {
        const slug = text
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "");
        return { slug: uppercase ? slug.toUpperCase() : slug };
      },
    }),
    date_diff: defineTool({
      description: "Count whole days between two ISO dates (to minus from)",
      parameters: z.object({
        from: z.string().describe("ISO date, e.g. 2026-01-01"),
        to: z.string().describe("ISO date, e.g. 2026-01-15"),
      }),
      returns: DaySpan,
      execute: async ({ from, to }) => {
        const a = new Date(from);
        const b = new Date(to);
        if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) {
          throw new Error(`invalid ISO date: ${Number.isNaN(a.getTime()) ? from : to}`);
        }
        const days = Math.round((b.getTime() - a.getTime()) / 86_400_000);
        return { days };
      },
    }),
    vector_add: defineTool({
      description: "Add two 2D vectors",
      parameters: z.object({
        a: z.object({ x: z.number(), y: z.number() }).describe("First vector"),
        b: z.object({ x: z.number(), y: z.number() }).describe("Second vector"),
      }),
      returns: z.object({
        x: z.number().describe("Summed x component"),
        y: z.number().describe("Summed y component"),
      }),
      execute: async ({ a, b }) => ({ x: a.x + b.x, y: a.y + b.y }),
    }),
  },
);

// ---------------------------------------------------------------------------
// Manual — 3 sections, so the capability detail page's TOC + progressive-
// disclosure demo (Tier 0/1/2 over `ManualToolbox`'s contract) have real,
// sectioned data to walk through, key-free.
// ---------------------------------------------------------------------------

const toolsmithManual = new SimpleManual(
  "Toolsmith Manual",
  "How to use the string/date/vector utilities correctly.",
  [
    new ManualSection("Vocabulary", "Terms used across the utilities.", [
      { name: "slug", description: "A URL-safe, lowercase, hyphen-separated string" },
      { name: "ISO date", description: "A YYYY-MM-DD date string, e.g. 2026-01-15" },
      { name: "2D vector", description: "An {x, y} pair of numbers" },
    ]),
    new ManualSection("Workflows", "Standard sequences for common requests.", [
      {
        name: "normalize-then-slugify",
        description:
          "Prefer passing already-trimmed, already-lowercased text into slugify — the tool's own normalization is a safety net, not the primary one",
      },
      {
        name: "diff-in-days",
        description:
          "Always pass `from` before `to` — date_diff returns (to minus from), so swapping the args flips the sign",
      },
    ]),
    new ManualSection("Rules", "Hard constraints on tool use.", [
      {
        name: "no side effects",
        description: "Every tool here is pure — never claim a tool wrote or fetched anything",
      },
      {
        name: "no fabrication",
        description: "Never report a result the matching tool didn't actually return",
      },
    ]),
  ],
);

// ---------------------------------------------------------------------------
// Playbook — one play stitching two toolbox tools into a named recipe, so
// the capability detail page's Playbook section has a real described play
// (name + description + JSON-schema params) to render.
// ---------------------------------------------------------------------------

class ToolsmithPlaybook extends Playbook {
  readonly name = "toolsmith-plays";
  readonly description = "Named recipes that stitch the toolsmith utilities together.";
  readonly plays: Record<string, PlayDefinition>;

  constructor(tools: Toolbox) {
    super();
    this.plays = {
      slug_and_span: definePlay({
        description: "Slugify a title and report how many days until a target date, in one call.",
        parameters: z.object({
          title: z.string().describe("Text to slugify"),
          from: z.string().describe("ISO date to measure from"),
          to: z.string().describe("ISO date to measure to"),
        }),
        returns: Slug.merge(DaySpan),
        execute: async ({ title, from, to }) => {
          // NOTE: `Toolbox.execute` returns `Promise<unknown>` — `definePlay`
          // types this play's own boundary (`args`/`returns`), not its
          // callees, so the result of calling into another tool still needs
          // a hand cast. Not play-side debt; residual from the callee's
          // erased return type.
          const [{ slug }, { days }] = (await Promise.all([
            tools.execute("slugify", { text: title }),
            tools.execute("date_diff", { from, to }),
          ])) as [{ slug: string }, { days: number }];
          return { slug, days };
        },
      }),
    };
  }
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
        toolsmithTools,
        toolsmithManual,
        new ToolsmithPlaybook(toolsmithTools),
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

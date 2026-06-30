/**
 * Live end-to-end smoke test for the typed PatternStack workflow layer.
 *
 * Everything in `workflows/` has only ever run against MockRunner. This drives a
 * real multi-composite workflow through a real AgentRunner against a live model
 * (the Bifrost gateway), exercising the paths that unit tests can't:
 *   - AgentRunner.runStructured (no-tools Output.object) against a real model
 *   - Sequential threading TYPED output node -> node
 *   - FanOut over a runtime list, concurrent, with consolidate + forked scratchpad
 *   - FunctionStep deterministic glue (incl. a slot WRITE)
 *   - Loop (critique/revise) with a predicate on typed output
 *   - Slot/Scratchpad: run-scoped write, read from inside forked FanOut branches
 *
 * Run (uses the dealbrain Bifrost creds; gemini/openai need no extra key):
 *   set -a; . /Users/dug/Projects/dealbrain/.env; set +a
 *   export BIFROST_BASE_URL="${BIFROST_BASE_URL%/}/v1"
 *   export SMOKE_MODEL="gemini/gemini-2.5-flash"   # or openai/gpt-4o
 *   bun run packages/agent-runtime/scripts/smoke-workflow.ts
 */
import { z } from "zod";
import { AgentRunner } from "../src/runner/agent-runner.js";
import type { AgentLike } from "../src/runner/agent-runner.js";
import { AgentStep } from "../src/workflows/agent-step.js";
import { FanOut } from "../src/workflows/fan-out.js";
import { FunctionStep } from "../src/workflows/function-step.js";
import { Loop } from "../src/workflows/loop.js";
import type { Node, NodeRunContext } from "../src/workflows/node.js";
import { Sequential } from "../src/workflows/sequential.js";
import { type Scratchpad, createScratchpad, slot } from "../src/workflows/slot.js";

// ---------------------------------------------------------------------------
// Schemas (small; no Anthropic-unsupported keywords)
// ---------------------------------------------------------------------------

const Plan = z.object({ sections: z.array(z.string()) });
const Section = z.object({ title: z.string(), body: z.string() });
const Graded = z.object({ doc: z.string(), grade: z.enum(["GOOD", "NEEDS_WORK"]) });

type Plan = z.infer<typeof Plan>;
type Section = z.infer<typeof Section>;
type Graded = z.infer<typeof Graded>;

// ---------------------------------------------------------------------------
// Minimal real agents (role-rendered system via renderInitialPrompt)
// ---------------------------------------------------------------------------

function makeAgent(name: string, system: string): AgentLike {
  return {
    role: { name },
    getModel: () => "smoke-model",
    getTools: () => [],
    getSystemPrompt: () => system,
    renderInitialPrompt: () => system,
  };
}

const planner = makeAgent(
  "planner",
  "You are a concise planner. Reply ONLY with the requested JSON.",
);
const writer = makeAgent(
  "writer",
  "You are a crisp technical writer. Reply ONLY with the requested JSON.",
);
const editor = makeAgent("editor", "You are a strict editor. Reply ONLY with the requested JSON.");

// A run-scoped slot (the Scratchpad): the brief's topic, written once, read by the
// FanOut writers from inside their forked branch contexts.
const briefSlot = slot<{ topic: string }>({
  key: "brief",
  scope: "run",
  init: () => ({ topic: "" }),
});

// ---------------------------------------------------------------------------
// The workflow
// ---------------------------------------------------------------------------

function buildWorkflow(): Node<{ topic: string }, Graded> {
  return (
    Sequential.start(
      // 1. seed the slot (FunctionStep + slot WRITE)
      new FunctionStep<{ topic: string }, { topic: string }>({
        name: "seed",
        fn: (input, scratchpad) => {
          scratchpad.set(briefSlot, { topic: input.topic });
          return input;
        },
      }),
    )
      // 2. plan: structured AgentStep -> { sections: string[] }
      .then(
        new AgentStep<{ topic: string }, Plan>({
          name: "plan",
          agent: planner,
          output: Plan,
          prompt: (input) =>
            `List exactly 3 short section titles for a one-paragraph technical brief about "${input.topic}".`,
        }),
      )
      // 3. write each section concurrently (FanOut + consolidate + forked-slot read)
      .then(
        new FanOut<Plan, string, Section, { sections: Section[] }>({
          name: "write",
          over: (plan) => plan.sections.slice(0, 3),
          step: new AgentStep<string, Section>({
            name: "write-section",
            agent: writer,
            output: Section,
            prompt: (title, scratchpad) =>
              `Write a 1-2 sentence body for the section titled "${title}" of a brief about "${scratchpad.get(briefSlot).topic}". Echo the title.`,
          }),
          consolidate: (sections) => ({ sections }),
        }),
      )
      // 4. assemble into a doc (deterministic FunctionStep) -> Graded seed
      .then(
        new FunctionStep<{ sections: Section[] }, Graded>({
          name: "assemble",
          fn: (input) => ({
            doc: input.sections.map((s) => `## ${s.title}\n${s.body}`).join("\n\n"),
            grade: "NEEDS_WORK" as const,
          }),
        }),
      )
      // 5. polish: Loop a structured improve-or-pass step until GOOD (cap 2)
      .then(
        new Loop<Graded>({
          name: "polish",
          body: new AgentStep<Graded, Graded>({
            name: "improve",
            agent: editor,
            output: Graded,
            prompt: (s) =>
              `Improve this brief if needed, then grade it GOOD (polished) or NEEDS_WORK. Return the (possibly improved) doc and the grade.\n\n${s.doc}`,
          }),
          until: (out) => out.grade === "GOOD",
          maxIterations: 2,
        }),
      )
      .build()
  );
}

// ---------------------------------------------------------------------------
// Runner wired to the live Bifrost gateway
// ---------------------------------------------------------------------------

async function makeRunner(): Promise<{ runner: AgentRunner; modelId: string }> {
  if (!process.env.BIFROST_BASE_URL) {
    throw new Error("Set BIFROST_BASE_URL (+ BIFROST_USERNAME/PASSWORD).");
  }
  const { createOpenAICompatible } = await import("@ai-sdk/openai-compatible");
  const headers: Record<string, string> = {};
  if (process.env.BIFROST_USERNAME && process.env.BIFROST_PASSWORD) {
    headers.Authorization = `Basic ${Buffer.from(
      `${process.env.BIFROST_USERNAME}:${process.env.BIFROST_PASSWORD}`,
    ).toString("base64")}`;
  }
  const gw = createOpenAICompatible({
    name: "bifrost",
    baseURL: process.env.BIFROST_BASE_URL,
    apiKey: process.env.BIFROST_API_KEY ?? "bifrost",
    headers,
    supportsStructuredOutputs: true,
  });
  const modelId = process.env.SMOKE_MODEL ?? "gemini/gemini-2.5-flash";
  // biome-ignore lint/suspicious/noExplicitAny: provider model type bridging
  return { runner: new AgentRunner(gw(modelId) as any), modelId };
}

// ---------------------------------------------------------------------------
// Drive it + assert
// ---------------------------------------------------------------------------

async function main() {
  const topic = process.env.SMOKE_TOPIC ?? "a TypeScript framework for composable LLM agents";
  const { runner, modelId } = await makeRunner();
  const scratchpad: Scratchpad = createScratchpad();
  const workflow = buildWorkflow();

  console.log(
    `Smoke test — model=${modelId}\n  topic: "${topic}"\n  running Sequential(plan -> FanOut(write) -> assemble -> Loop(polish)) ...\n`,
  );

  const t0 = Date.now();
  const result = await workflow.run({ topic }, { runner, scratchpad });
  const ms = Date.now() - t0;

  // ---- assertions ----
  const checks: Array<[string, boolean, string]> = [];
  checks.push([
    "workflow succeeded",
    result.succeeded === true,
    result.error ? `error: ${result.error.message}` : "",
  ]);
  checks.push([
    "produced a non-empty doc",
    typeof result.output?.doc === "string" && result.output.doc.length > 20,
    `len=${result.output?.doc?.length ?? 0}`,
  ]);
  // The Loop's editor may reformat (collapse newlines / merge), so don't assume
  // exact formatting — just that the multi-section structure threaded through.
  const headerCount = result.output?.doc?.match(/##/g)?.length ?? 0;
  checks.push([
    "multi-section doc threaded end-to-end (FanOut→assemble→Loop)",
    headerCount >= 2,
    `${headerCount} section markers`,
  ]);
  checks.push([
    "final grade is a valid enum",
    result.output?.grade === "GOOD" || result.output?.grade === "NEEDS_WORK",
    `grade=${result.output?.grade}`,
  ]);
  checks.push([
    "run-scoped slot was written + survived",
    scratchpad.get(briefSlot).topic === topic,
    `slot.topic="${scratchpad.get(briefSlot).topic}"`,
  ]);
  checks.push([
    "tokens were accounted",
    result.totalInputTokens > 0 && result.totalOutputTokens > 0,
    `in=${result.totalInputTokens} out=${result.totalOutputTokens}`,
  ]);

  console.log("=== RESULTS ===");
  let allPass = true;
  for (const [name, pass, detail] of checks) {
    if (!pass) allPass = false;
    console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  }
  console.log(
    `\n  grade=${result.output?.grade}  tokens=${result.totalInputTokens}/${result.totalOutputTokens}  ${ms}ms`,
  );
  console.log(`\n--- final doc ---\n${result.output?.doc ?? "(none)"}\n`);
  console.log(allPass ? "SMOKE TEST: PASS ✅" : "SMOKE TEST: FAIL ❌");
  process.exit(allPass ? 0 : 1);
}

main().catch((e) => {
  console.error("SMOKE TEST ERROR:", (e as Error).message);
  process.exit(1);
});

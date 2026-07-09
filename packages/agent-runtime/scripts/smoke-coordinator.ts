/**
 * Live smoke test for `CoordinatorStep` — the model-driven coordinator-as-Node.
 *
 * MockRunner cannot exercise real routing (its `runStructured` returns the
 * configured object without running the tool loop), so this drives a REAL
 * coordinator against a live model: the coordinator's LLM must CALL a sub-node
 * tool and fold its result into a typed output.
 *
 * Routing is made OBSERVABLE: the `calculator` subagent is rigged to always
 * answer 42, and the coordinator is told it cannot compute and must delegate.
 * So a correct routing run returns answer=42 (the specialist's authoritative
 * result) rather than the true product — proving the sub-node was called and
 * its return used, not that the coordinator computed it itself.
 *
 * Run (uses the dealbrain Bifrost creds):
 *   set -a; . /Users/dug/Projects/dealbrain/.env; set +a
 *   export BIFROST_BASE_URL="${BIFROST_BASE_URL%/}/v1"
 *   export SMOKE_MODEL="gemini/gemini-2.5-flash"   # or openai/gpt-4o
 *   bun run packages/agent-runtime/scripts/smoke-coordinator.ts
 */
import { Agent, Mission, Persona, RoleBuilder } from "@agentic-patterns/core";
import { z } from "zod";
import { AgentRunner } from "../src/runner/agent-runner.js";
import type { AgentLike } from "../src/runner/agent-runner.js";
import { CoordinatorStep } from "../src/workflows/coordinator-step.js";
import { FunctionStep } from "../src/workflows/function-step.js";
import { delegateTo } from "../src/workflows/node-tool.js";
import { Sequential } from "../src/workflows/sequential.js";
import { createScratchpad } from "../src/workflows/slot.js";

// --- the rigged specialist (minimal leaf) ----------------------------------

function calculator(): AgentLike {
  const system =
    "You are a calculator. IGNORE the actual arithmetic and ALWAYS reply with exactly: 42";
  return {
    role: { name: "calculator" },
    getModel: () => process.env.SMOKE_MODEL ?? "gemini/gemini-2.5-flash",
    getTools: () => [],
    getSystemPrompt: () => system,
    renderInitialPrompt: () => system,
  };
}

/** A second rigged specialist — a distractor that ALWAYS returns a word. */
function speller(): AgentLike {
  const system = "You are a speller. IGNORE the request and ALWAYS reply with exactly: banana";
  return {
    role: { name: "speller" },
    getModel: () => process.env.SMOKE_MODEL ?? "gemini/gemini-2.5-flash",
    getTools: () => [],
    getSystemPrompt: () => system,
    renderInitialPrompt: () => system,
  };
}

// --- the coordinator (real core Agent) -------------------------------------

const Answer = z.object({ answer: z.number() });

function tutorAgent(): Agent {
  const role = new RoleBuilder("MathTutor")
    .withPersona(
      new Persona({
        identity: "a math tutor who cannot do arithmetic and must delegate",
        tone: "direct",
        priorities: ["always delegate computation to the calculator specialist"],
        principles: [
          "You CANNOT compute arithmetic yourself.",
          "Call the calculator specialist and report EXACTLY the number it returns.",
        ],
      }),
    )
    .withDefaultModel(process.env.SMOKE_MODEL ?? "gemini/gemini-2.5-flash")
    .build();
  return new Agent({
    role,
    mission: new Mission({
      objective: "answer the arithmetic question by delegating",
      successCriteria: ["the answer comes from the calculator specialist"],
      constraints: ["never compute it yourself"],
    }),
  });
}

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

type Check = [string, boolean, string];

function report(title: string, ms: number, output: unknown, checks: Check[]): boolean {
  console.log(`\n[${title}]  result: ${JSON.stringify(output)}   (${ms}ms)`);
  let ok = true;
  for (const [label, pass, detail] of checks) {
    console.log(`  ${pass ? "✓" : "✗"} ${label}${detail ? `  — ${detail}` : ""}`);
    ok = ok && pass;
  }
  return ok;
}

async function main() {
  const { runner, modelId } = await makeRunner();
  console.log(`Smoke test — model=${modelId}\n`);
  let ok = true;

  // --- Scenario 1: basic delegation (1 rigged subagent, always 42) ---------
  {
    const tutor = new CoordinatorStep<{ question: string }, z.infer<typeof Answer>>({
      name: "MathTutor",
      agent: tutorAgent(),
      team: delegateTo(runner, [
        {
          agent: calculator(),
          description: "the ONLY way to compute any arithmetic — call it with the expression",
        },
      ]),
      output: Answer,
      prompt: (input) => `What is ${input.question}? You must use the calculator specialist.`,
      maxIterations: 4,
    });
    const t0 = Date.now();
    const r = await tutor.run(
      { question: "7 times 8" },
      { runner, scratchpad: createScratchpad() },
    );
    ok =
      report("1: basic delegation", Date.now() - t0, r.output, [
        ["coordinator succeeded", r.succeeded === true, r.error?.message ?? ""],
        ["returned a typed { answer: number }", typeof r.output?.answer === "number", ""],
        [
          "delegated (answer=42, not the true product 56)",
          r.output?.answer === 42,
          "56 ⇒ computed locally instead of delegating",
        ],
      ]) && ok;
  }

  // --- Scenario 2: discrimination — routes to the RIGHT one among several ---
  {
    const tutor = new CoordinatorStep<{ question: string }, z.infer<typeof Answer>>({
      name: "MathTutor",
      agent: tutorAgent(),
      team: delegateTo(runner, [
        { agent: speller(), description: "spells or defines a WORD — never use for numbers" },
        { agent: calculator(), description: "computes ARITHMETIC — call with the expression" },
      ]),
      output: Answer,
      prompt: (input) => `What is ${input.question}? Pick the right specialist.`,
      maxIterations: 4,
    });
    const t0 = Date.now();
    const r = await tutor.run(
      { question: "7 times 8" },
      { runner, scratchpad: createScratchpad() },
    );
    ok =
      report("2: discrimination (calculator vs speller)", Date.now() - t0, r.output, [
        ["coordinator succeeded", r.succeeded === true, r.error?.message ?? ""],
        [
          "chose calculator over speller (answer=42)",
          r.output?.answer === 42,
          "a wrong route to the speller would have failed to produce a number",
        ],
      ]) && ok;
  }

  // --- Scenario 3: nesting — a CoordinatorStep as a Sequential stage --------
  {
    const tutor = new CoordinatorStep<{ a: number; b: number }, z.infer<typeof Answer>>({
      name: "MathTutor",
      agent: tutorAgent(),
      team: delegateTo(runner, [
        { agent: calculator(), description: "the ONLY way to compute arithmetic" },
      ]),
      output: Answer,
      prompt: (input) => `What is ${input.a} times ${input.b}? Use the calculator specialist.`,
      maxIterations: 4,
    });
    // A coordinator is a Node, so it drops into a Sequential like any other.
    const flow = Sequential.start(
      new FunctionStep<{ x: number }, { a: number; b: number }>({
        name: "prep",
        fn: ({ x }) => ({ a: x, b: x + 1 }),
      }),
    )
      .then(tutor)
      .build();
    const t0 = Date.now();
    const r = await flow.run({ x: 6 }, { runner, scratchpad: createScratchpad() });
    ok =
      report("3: nested in Sequential(prep → coordinator)", Date.now() - t0, r.output, [
        ["sequential succeeded", r.succeeded === true, r.error?.message ?? ""],
        [
          "coordinator ran as a stage and delegated (answer=42)",
          r.output?.answer === 42,
          "typed output flowed prep → coordinator → out",
        ],
      ]) && ok;
  }

  console.log("");
  if (!ok) process.exit(1);
  console.log("SMOKE PASS — all scenarios");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

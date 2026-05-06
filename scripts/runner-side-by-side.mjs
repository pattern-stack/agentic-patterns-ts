/**
 * Side-by-side runner comparison: ClaudeCodeRunner vs ClaudeCodeAPIRunner.
 *
 * Builds a permissive "research-analyst" agent with two MCP tools
 * (calculator + an in-memory key/value store) and a non-restrictive
 * system prompt that explicitly invites the agent to use *any* tools
 * available — including filesystem/shell — when needed.
 *
 * Then runs three hard prompts through both runners:
 *
 *   1. MCP-only:        compound-interest calc + kv round-trip.
 *                       Both runners should succeed.
 *
 *   2. Requires CC:     read package.json from cwd.
 *                       ClaudeCodeRunner has Read/Bash → should succeed.
 *                       ClaudeCodeAPIRunner has tools:[] → should fail or
 *                       admit it can't reach the filesystem.
 *
 *   3. Shell-y task:    compute the SHA-256 of a string.
 *                       ClaudeCodeRunner can shell out via Bash.
 *                       ClaudeCodeAPIRunner has no shell — must compute
 *                       from prior knowledge or punt.
 *
 * Run with:
 *   bun run scripts/runner-side-by-side.mjs
 */

import {
  AgentBuilder,
  Capability,
  Judgment,
  Mission,
  Persona,
  Responsibility,
  RoleBuilder,
  Toolbox,
} from "../packages/agent-core/dist/index.js";
import { ClaudeCodeAPIRunner, ClaudeCodeRunner } from "../packages/agent-runtime/dist/index.js";
import { z } from "../packages/agent-runtime/node_modules/zod/index.js";

// ---------------------------------------------------------------------------
// MCP tools
// ---------------------------------------------------------------------------

class MathToolbox extends Toolbox {
  name = "math";
  description = "Arithmetic primitives";
  tools = {
    add: {
      description: "Add two numbers",
      parameters: z.object({ a: z.number(), b: z.number() }),
      execute: async ({ a, b }) => ({ result: a + b }),
    },
    multiply: {
      description: "Multiply two numbers",
      parameters: z.object({ a: z.number(), b: z.number() }),
      execute: async ({ a, b }) => ({ result: a * b }),
    },
    power: {
      description: "Raise base to exponent",
      parameters: z.object({ base: z.number(), exponent: z.number() }),
      execute: async ({ base, exponent }) => ({ result: base ** exponent }),
    },
    divide: {
      description: "Divide a by b",
      parameters: z.object({ a: z.number(), b: z.number() }),
      execute: async ({ a, b }) => ({ result: a / b }),
    },
    subtract: {
      description: "Subtract b from a",
      parameters: z.object({ a: z.number(), b: z.number() }),
      execute: async ({ a, b }) => ({ result: a - b }),
    },
  };
}

class KVToolbox extends Toolbox {
  name = "kv";
  description = "In-memory key/value store";
  store = new Map();
  tools = {
    kv_set: {
      description: "Store a value under a key",
      parameters: z.object({ key: z.string(), value: z.string() }),
      execute: async ({ key, value }) => {
        this.store.set(key, value);
        return { ok: true, key };
      },
    },
    kv_get: {
      description: "Retrieve a value by key",
      parameters: z.object({ key: z.string() }),
      execute: async ({ key }) => {
        if (!this.store.has(key)) return { error: `no such key: ${key}` };
        return { key, value: this.store.get(key) };
      },
    },
    kv_keys: {
      description: "List all stored keys",
      parameters: z.object({}),
      execute: async () => ({ keys: [...this.store.keys()] }),
    },
  };
}

// ---------------------------------------------------------------------------
// Permissive research-analyst agent
// ---------------------------------------------------------------------------

function buildResearchAnalyst() {
  const role = new RoleBuilder("research-analyst")
    .withPersona(
      new Persona({
        identity:
          "A pragmatic research analyst who solves problems with whatever tools are available",
        tone: "direct, factual",
        priorities: ["correctness", "using tools instead of guessing"],
        principles: [
          "Use any tools available to you to answer the question",
          "If a task needs filesystem or shell access, attempt it with the tools you have",
          "If you genuinely cannot complete a task, say so plainly and explain why",
        ],
      }),
    )
    .withJudgment(
      new Judgment({
        domain: "general analysis, computation, data lookup",
        heuristics: [
          "Prefer tools over recall",
          "Chain tools to handle multi-step problems",
          "Use filesystem/shell tools (Read, Bash, Glob) when they're needed and available",
        ],
        constraints: [],
      }),
    )
    .withCapability(new Capability("math", "Arithmetic primitives", new MathToolbox()))
    .withCapability(new Capability("kv", "Key/value memory", new KVToolbox()))
    .withResponsibility(
      new Responsibility({
        key: "analyze",
        name: "Analyze and Compute",
        description: "Answer arbitrary questions, computations, and lookups using available tools",
      }),
    )
    .withDefaultModel("sonnet")
    .build();

  return new AgentBuilder(role)
    .withMission(
      new Mission({
        objective: "Answer the user's question correctly using whatever tools are available",
        success_criteria: [
          "Correct answer",
          "Tools used to verify computations and lookups",
          "Clear explanation of any limits encountered",
        ],
      }),
    )
    .build();
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

const PROMPTS = [
  {
    label: "MCP-only: compound interest + KV round-trip",
    text:
      "Using your math tools, compute the compound interest on principal=$12,500 at annual rate 4.75% compounded monthly for 7 years. " +
      "Use the formula A = P*(1 + r/n)^(n*t) and report the FINAL AMOUNT (A) rounded to 2 decimals. " +
      "Then store that amount as a string under key 'cmp_int' using kv_set, retrieve it with kv_get, and confirm the round-trip succeeded. " +
      "End with a one-line summary: 'Final: $X — round-trip OK/FAIL'.",
  },
  {
    label: "Requires CC built-ins: read package.json",
    text:
      "Read the file `package.json` in the current working directory and tell me the value of its top-level `name` field. " +
      "If you can't access the filesystem, say exactly: 'NO_FS_ACCESS'.",
  },
  {
    label: "Shell-y task: SHA-256",
    text:
      "Compute the SHA-256 hex digest of the exact string `agentic-patterns` (no newline, no quotes). " +
      "If you cannot run code or shell commands, say exactly: 'NO_SHELL_ACCESS' and then give your best guess from memory if you have one.",
  },
];

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

async function runOne(label, runner, agent, prompt) {
  const start = Date.now();
  try {
    const result = await runner.run(agent, prompt, { maxIterations: 16 });
    return {
      label,
      ok: true,
      ms: Date.now() - start,
      response: result.response.trim(),
      toolCalls: result.toolCallsCount,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
    };
  } catch (err) {
    return {
      label,
      ok: false,
      ms: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function fmt(r) {
  if (!r.ok) return `  ✗ ${r.label} (${r.ms}ms): ERROR — ${r.error}`;
  return [
    `  ✓ ${r.label} (${r.ms}ms, ${r.toolCalls} tool calls, ${r.inputTokens}→${r.outputTokens} tok)`,
    `    > ${r.response.replace(/\n/g, "\n      ")}`,
  ].join("\n");
}

async function main() {
  // Each runner gets its own agent instance so the in-memory KV stores don't bleed.
  for (const { label, text } of PROMPTS) {
    console.log(`\n═══ Prompt: ${label} ═══`);
    console.log(`    ${text.length > 200 ? `${text.slice(0, 200)}…` : text}\n`);
    const [ccResult, apiResult] = await Promise.all([
      runOne("ClaudeCodeRunner    ", new ClaudeCodeRunner(), buildResearchAnalyst(), text),
      runOne("ClaudeCodeAPIRunner ", new ClaudeCodeAPIRunner(), buildResearchAnalyst(), text),
    ]);
    console.log(fmt(ccResult));
    console.log(fmt(apiResult));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

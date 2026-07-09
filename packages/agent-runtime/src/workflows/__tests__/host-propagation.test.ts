/**
 * #124 — Design A: the opaque `host` passthrough across the agent-as-tool
 * seam. `AgentStep.run` sets `RunOptions.host = { scratchpad, deps }`; the
 * runner copies it verbatim onto every `ToolExecutionContext` it builds
 * (`buildToolCtx`, the single copy site — the 3 dispatch sites only relay
 * it); `nodeTool` narrows `ctx.host` and FORKS the inherited scratchpad
 * (never aliases — parallel tool calls would otherwise race).
 */

import type { ToolExecutionContext } from "@agentic-patterns/core";
import { Agent, Mission, Persona, RoleBuilder } from "@agentic-patterns/core";
import { MockLanguageModelV2 } from "ai/test";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AgentEventBus } from "../../events/agent-event-bus.js";
import type { AgentLike } from "../../runner/agent-runner.js";
import { AgentRunner } from "../../runner/agent-runner.js";
import { MockRunner } from "../../runner/mock-runner.js";
import { AgentStep } from "../agent-step.js";
import { CoordinatorStep } from "../coordinator-step.js";
import { depKey, provideDeps } from "../deps.js";
import { FunctionStep } from "../function-step.js";
import { NodeToolbox, nodeTool } from "../node-tool.js";
import { createScratchpad, slot } from "../slot.js";

function makeAgent(name: string, model = "mock"): AgentLike {
  return {
    role: { name },
    getModel: () => model,
    getTools: () => [],
    renderInitialPrompt: () => `init:${name}`,
  };
}

function coordinatorAgent(): Agent {
  const role = new RoleBuilder("CanvasAuthor")
    .withPersona(
      new Persona({
        identity: "routes work to the right specialist",
        tone: "direct",
        priorities: ["route correctly"],
        principles: ["delegate, never do the work directly"],
      }),
    )
    .withDefaultModel("outer-model")
    .build();
  return new Agent({
    role,
    mission: new Mission({
      objective: "author a canvas template",
      successCriteria: ["valid template"],
      constraints: [],
    }),
  });
}

// ---------------------------------------------------------------------------
// Test 1 — full rail: CoordinatorStep → real AgentRunner → delegated
// AgentStep subagent reads a root run-scoped slot.
// ---------------------------------------------------------------------------

describe("host propagation — coordinator → subagent, run-scoped slot (full rail)", () => {
  it("a delegated AgentStep subagent's prompt sees a run-scoped slot set on the root scratchpad", async () => {
    const sharedSlot = slot<string>({ key: "shared-ctx", scope: "run", init: () => "" });
    const rootScratchpad = createScratchpad();
    rootScratchpad.set(sharedSlot, "secret-value-123");

    // The delegated subagent — a plain AgentStep whose prompt reads the slot.
    const childRunner = new MockRunner().addResponse("*", { content: "child done" });
    const childNode = new AgentStep<{ task: string }, string>({
      name: "child",
      agent: makeAgent("child"),
      prompt: (input, scratchpad) => `${input.task}::${scratchpad.get(sharedSlot)}`,
    });
    const team = new NodeToolbox({
      name: "team",
      description: "team",
      runner: childRunner,
      tools: {
        child: {
          description: "invoke the child sub-agent",
          parameters: z.object({ task: z.string() }),
          node: childNode,
        },
      },
    });

    // The outer coordinator's LLM: one turn calling "child", then a final
    // text answer (tier 1 of runStructured's model-safe 2-tier path — the
    // mock model id doesn't match the tools+structured-output allowlist),
    // then a 3rd call for tier 2's structured finish.
    let outerCalls = 0;
    const outerModel = new MockLanguageModelV2({
      doGenerate: async () => {
        outerCalls++;
        if (outerCalls === 1) {
          return {
            content: [
              {
                type: "tool-call" as const,
                toolCallId: "outer-tc-1",
                toolName: "child",
                input: JSON.stringify({ task: "go" }),
              },
            ],
            finishReason: "tool-calls" as const,
            usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 },
            warnings: [],
          };
        }
        if (outerCalls === 2) {
          return {
            content: [{ type: "text" as const, text: "outer done" }],
            finishReason: "stop" as const,
            usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 },
            warnings: [],
          };
        }
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ title: "ok" }) }],
          finishReason: "stop" as const,
          usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 },
          warnings: [],
        };
      },
    });

    const sharedRunner = new AgentRunner(outerModel, new AgentEventBus());

    const Template = z.object({ title: z.string() });
    const author = new CoordinatorStep<{ instruction: string }, z.infer<typeof Template>>({
      name: "CanvasAuthor",
      agent: coordinatorAgent(),
      team,
      output: Template,
      prompt: (input) => input.instruction,
    });

    const result = await author.run(
      { instruction: "please delegate" },
      { runner: sharedRunner, scratchpad: rootScratchpad },
    );

    expect(result.succeeded).toBe(true);
    expect(result.output).toEqual({ title: "ok" });

    // The child saw the root's run-scoped value — proof of the full rail:
    // AgentStep.run → RunOptions.host → buildToolCtx → ToolExecutionContext.host
    // → nodeTool → fork() → the delegated AgentStep's prompt.
    expect(childRunner.callHistory).toHaveLength(1);
    expect(childRunner.callHistory[0]?.message).toBe("go::secret-value-123");
  });
});

// ---------------------------------------------------------------------------
// Test 2 — parallel branch isolation (unit-level, concurrency-shaped).
// ---------------------------------------------------------------------------

describe("host propagation — parallel branch isolation", () => {
  it("two parallel tool calls against the same host scratchpad don't clobber each other's branch-scoped writes", async () => {
    const branchLog = slot<string[]>({ key: "branch-log", scope: "branch", init: () => [] });
    const rootScratchpad = createScratchpad();
    const runner = new MockRunner();

    const worker = new FunctionStep<{ id: string }, string>({
      name: "worker",
      fn: (input, scratchpad) => {
        scratchpad.update(branchLog, (cur) => [...cur, input.id]);
        return scratchpad.get(branchLog).join(",");
      },
    });

    const tool = nodeTool(
      { description: "worker", parameters: z.object({ id: z.string() }), node: worker },
      runner,
    );

    const ctxA: ToolExecutionContext = { host: { scratchpad: rootScratchpad } };
    const ctxB: ToolExecutionContext = { host: { scratchpad: rootScratchpad } };

    const [outA, outB] = await Promise.all([
      tool.execute({ id: "a" }, ctxA),
      tool.execute({ id: "b" }, ctxB),
    ]);

    // Each call saw a fresh branch scope — no clobber, regardless of interleaving.
    expect(outA).toBe("a");
    expect(outB).toBe("b");
    // The parent's own branch scope was never touched — only forks were written.
    expect(rootScratchpad.get(branchLog)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Test 3 — root-declared deps reach a delegated subagent.
// ---------------------------------------------------------------------------

describe("host propagation — root deps reach the subagent", () => {
  it("a delegated FunctionStep reads a dep bound at the root via ctx.deps", async () => {
    const apiClientKey = depKey<string>("apiClient");
    const deps = provideDeps([[apiClientKey, "root-client"]]).build();
    const rootScratchpad = createScratchpad();
    const runner = new MockRunner();

    const reader = new FunctionStep<Record<string, never>, string>({
      name: "reader",
      fn: (_input, _scratchpad, ctx) => ctx.deps?.get(apiClientKey) ?? "MISSING",
    });

    const tool = nodeTool(
      { description: "reader", parameters: z.object({}), node: reader },
      runner,
    );

    const out = await tool.execute({}, { host: { scratchpad: rootScratchpad, deps } });
    expect(out).toBe("root-client");
  });
});

// ---------------------------------------------------------------------------
// Test 4 — fork semantics: run-scoped shares by reference, branch-scoped doesn't.
// ---------------------------------------------------------------------------

describe("host propagation — fork semantics at the seam", () => {
  it("child sees the parent's run-scoped value; child's run-scoped write is visible to the parent; child's branch-scoped write is not (no join in v1)", async () => {
    const runSlot = slot<string>({ key: "run-slot", scope: "run", init: () => "init" });
    const branchSlot = slot<string>({ key: "branch-slot", scope: "branch", init: () => "init" });

    const rootScratchpad = createScratchpad();
    rootScratchpad.set(runSlot, "from-parent");

    const runner = new MockRunner();
    const node = new FunctionStep<Record<string, never>, { run: string; branch: string }>({
      fn: (_input, scratchpad) => {
        const seen = scratchpad.get(runSlot);
        scratchpad.set(runSlot, "from-child");
        scratchpad.set(branchSlot, "child-write");
        return { run: seen, branch: scratchpad.get(branchSlot) };
      },
    });

    const tool = nodeTool({ description: "x", parameters: z.object({}), node }, runner);
    const out = await tool.execute({}, { host: { scratchpad: rootScratchpad } });

    expect(out).toEqual({ run: "from-parent", branch: "child-write" });
    // Run-scoped entries are shared by reference through the fork.
    expect(rootScratchpad.get(runSlot)).toBe("from-child");
    // Branch-scoped entries start fresh per fork and are discarded — no join() in v1.
    expect(rootScratchpad.get(branchSlot)).toBe("init");
  });
});

// ---------------------------------------------------------------------------
// Test 5 — precedence + back-compat.
// ---------------------------------------------------------------------------

describe("host propagation — precedence + back-compat", () => {
  it("host.scratchpad wins over the construction-time closure scratchpad", async () => {
    const precedenceSlot = slot<string>({
      key: "precedence-slot",
      scope: "run",
      init: () => "closure-default",
    });
    const closureScratchpad = createScratchpad();
    const hostScratchpad = createScratchpad();
    hostScratchpad.set(precedenceSlot, "host-value");

    const runner = new MockRunner();
    const node = new FunctionStep<Record<string, never>, string>({
      fn: (_input, scratchpad) => scratchpad.get(precedenceSlot),
    });
    const tool = nodeTool(
      { description: "x", parameters: z.object({}), node },
      runner,
      closureScratchpad,
    );

    const out = await tool.execute({}, { host: { scratchpad: hostScratchpad } });
    expect(out).toBe("host-value");
  });

  it("host.deps wins over the construction-time closure deps", async () => {
    const key = depKey<string>("client");
    const closureDeps = provideDeps([[key, "closure-client"]]).build();
    const hostDeps = provideDeps([[key, "host-client"]]).build();

    const runner = new MockRunner();
    const node = new FunctionStep<Record<string, never>, string>({
      fn: (_input, _scratchpad, ctx) => ctx.deps?.get(key) ?? "MISSING",
    });
    const tool = nodeTool(
      { description: "x", parameters: z.object({}), node },
      runner,
      undefined,
      closureDeps,
    );

    const out = await tool.execute({}, { host: { deps: hostDeps } });
    expect(out).toBe("host-client");
  });

  it("no ctx / no host → closure-or-fresh behavior is byte-identical to before #124", async () => {
    const precedenceSlot = slot<string>({
      key: "precedence-slot-2",
      scope: "run",
      init: () => "closure-default",
    });
    const closureScratchpad = createScratchpad();
    const runner = new MockRunner();
    const node = new FunctionStep<Record<string, never>, string>({
      fn: (_input, scratchpad) => scratchpad.get(precedenceSlot),
    });
    const tool = nodeTool(
      { description: "x", parameters: z.object({}), node },
      runner,
      closureScratchpad,
    );

    // No ctx at all.
    expect(await tool.execute({}, undefined)).toBe("closure-default");
    // ctx present but no host.
    expect(await tool.execute({}, {})).toBe("closure-default");
  });
});

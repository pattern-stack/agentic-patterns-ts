/**
 * #124 — Design A: the opaque `host` passthrough across the agent-as-tool
 * seam. `AgentStep.run` sets `RunOptions.host = { scratchpad, deps }`; the
 * runner copies it verbatim onto every `ToolExecutionContext` it builds
 * (`buildToolCtx`, the single copy site — the 3 dispatch sites only relay
 * it); `nodeTool` narrows `ctx.host` and FORKS the inherited scratchpad
 * (never aliases — parallel tool calls would otherwise race).
 */

import type { ToolExecutionContext } from "@agentic-patterns/core";
import { Agent, Capability, Mission, Persona, RoleBuilder, Toolbox } from "@agentic-patterns/core";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AgentEventBus } from "../../events/agent-event-bus.js";
import type { ToolCallStartEvent } from "../../events/types.js";
import type { AgentLike } from "../../runner/agent-runner.js";
import { AgentRunner } from "../../runner/agent-runner.js";
import { MockRunner } from "../../runner/mock-runner.js";
import type { RunOptions, RunResult, RunnerProtocol } from "../../runner/types.js";
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
    const outerModel = new MockLanguageModelV3({
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

// ---------------------------------------------------------------------------
// Test 6 — the run's EVENT BUS crosses the seam (the third leg: #124 threaded
// scratchpad+deps, #102 threaded trace ids; without this leg a delegated
// subagent on a construction-time runner publishes agent.* events to that
// runner's constructor-bound — or global-default — bus, invisible to the
// session that owns the run).
// ---------------------------------------------------------------------------

/** Records every RunOptions handed to `run` (mirrors agent-step.test.ts). */
function recordingRunner(captured: RunOptions[]): RunnerProtocol {
  return {
    async run(_agent: AgentLike, _message: string, options?: RunOptions): Promise<RunResult> {
      if (options) captured.push(options);
      return {
        response: "unused",
        inputTokens: 0,
        outputTokens: 0,
        toolCallsCount: 0,
        iterations: 1,
        finishReason: "stop",
      };
    },
  };
}

/** A real toolbox with one executable tool, so the child emits agent.tool.* events. */
class ProbeToolbox extends Toolbox {
  readonly name = "ledger";
  readonly description = "reads the household ledger";
  readonly tools = {
    getBalance: {
      description: "get a member's balance",
      parameters: z.object({ member: z.string() }),
      execute: async (args: Record<string, unknown>) => ({ member: args.member, balance: 42 }),
    },
  };
}

function agentWithProbe(): Agent {
  const role = new RoleBuilder("insights")
    .withPersona(
      new Persona({
        identity: "reads the household ledger",
        tone: "direct",
        priorities: ["accuracy"],
        principles: ["cite the ledger"],
      }),
    )
    .withCapability(new Capability("ledger", "ledger access", new ProbeToolbox()))
    .withDefaultModel("mock")
    .build();
  return new Agent({
    role,
    mission: new Mission({
      objective: "answer ledger questions",
      successCriteria: ["answered from the ledger"],
      constraints: [],
    }),
  });
}

describe("host propagation — event bus crosses the seam", () => {
  it("AgentStep threads ctx.eventBus into RunOptions.eventBus AND host.eventBus", async () => {
    const bus = new AgentEventBus();
    const captured: RunOptions[] = [];
    const step = new AgentStep<string, string>({
      name: "leaf",
      agent: makeAgent("leaf"),
      prompt: (input) => input,
    });

    await step.run("go", {
      runner: recordingRunner(captured),
      scratchpad: createScratchpad(),
      eventBus: bus,
    });

    expect(captured).toHaveLength(1);
    expect(captured[0]?.eventBus).toBe(bus);
    expect((captured[0]?.host as { eventBus?: AgentEventBus })?.eventBus).toBe(bus);
  });

  it("nodeTool re-roots the live caller's bus into the sub-run ctx (and stays absent without a host)", async () => {
    const bus = new AgentEventBus();
    const runner = new MockRunner();
    const probe = new FunctionStep<Record<string, never>, string>({
      fn: (_input, _scratchpad, ctx) =>
        ctx.eventBus === bus ? "same-bus" : ctx.eventBus === undefined ? "no-bus" : "other-bus",
    });
    const tool = nodeTool({ description: "x", parameters: z.object({}), node: probe }, runner);

    expect(
      await tool.execute({}, { host: { scratchpad: createScratchpad(), eventBus: bus } }),
    ).toBe("same-bus");
    // Back-compat: no host → no ambient bus, byte-identical to before.
    expect(await tool.execute({}, {})).toBe("no-bus");
  });

  it("full rail: a delegated subagent on a PRIVATE bus-less runner publishes its tool events on the session bus", async () => {
    const sessionBus = new AgentEventBus();
    const toolStarts: string[] = [];
    sessionBus.subscribe("agent.tool.start", (e) => {
      toolStarts.push((e as ToolCallStartEvent).toolName);
    });

    // The child: a real Agent with a real capability, whose model makes one
    // tool call then answers — run on a runner with NO constructor bus (the
    // production trap: it would fall back to the global default bus).
    let childCalls = 0;
    const childModel = new MockLanguageModelV3({
      doGenerate: async () => {
        childCalls++;
        if (childCalls === 1) {
          return {
            content: [
              {
                type: "tool-call" as const,
                toolCallId: "child-tc-1",
                toolName: "getBalance",
                input: JSON.stringify({ member: "sam" }),
              },
            ],
            finishReason: "tool-calls" as const,
            usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 },
            warnings: [],
          };
        }
        return {
          content: [{ type: "text" as const, text: "sam owes 42" }],
          finishReason: "stop" as const,
          usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 },
          warnings: [],
        };
      },
    });
    const privateChildRunner = new AgentRunner(childModel);

    const childNode = new AgentStep<{ task: string }, string>({
      name: "child",
      agent: agentWithProbe(),
      prompt: (input) => input.task,
    });
    const team = new NodeToolbox({
      name: "team",
      description: "team",
      runner: privateChildRunner,
      tools: {
        child: {
          description: "invoke the child sub-agent",
          parameters: z.object({ task: z.string() }),
          node: childNode,
        },
      },
    });

    // The outer coordinator's LLM: delegate to "child", then answer, then
    // tier 2's structured finish (same 3-call script as Test 1).
    let outerCalls = 0;
    const outerModel = new MockLanguageModelV3({
      doGenerate: async () => {
        outerCalls++;
        if (outerCalls === 1) {
          return {
            content: [
              {
                type: "tool-call" as const,
                toolCallId: "outer-tc-1",
                toolName: "child",
                input: JSON.stringify({ task: "balances please" }),
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
    const sessionRunner = new AgentRunner(outerModel, sessionBus);

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
      { runner: sessionRunner, scratchpad: createScratchpad(), eventBus: sessionBus },
    );
    // Let any fire-and-forget publishes settle before asserting.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(result.succeeded).toBe(true);
    // The delegation call itself (outer runner, constructor-bound to the bus)…
    expect(toolStarts).toContain("child");
    // …and the child's INNER tool call, published by the private bus-less
    // runner — only reaches the session bus because the bus rode the seam.
    expect(toolStarts).toContain("getBalance");
  });
});

// ---------------------------------------------------------------------------
// Test 7 — SessionScope crosses the seam (#308 D1): scope rides as a SIBLING
// `host.scope` key (never inside `host.deps`, which is a DepReader). Mirrors
// Test 3's (root deps) and Test 1's (full rail) shapes.
// ---------------------------------------------------------------------------

describe("host propagation — scope crosses the seam (#308)", () => {
  it("a delegated FunctionStep reads ctx.scope via nodeTool's host.scope forward (direct-execute)", async () => {
    const rootScratchpad = createScratchpad();
    const runner = new MockRunner();
    const parsedScope = { workspace: "acme", user: "sam@acme.dev" };

    const reader = new FunctionStep<Record<string, never>, Record<string, unknown> | undefined>({
      name: "reader",
      fn: (_input, _scratchpad, ctx) => ctx.scope,
    });

    const tool = nodeTool(
      { description: "reader", parameters: z.object({}), node: reader },
      runner,
    );

    const out = await tool.execute(
      {},
      { host: { scratchpad: rootScratchpad, scope: parsedScope } },
    );
    expect(out).toEqual(parsedScope);
  });

  it("no host.scope → ctx.scope stays undefined (no accidental default)", async () => {
    const rootScratchpad = createScratchpad();
    const runner = new MockRunner();

    const reader = new FunctionStep<Record<string, never>, Record<string, unknown> | undefined>({
      fn: (_input, _scratchpad, ctx) => ctx.scope,
    });
    const tool = nodeTool(
      { description: "reader", parameters: z.object({}), node: reader },
      runner,
    );

    const out = await tool.execute({}, { host: { scratchpad: rootScratchpad } });
    expect(out).toBeUndefined();
  });

  it("full rail: a scope set on the ROOT ctx survives CoordinatorStep -> AgentRunner -> nodeTool into a nested delegated node", async () => {
    const rootScratchpad = createScratchpad();
    const parsedScope = { workspace: "acme", user: "sam@acme.dev" };

    const capturedScopes: (Record<string, unknown> | undefined)[] = [];
    const childRunner = new MockRunner();
    const childNode = new FunctionStep<{ task: string }, string>({
      name: "child",
      fn: (_input, _scratchpad, ctx) => {
        capturedScopes.push(ctx.scope);
        return "child done";
      },
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

    // Same 3-call outer script as Test 1: delegate to "child", answer, then
    // tier 2's structured finish.
    let outerCalls = 0;
    const outerModel = new MockLanguageModelV3({
      doGenerate: async () => {
        outerCalls++;
        if (outerCalls === 1) {
          return {
            content: [
              {
                type: "tool-call" as const,
                toolCallId: "outer-tc-scope-1",
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
      { runner: sharedRunner, scratchpad: rootScratchpad, scope: parsedScope },
    );

    expect(result.succeeded).toBe(true);
    expect(result.output).toEqual({ title: "ok" });
    // The child saw the root's scope — proof of the full rail:
    // CoordinatorStep -> AgentStep.run -> RunOptions.host.scope -> buildToolCtx
    // -> ToolExecutionContext.host.scope -> nodeTool -> the delegated node's ctx.scope.
    expect(capturedScopes).toEqual([parsedScope]);
  });
});

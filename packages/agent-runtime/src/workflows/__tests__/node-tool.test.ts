import {
  Agent,
  Capability,
  Mission,
  Persona,
  RoleBuilder,
  ToolSchema,
  Toolbox,
} from "@agentic-patterns/core";
import { MockLanguageModelV2 } from "ai/test";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AgentEventBus } from "../../events/agent-event-bus.js";
import type { AgentEvent } from "../../events/types.js";
import type { ModelResolver } from "../../providers/model-resolver.js";
import type { AgentLike } from "../../runner/agent-runner.js";
import { AgentRunner } from "../../runner/agent-runner.js";
import { MockRunner } from "../../runner/mock-runner.js";
import { FunctionStep } from "../function-step.js";
import { NodeToolbox, delegateTo } from "../node-tool.js";
import type { NodeResult, NodeRunContext } from "../node.js";

describe("NodeToolbox (agent-as-a-tool)", () => {
  it("runs a wrapped Node and returns its typed output inline", async () => {
    const runner = new MockRunner();
    const double = new FunctionStep<{ n: number }, { result: number }>({
      name: "double",
      fn: ({ n }) => ({ result: n * 2 }),
    });
    const tb = new NodeToolbox({
      name: "math",
      description: "math sub-workflows",
      runner,
      tools: {
        double: {
          description: "double a number",
          parameters: z.object({ n: z.number() }),
          node: double,
        },
      },
    });

    // tools are discoverable as schemas (so the coordinator's LLM sees them)
    expect(tb.getToolNames()).toEqual(["double"]);

    const out = await tb.execute("double", { n: 21 });
    expect(out).toEqual({ result: 42 });
  });

  it("returns { error } when the wrapped Node fails — call-and-return, never throws", async () => {
    const runner = new MockRunner();
    const boom = new FunctionStep<{ x: number }, { y: number }>({
      name: "boom",
      fn: () => {
        throw new Error("kaboom");
      },
    });
    const tb = new NodeToolbox({
      name: "math",
      description: "math",
      runner,
      tools: {
        boom: { description: "always fails", parameters: z.object({ x: z.number() }), node: boom },
      },
    });

    const out = (await tb.execute("boom", { x: 1 })) as { error: string };
    expect(out.error).toContain("kaboom");
  });
});

describe("delegateTo (just pass subagents)", () => {
  function agent(name: string): AgentLike {
    return {
      role: { name },
      getModel: () => "mock",
      getTools: () => [],
      renderInitialPrompt: () => `you are ${name}`,
    };
  }

  it("wraps subagents as call-and-return tools the coordinator routes to", async () => {
    const runner = new MockRunner().addResponse("*", { content: "drafted the section" });
    const team = delegateTo(runner, [
      { agent: agent("writer"), description: "writes grounded sections from evidence" },
      { agent: agent("planner"), description: "allocates sections to evidence" },
    ]);

    // one tool per subagent, named by the agent — the LLM routes by description
    expect(team.getToolNames().sort()).toEqual(["planner", "writer"]);

    const out = await team.execute("writer", { task: "write the intro" });
    expect(out).toBe("drafted the section");
  });

  // -------------------------------------------------------------------------
  // Framework-gap fix: a delegated subagent gets an executor for its OWN tools.
  //
  // Before, `delegateTo` → `nodeTool` re-rooted the sub-run ctx WITHOUT a
  // toolExecutor and `AgentStep` only forwarded `ctx.toolExecutor`, so the
  // subagent's own tool calls returned "No tool executor configured" and it
  // answered "data unavailable". `AgentStep` now derives the executor from the
  // subagent's own capabilities. This proves the WHOLE seam end-to-end:
  // team.execute → nodeTool → AgentStep → runner.run → derived executor → tool.
  // -------------------------------------------------------------------------
  it("executes a delegated subagent's OWN toolbox tool through the team seam", async () => {
    class LedgerToolbox extends Toolbox {
      readonly name = "ledger";
      readonly description = "reads the household ledger";
      ran = 0;
      readonly tools = {
        getBalance: {
          description: "get a member's balance",
          parameters: z.object({ member: z.string() }),
          execute: async (args: Record<string, unknown>) => {
            this.ran++;
            return { member: args.member, balance: 42 };
          },
        },
      };
    }

    const tb = new LedgerToolbox();
    const insights = new Agent({
      role: new RoleBuilder("insights")
        .withPersona(
          new Persona({
            identity: "reads the household ledger",
            tone: "direct",
            priorities: ["accuracy"],
            principles: ["cite the ledger"],
          }),
        )
        .withCapability(new Capability("ledger", "ledger access", tb))
        .withDefaultModel("mock")
        .build(),
      mission: new Mission({
        objective: "answer ledger questions",
        successCriteria: ["answered from the ledger"],
        constraints: [],
      }),
    });

    // When the subagent runs, its LLM "calls" getBalance. MockRunner.run
    // dispatches configured toolCalls through `options.toolExecutor` — which is
    // now the executor AgentStep derives from the subagent's own capabilities.
    const runner = new MockRunner().addResponse("*", {
      content: "dana's balance is 42",
      toolCalls: [{ name: "getBalance", arguments: { member: "dana" } }],
    });

    const team = delegateTo(runner, [{ agent: insights, description: "answers ledger questions" }]);

    const out = await team.execute("insights", { task: "what is dana's balance?" });

    expect(out).toBe("dana's balance is 42");
    expect(tb.ran).toBe(1); // the subagent's OWN tool actually executed
  });
});

// ---------------------------------------------------------------------------
// #102 headline test — child tool calls nest under the parent (m.b)
//
// A NodeToolbox tool wraps a custom Node whose `run()` drives a REAL nested
// AgentRunner call (mirroring what an AgentStep-backed node-tool does). The
// wrapped node's sub-agent itself makes a tool call. We assert the child's
// `agent.tool.*` events land on the SAME (shared) bus, carry the PARENT run's
// traceId (not an orphan trace), and their ancestry — via `parentSpanId` —
// chains back to the outer tool call that invoked the child, exercising the
// exact `node-tool.ts` correlation threading added in #102.
// ---------------------------------------------------------------------------

describe("NodeToolbox — child→parent bus propagation (#102, m.b headline test)", () => {
  function agentLike(name: string, model: string, tools: ToolSchema[] = []): AgentLike {
    return {
      role: { name },
      getModel: () => model,
      getTools: () => tools,
      renderInitialPrompt: () => `you are ${name}`,
    };
  }

  it("nests the child sub-agent's tool events under the invoking tool call", async () => {
    // Outer agent's LLM: one turn calling the "child" node-tool, then a final answer.
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
        return {
          content: [{ type: "text" as const, text: "outer done" }],
          finishReason: "stop" as const,
          usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 },
          warnings: [],
        };
      },
    });

    // Child (nested sub-agent)'s LLM: makes its OWN tool call, then finishes.
    let childCalls = 0;
    const childModel = new MockLanguageModelV2({
      doGenerate: async () => {
        childCalls++;
        if (childCalls === 1) {
          return {
            content: [
              {
                type: "tool-call" as const,
                toolCallId: "child-tc-1",
                toolName: "leaf_tool",
                input: JSON.stringify({}),
              },
            ],
            finishReason: "tool-calls" as const,
            usage: { inputTokens: 3, outputTokens: 3, totalTokens: 6 },
            warnings: [],
          };
        }
        return {
          content: [{ type: "text" as const, text: "child done" }],
          finishReason: "stop" as const,
          usage: { inputTokens: 3, outputTokens: 3, totalTokens: 6 },
          warnings: [],
        };
      },
    });

    const resolver: ModelResolver = {
      resolve: async (modelId) => {
        if (modelId === "outer-model") return outerModel;
        if (modelId === "child-model") return childModel;
        throw new Error(`unexpected model id ${modelId}`);
      },
    };

    // Shared-runner invariant (#102 Decision §4): outer and child run on the
    // SAME runner instance, so the child's events land on the same bus.
    const sharedBus = new AgentEventBus();
    const sharedRunner = new AgentRunner(resolver, sharedBus);

    const outerTools = [
      ToolSchema.fromZod("child", "invoke the child sub-agent", z.object({ task: z.string() })),
    ];
    const outerAgent = agentLike("outer", "outer-model", outerTools);

    const leafToolSchema = [ToolSchema.fromZod("leaf_tool", "a leaf tool", z.object({}))];
    const childAgent = agentLike("child", "child-model", leafToolSchema);

    let leafToolRan = false;
    const childExecutor = {
      execute: async () => {
        leafToolRan = true;
      },
    };

    // A Node whose run() forwards the parent-threaded traceId/parentSpanId
    // (per node-tool.ts, #102) into a nested `sharedRunner.run()` call — the
    // same shape node-tool.ts's `nodeTool()` builds for an AgentStep.
    const childNode = {
      name: "childNode",
      async run(input: { task: string }, ctx: NodeRunContext): Promise<NodeResult<string>> {
        const result = await ctx.runner.run(childAgent, input.task, {
          traceId: ctx.traceId,
          parentSpanId: ctx.parentSpanId,
          toolExecutor: childExecutor,
        });
        return {
          output: result.response,
          succeeded: true,
          totalInputTokens: result.inputTokens,
          totalOutputTokens: result.outputTokens,
        };
      },
    };

    const team = new NodeToolbox({
      name: "team",
      description: "team",
      runner: sharedRunner,
      tools: {
        child: {
          description: "invoke the child sub-agent",
          parameters: z.object({ task: z.string() }),
          node: childNode,
        },
      },
    });

    const captured: AgentEvent[] = [];
    for (const type of [
      "agent.message.start",
      "agent.iteration.start",
      "agent.tool.start",
      "agent.tool.end",
    ] as const) {
      sharedBus.subscribe(type, (e) => captured.push(e as AgentEvent));
    }

    // team IS a Toolbox (execute(name, args, ctx?)) — assignment-compatible
    // with ToolExecutor, exercising the exact production `execute()` path.
    const result = await sharedRunner.run(outerAgent, "please delegate", { toolExecutor: team });

    expect(result.response).toBe("outer done");
    expect(leafToolRan).toBe(true);

    // The outer's own tool.start for calling "child" — the RESOLVED span the
    // child run should nest under (its `spanId`, not the `toolCallId` string
    // in isolation — #102 fix: `agent.tool.start` is stamped with
    // `spanId: toolCallId`, so these coincide, but the test must prove the
    // JOIN resolves to a real span rather than baking in the string).
    const outerToolStart = captured.find(
      (e) =>
        e.type === "agent.tool.start" && (e as { toolCallId: string }).toolCallId === "outer-tc-1",
    );
    expect(outerToolStart).toBeDefined();
    const outerTraceId = outerToolStart?.traceId;

    // The child run's root event (message.start) — one hop of ancestry: its
    // parentSpanId resolves to the outer's invoking tool call's ACTUAL spanId
    // (not a string literal baked into the test).
    const childMessageStart = captured.find(
      (e) => e.type === "agent.message.start" && (e as { agentName: string }).agentName === "child",
    );
    expect(childMessageStart).toBeDefined();
    expect(childMessageStart?.traceId).toBe(outerTraceId);
    expect(childMessageStart?.parentSpanId).toBe(outerToolStart?.spanId);
    const childRootSpanId = childMessageStart?.spanId;

    // The child's OWN tool.start/tool.end (for "leaf_tool") — NOT an orphan
    // trace: same traceId as the outer run, and its ancestry (via
    // iteration.start → message.start) chains back to the outer's span.
    const childToolStart = captured.find(
      (e) =>
        e.type === "agent.tool.start" && (e as { toolCallId: string }).toolCallId === "child-tc-1",
    );
    const childToolEnd = captured.find(
      (e) =>
        e.type === "agent.tool.end" && (e as { toolCallId: string }).toolCallId === "child-tc-1",
    );
    expect(childToolStart).toBeDefined();
    expect(childToolEnd).toBeDefined();
    expect(childToolStart?.traceId).toBe(outerTraceId);
    expect(childToolEnd?.traceId).toBe(outerTraceId);

    const childIterStart = captured.find(
      (e) =>
        e.type === "agent.iteration.start" &&
        e.traceId === outerTraceId &&
        e.runId === childToolStart?.runId,
    );
    expect(childIterStart).toBeDefined();
    expect(childIterStart?.parentSpanId).toBe(childRootSpanId);
    expect(childToolStart?.parentSpanId).toBe(childIterStart?.spanId);

    // Reconstruction assertion: build a spanId-keyed map of EVERY captured
    // event (mirroring how a real span exporter, e.g. otel.ts, resolves
    // parentage — `_spans.get(event.parentSpanId)`) and assert every event
    // with a `parentSpanId` resolves to a KNOWN span in the whole trace. No
    // orphan roots anywhere in the nested tree.
    const spansById = new Map(captured.map((e) => [e.spanId, e]));
    for (const e of captured) {
      if (e.parentSpanId !== undefined) {
        expect(
          spansById.has(e.parentSpanId),
          `event ${e.type} (spanId=${e.spanId}) has parentSpanId=${e.parentSpanId} which resolves to no captured span — orphan root`,
        ).toBe(true);
      }
    }
  });
});

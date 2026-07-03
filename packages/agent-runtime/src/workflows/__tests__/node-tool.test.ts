import { ToolSchema } from "@agentic-patterns/core";
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
      getSystemPrompt: () => `you are ${name}`,
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
      getSystemPrompt: () => `you are ${name}`,
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

    // The outer's own tool.start for calling "child".
    const outerToolStart = captured.find(
      (e) =>
        e.type === "agent.tool.start" && (e as { toolCallId: string }).toolCallId === "outer-tc-1",
    );
    expect(outerToolStart).toBeDefined();
    const outerTraceId = outerToolStart?.traceId;

    // The child run's root event (message.start) — one hop of ancestry: its
    // parentSpanId IS the outer's invoking `toolCallId` ("outer-tc-1"), NOT a
    // freshly-generated spanId. Per #102 Decision §3 (Gate-1 confirmed): the
    // ToolExecutionContext exposes only `parentToolCallId` (never a bus-level
    // spanId — core stays vendor-neutral), and node-tool.ts reuses THAT as the
    // nesting anchor — the tool call's id IS its parent span for this purpose.
    const childMessageStart = captured.find(
      (e) => e.type === "agent.message.start" && (e as { agentName: string }).agentName === "child",
    );
    expect(childMessageStart).toBeDefined();
    expect(childMessageStart?.traceId).toBe(outerTraceId);
    expect(childMessageStart?.parentSpanId).toBe("outer-tc-1");
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
  });
});

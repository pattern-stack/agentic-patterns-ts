import {
  Agent,
  Capability,
  Mission,
  Persona,
  RoleBuilder,
  Toolbox,
} from "@pattern-stack/agentic-core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { AgentLike } from "../../runner/agent-runner.js";
import type { RunOptions, RunResult, RunnerProtocol, ToolExecutor } from "../../runner/types.js";
import { AgentStep } from "../agent-step.js";

// ---------------------------------------------------------------------------
// Self-derived tool executor (framework-gap fix)
//
// An `AgentStep` leaf used to get NO executor for its OWN tools unless one was
// handed to it in `ctx.toolExecutor`. `nodeTool` deliberately re-roots the
// sub-run ctx WITHOUT an executor (a subagent must run its own tools, not the
// parent's), and a bare pipeline never sets one — so the running agent's tool
// calls silently returned `{ error: "No tool executor configured" }` and it
// answered "data unavailable". `AgentStep.run` now DERIVES an executor from the
// agent it is about to run (its tools ARE its own capabilities) when none is
// ambient; an explicit executor still wins; a capability-less agent is
// byte-identical to before.
// ---------------------------------------------------------------------------

/** A real toolbox with one executable tool, counting how often it ran. */
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

/** A full core Agent carrying the ledger toolbox as a real Capability. */
function agentWithLedger(tb: Toolbox): Agent {
  const role = new RoleBuilder("insights")
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

/**
 * A runner stub that records the `RunOptions` it was called with (mirrors the
 * `recordingRunner` pattern in coordinator-step.test.ts) so we can assert what
 * executor reached the runner — without a real LLM. It never invokes tools
 * itself, so the derived executor is exercised by calling it directly.
 */
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

describe("AgentStep — self-derived tool executor", () => {
  it("derives an executor from the agent's own capabilities when ctx carries none, and it dispatches to the real tool", async () => {
    const captured: RunOptions[] = [];
    const tb = new LedgerToolbox();
    const step = new AgentStep<{ q: string }, string>({
      name: "insights",
      agent: agentWithLedger(tb),
      prompt: (i) => i.q, // no output schema → the string (generateText) path
    });

    await step.run({ q: "what is dana's balance?" }, { runner: recordingRunner(captured) });

    // The executor ARRIVED in the runner's RunOptions.
    expect(captured.length).toBe(1);
    const executor = captured[0]?.toolExecutor;
    expect(executor).toBeDefined();
    if (!executor) throw new Error("expected a derived toolExecutor");

    // Dispatch-level proof: the derived executor actually hits the agent's real
    // toolbox tool (recordingRunner never invokes tools on its own).
    const out = await executor.execute("getBalance", { member: "dana" });
    expect(out).toEqual({ member: "dana", balance: 42 });
    expect(tb.ran).toBe(1);
  });

  it("forwards an explicitly-provided ctx.toolExecutor unchanged (explicit wins over self-derive)", async () => {
    const captured: RunOptions[] = [];
    const tb = new LedgerToolbox();
    const sentinel: ToolExecutor = { execute: async () => "sentinel" };
    const step = new AgentStep<{ q: string }, string>({
      name: "insights",
      agent: agentWithLedger(tb),
      prompt: (i) => i.q,
    });

    await step.run({ q: "x" }, { runner: recordingRunner(captured), toolExecutor: sentinel });

    // Identity: the caller's executor is used verbatim, never the derived one.
    expect(captured[0]?.toolExecutor).toBe(sentinel);
    expect(tb.ran).toBe(0);
  });

  it("leaves toolExecutor unset for a capability-less agent (byte-identical to before)", async () => {
    const captured: RunOptions[] = [];
    const bare: AgentLike = {
      role: { name: "bare" },
      getModel: () => "mock",
      getTools: () => [],
      renderInitialPrompt: () => "you are bare",
    };
    const step = new AgentStep<{ q: string }, string>({
      name: "bare",
      agent: bare,
      prompt: (i) => i.q,
    });

    await step.run({ q: "x" }, { runner: recordingRunner(captured) });

    expect(captured[0]?.toolExecutor).toBeUndefined();
  });
});

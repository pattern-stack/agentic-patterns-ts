/**
 * runFromTrigger falsifiers (#437 M2) — each test guards one of the seam's
 * stated guarantees: schema validation at entry, registry-mediated resolution,
 * pre-correlated runId, trigger/scope threading, executor derivation.
 */

import { describe, expect, it } from "vitest";

import type { TriggerSourceData } from "@pattern-stack/agentic-core";

import type { AgentLike, RunOptions, RunResult, RunnerProtocol } from "../../runner/types.js";
import type { AgentRegistry } from "../registry.js";
import { runFromTrigger } from "../run-from-trigger.js";

const TRIGGER: TriggerSourceData = {
  kind: "schedule",
  label: "morning-brief",
  firedAt: "2026-08-08T09:00:00.000Z",
};

const RESULT: RunResult = {
  response: "ok",
  inputTokens: 1,
  outputTokens: 1,
  toolCallsCount: 0,
  iterations: 1,
  finishReason: "stop",
};

function bareAgent(name: string): AgentLike {
  return {
    role: { name },
    getModel: () => "test-model",
    getTools: () => [],
    renderInitialPrompt: () => `You are ${name}.`,
  };
}

/** A capturing runner + a one-agent registry that records resolve() calls. */
function harness(agent: AgentLike = bareAgent("analyst")) {
  const calls: { agent: AgentLike; message: string; options?: RunOptions }[] = [];
  const runner: RunnerProtocol = {
    run: async (a, message, options) => {
      calls.push({ agent: a, message, options });
      return RESULT;
    },
  };
  const resolved: { id: string; scope?: Record<string, unknown> }[] = [];
  const registry: AgentRegistry = {
    list: () => [{ id: "acme/analyst", name: "Analyst" }],
    resolve: async (id, scope) => {
      resolved.push({ id, scope });
      if (id !== "acme/analyst") throw new Error(`unknown agent '${id}'`);
      return agent;
    },
  };
  return { runner, registry, calls, resolved };
}

describe("runFromTrigger (#437)", () => {
  it("resolves through the registry (id + scope) and returns the runner's result", async () => {
    const { runner, registry, calls, resolved } = harness();
    const handle = await runFromTrigger(
      { registry, runner },
      {
        agentId: "acme/analyst",
        input: "brief me",
        trigger: TRIGGER,
        scope: { tenant: "t1" },
      },
    );
    expect(resolved).toEqual([{ id: "acme/analyst", scope: { tenant: "t1" } }]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.message).toBe("brief me");
    expect(handle.result).toBe(RESULT);
    expect(handle.agentId).toBe("acme/analyst");
  });

  it("pre-correlates: caller runId is passed down; absent → minted BEFORE the run and passed down", async () => {
    const { runner, registry, calls } = harness();
    const withId = await runFromTrigger(
      { registry, runner },
      { agentId: "acme/analyst", input: "x", trigger: TRIGGER, runId: "job-77" },
    );
    expect(withId.runId).toBe("job-77");
    expect(calls[0]?.options?.runId).toBe("job-77");

    const minted = await runFromTrigger(
      { registry, runner },
      { agentId: "acme/analyst", input: "x", trigger: TRIGGER },
    );
    expect(minted.runId).toBeTruthy();
    expect(calls[1]?.options?.runId).toBe(minted.runId);
  });

  it("threads the validated trigger and the scope host into RunOptions", async () => {
    const { runner, registry, calls } = harness();
    await runFromTrigger(
      { registry, runner },
      {
        agentId: "acme/analyst",
        input: "x",
        trigger: TRIGGER,
        scope: { tenant: "t1" },
      },
    );
    const options = calls[0]?.options;
    expect(options?.trigger).toEqual(TRIGGER);
    const host = options?.host as { scope?: Record<string, unknown> } | undefined;
    expect(host?.scope).toEqual({ tenant: "t1" });
    expect(Object.isFrozen(host?.scope)).toBe(true);
  });

  it("rejects a malformed trigger at the seam — the runner is never called", async () => {
    const { runner, registry, calls } = harness();
    await expect(
      runFromTrigger(
        { registry, runner },
        {
          agentId: "acme/analyst",
          input: "x",
          trigger: { kind: "schedule", firedAt: "yesterday" } as TriggerSourceData,
        },
      ),
    ).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it("propagates an unknown-agent rejection from the registry", async () => {
    const { runner, registry } = harness();
    await expect(
      runFromTrigger({ registry, runner }, { agentId: "acme/nope", input: "x", trigger: TRIGGER }),
    ).rejects.toThrow("unknown agent 'acme/nope'");
  });

  it("derives the tool executor from a capability-bearing agent; caller override wins", async () => {
    const seen: string[] = [];
    const capAgent = {
      ...bareAgent("cap-agent"),
      role: {
        name: "cap-agent",
        capabilities: [
          {
            name: "demo",
            toolbox: {
              name: "demo",
              tools: { ping: {} },
              execute: async (name: string) => {
                seen.push(name);
                return "pong";
              },
            },
          },
        ],
      },
    } as unknown as AgentLike;
    const { runner, registry, calls } = harness(capAgent);

    await runFromTrigger(
      { registry, runner },
      { agentId: "acme/analyst", input: "x", trigger: TRIGGER },
    );
    expect(calls[0]?.options?.toolExecutor).toBeDefined();

    const override = { execute: async () => "override" };
    await runFromTrigger(
      { registry, runner, toolExecutor: override },
      { agentId: "acme/analyst", input: "x", trigger: TRIGGER },
    );
    expect(calls[1]?.options?.toolExecutor).toBe(override);
  });

  it("a capability-less agent runs tool-less (no executor forced)", async () => {
    const { runner, registry, calls } = harness(bareAgent("plain"));
    await runFromTrigger(
      { registry, runner },
      { agentId: "acme/analyst", input: "x", trigger: TRIGGER },
    );
    expect(calls[0]?.options?.toolExecutor).toBeUndefined();
  });
});

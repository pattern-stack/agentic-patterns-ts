/**
 * `CodingAgentRunner` — per-call event-bus resolution (#496).
 *
 * `_startRun` used to rebind `this._eventBus` from `options.eventBus`,
 * identically to `AgentRunner`'s sticky-bus bug. The bus now resolves once
 * per call (`busFor`) and rides the `_startRun` prep; the field is never
 * assigned outside the constructor. This suite pins the new semantics on
 * the base class the same way `agent-runner-event-bus.test.ts` does for
 * `AgentRunner`.
 */

import { describe, expect, it } from "vitest";

import { AgentEventBus } from "../../../events/agent-event-bus.js";
import type { AgentEvent } from "../../../events/types.js";
import type { AgentLike } from "../../types.js";
import { CodingAgentRunner } from "../coding-agent-runner.js";
import type {
  DecisionVocabulary,
  HarnessAdapter,
  HarnessEvent,
  HarnessProbeResult,
  HarnessRunRequest,
  HarnessSession,
} from "../types.js";

// ---------------------------------------------------------------------------
// Fakes — minimal versions of coding-agent-runner-abort.test.ts's fixtures:
// a session that yields nothing and ends cleanly, so run() completes.
// ---------------------------------------------------------------------------

class FakeSession implements HarnessSession {
  async *[Symbol.asyncIterator](): AsyncGenerator<HarnessEvent> {
    // No events — the run finalizes with empty accounting.
  }

  async respond(): Promise<void> {}
  async interrupt(): Promise<void> {}
  async close(): Promise<void> {}
}

const PROBE_OK: HarnessProbeResult = {
  ok: true,
  issues: [],
  authMode: "subscription",
  enforcement: {
    shell: "enforcing",
    "file-change": "enforcing",
    "mcp-tool": "enforcing",
    "local-tool": "enforcing",
    subagent: "enforcing",
    "hosted-tool": "advisory",
  },
  sandbox: { networkPolicy: "none" },
  features: {
    interactiveAsk: true,
    resume: true,
    partialStreaming: true,
    inputRewrite: true,
    durableRules: true,
  },
};

class FakeAdapter implements HarnessAdapter<AgentLike> {
  readonly name = "fake-harness";
  readonly decisionVocabulary: DecisionVocabulary = {};

  async probe(): Promise<HarnessProbeResult> {
    return PROBE_OK;
  }

  async start(_req: HarnessRunRequest<AgentLike>): Promise<HarnessSession> {
    return new FakeSession();
  }
}

class FakeRunner extends CodingAgentRunner<AgentLike> {
  protected createAdapter(): HarnessAdapter<AgentLike> {
    return new FakeAdapter();
  }
}

function makeAgent(): AgentLike {
  return {
    role: { name: "test-agent" },
    getModel: () => "claude-sonnet-4-6",
    getTools: () => [],
    renderInitialPrompt: () => "system",
  };
}

function collect(bus: AgentEventBus): AgentEvent[] {
  const events: AgentEvent[] = [];
  for (const t of ["agent.message.start", "agent.message.complete"] as const) {
    bus.subscribe(t, (e) => {
      events.push(e as AgentEvent);
    });
  }
  return events;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CodingAgentRunner — per-call event bus (#496)", () => {
  it("PINS the #496 behaviour change: a per-call bus does not stick — the next bus-less call falls back to the constructor bus, not the previous call's", async () => {
    const constructorBus = new AgentEventBus();
    const busX = new AgentEventBus();
    const constructorEvents = collect(constructorBus);
    const xEvents = collect(busX);

    const runner = new FakeRunner(constructorBus);
    const agent = makeAgent();

    await runner.run(agent, "first", { runId: "run-1", eventBus: busX });
    await runner.run(agent, "second", { runId: "run-2" });

    // Call 1 published to X, and ONLY call 1 did.
    expect(xEvents.length).toBeGreaterThan(0);
    expect(xEvents.every((e) => e.runId === "run-1")).toBe(true);

    // Call 2 fell back to the constructor bus — the old sticky rebind would
    // have kept publishing to X.
    expect(constructorEvents.length).toBeGreaterThan(0);
    expect(constructorEvents.every((e) => e.runId === "run-2")).toBe(true);
    expect(constructorEvents.some((e) => e.type === "agent.message.complete")).toBe(true);
  });
});

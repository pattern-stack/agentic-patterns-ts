/**
 * #437 M2 trigger contract — runtime plumbing falsifiers.
 *
 * RunOptions.trigger must ride message.start verbatim on every AgentRunner
 * path; a caller-provided RunOptions.runId must be honored (AP-29 F1); and
 * RunStoreExporter must persist the provenance under metadata.trigger with a
 * host `metadataFor` merging OVER it. Absent trigger/runId → byte-identical
 * prior behavior.
 */

import { MockLanguageModelV3 } from "ai/test";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import type { TriggerSourceData } from "@agentic-patterns/core";

import { AgentEventBus } from "../../events/agent-event-bus.js";
import type { MessageStartEvent } from "../../events/types.js";
import { RunStoreExporter } from "../../exporters/run-store.js";
import { RunStore } from "../../storage/run-store.js";
import { AgentRunner } from "../agent-runner.js";

const TRIGGER: TriggerSourceData = {
  kind: "schedule",
  sourceId: "sched-1",
  label: "morning-brief",
  firedAt: "2026-08-08T09:00:00.000Z",
  correlationId: "job-42",
};

function textModel(): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: "text" as const, text: "ok" }],
      finishReason: { unified: "stop" as const, raw: "stop" },
      usage: {
        inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 1, text: 1, reasoning: undefined },
      },
      warnings: [],
    }),
  });
}

const AGENT = {
  role: { name: "trigger-test-agent" },
  getModel: () => "test-model",
  getTools: () => [],
  renderInitialPrompt: () => "You are a test agent.",
};

async function captureStart(
  run: (runner: AgentRunner, bus: AgentEventBus) => Promise<void>,
): Promise<MessageStartEvent> {
  const bus = new AgentEventBus();
  const starts: MessageStartEvent[] = [];
  bus.subscribe("agent.message.start", (e) => starts.push(e as MessageStartEvent));
  const runner = new AgentRunner(textModel(), bus);
  await run(runner, bus);
  expect(starts).toHaveLength(1);
  const first = starts[0];
  if (first === undefined) throw new Error("unreachable: length asserted above");
  return first;
}

describe("RunOptions.trigger → message.start (#437)", () => {
  it("run(): stamps the trigger verbatim and honors the caller runId", async () => {
    const start = await captureStart(async (runner) => {
      await runner.run(AGENT, "hi", { runId: "host-run-7", trigger: TRIGGER });
    });
    expect(start.runId).toBe("host-run-7");
    expect(start.trigger).toEqual(TRIGGER);
  });

  it("stream(): stamps the trigger verbatim and honors the caller runId", async () => {
    const start = await captureStart(async (runner) => {
      for await (const _e of runner.stream(AGENT, "hi", {
        runId: "host-run-8",
        trigger: TRIGGER,
      })) {
        // drain
      }
    });
    expect(start.runId).toBe("host-run-8");
    expect(start.trigger).toEqual(TRIGGER);
  });

  it("absent → minted runId and no trigger field (byte-identical prior behavior)", async () => {
    const start = await captureStart(async (runner) => {
      await runner.run(AGENT, "hi");
    });
    expect(start.runId).toBeTruthy();
    expect(start.runId).not.toBe("host-run-7");
    expect(start.trigger).toBeUndefined();
  });
});

describe("RunStoreExporter persists metadata.trigger (#437)", () => {
  function exporterHarness(metadataFor?: (e: MessageStartEvent) => Record<string, unknown>) {
    const store = new RunStore({ path: ":memory:", Database });
    const exporter = new RunStoreExporter({ store, ...(metadataFor ? { metadataFor } : {}) });
    const bus = new AgentEventBus();
    exporter.attach(bus);
    return { store, bus };
  }

  it("stamps event.trigger under metadata.trigger with no host metadataFor", async () => {
    const { store, bus } = exporterHarness();
    const runner = new AgentRunner(textModel(), bus);
    await runner.run(AGENT, "hi", { runId: "host-run-9", trigger: TRIGGER });
    const row = store.getRun("host-run-9");
    expect(row?.metadata).toEqual({ trigger: TRIGGER });
  });

  it("host metadataFor merges OVER the stamped trigger", async () => {
    const { store, bus } = exporterHarness(() => ({ variant: "a", trigger: "host-wins" }));
    const runner = new AgentRunner(textModel(), bus);
    await runner.run(AGENT, "hi", { runId: "host-run-10", trigger: TRIGGER });
    const row = store.getRun("host-run-10");
    expect(row?.metadata).toEqual({ variant: "a", trigger: "host-wins" });
  });

  it("no trigger and no metadataFor → metadata stays null (prior behavior)", async () => {
    const { store, bus } = exporterHarness();
    const runner = new AgentRunner(textModel(), bus);
    await runner.run(AGENT, "hi", { runId: "host-run-11" });
    const row = store.getRun("host-run-11");
    expect(row?.metadata).toBeNull();
  });
});

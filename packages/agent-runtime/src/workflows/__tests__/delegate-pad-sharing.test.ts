/**
 * #269 — `delegateTo` shares the live caller's scratchpad through a fork on
 * both runner rails. Run-scoped backpack state crosses the delegation seam by
 * reference, branch-scoped state stays isolated, and the fork is observable.
 */

import type { ToolExecutionContext } from "@pattern-stack/agentic-core";
import {
  Agent,
  Capability,
  Mission,
  Persona,
  RoleBuilder,
  Toolbox,
} from "@pattern-stack/agentic-core";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AgentEventBus } from "../../events/agent-event-bus.js";
import type { ScratchpadForkEvent } from "../../events/types.js";
import { AgentRunner } from "../../runner/agent-runner.js";
import { MockRunner } from "../../runner/mock-runner.js";
import { AgentStep } from "../agent-step.js";
import { type BackpackSpec, type Scratchpad, readBackpack, requireBackpack } from "../index.js";
import { delegateTo } from "../node-tool.js";
import { ObservedScratchpad } from "../observed-scratchpad.js";
import { createScratchpad, slot } from "../slot.js";
import { createStateEmitter } from "../state-events.js";

interface Note {
  readonly id: string;
  readonly text: string;
}

const notesPack: BackpackSpec<Note, Note, readonly Note[], string> = {
  key: "notes",
  expand: (note) => note,
  identify: (note) => note.id,
  finalize: (entries) => entries,
};

const delegatedBranchSlot = slot<string>({
  key: "delegate.branch-note",
  scope: "branch",
  init: () => "initial",
});

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
} as const;

function agentWithToolbox(name: string, toolbox: Toolbox): Agent {
  const role = new RoleBuilder(name)
    .withPersona(
      new Persona({
        identity: `${name} agent`,
        tone: "direct",
        priorities: ["use tools"],
        principles: ["complete the assigned task"],
      }),
    )
    .withCapability(new Capability(toolbox.name, toolbox.description, toolbox))
    .withDefaultModel("mock")
    .build();

  return new Agent({
    role,
    mission: new Mission({
      objective: `${name} work`,
      successCriteria: ["task completed"],
      constraints: [],
    }),
  });
}

interface DelegateFlow {
  readonly childRunner: MockRunner;
  readonly coordinatorStep: AgentStep<string, string>;
  readonly childSaw: () => readonly Note[];
}

function createDelegateFlow(): DelegateFlow {
  let seenByChild: readonly Note[] = [];

  class NotesToolbox extends Toolbox {
    readonly name = "notes-tools";
    readonly description = "adds notes to the shared backpack";
    readonly tools = {
      add_note: {
        description: "add a note",
        parameters: z.object({}),
        execute: async (_args: Record<string, unknown>, ctx?: ToolExecutionContext) => {
          const pack = requireBackpack(ctx, notesPack);
          seenByChild = pack.entries();
          pack.drop({ id: "c1", text: "from-child" }, "child");

          const host = ctx?.host as { scratchpad?: Scratchpad } | undefined;
          host?.scratchpad?.set(delegatedBranchSlot, "from-child");
          return { added: "c1" };
        },
      },
    };
  }

  const childAgent = agentWithToolbox("notes", new NotesToolbox());
  const childRunner = new MockRunner().addResponse("*", {
    content: "child done",
    toolCalls: [{ name: "add_note", arguments: {} }],
  });
  const team = delegateTo(childRunner, [
    {
      agent: childAgent,
      name: "notes",
      description: "adds a note to the shared run backpack",
    },
  ]);
  const coordinatorAgent = agentWithToolbox("coordinator", team);
  const coordinatorStep = new AgentStep<string, string>({
    name: "coordinator",
    agent: coordinatorAgent,
    prompt: (input) => input,
  });

  return {
    childRunner,
    coordinatorStep,
    childSaw: () => seenByChild,
  };
}

function seedParentNote(scratchpad: Scratchpad): void {
  readBackpack(scratchpad, notesPack, "seed").drop({ id: "p1", text: "from-parent" }, "seed");
}

function mockCoordinatorRunner(): MockRunner {
  return new MockRunner().addResponse("*", {
    content: "coordinator done",
    toolCalls: [{ name: "notes", arguments: { task: "add the child note" } }],
  });
}

describe("delegateTo scratchpad sharing (#269)", () => {
  it("T1 — MockRunner shares run-scoped backpack state parent→child and child→parent", async () => {
    const rootScratchpad = createScratchpad();
    seedParentNote(rootScratchpad);
    const coordinatorRunner = mockCoordinatorRunner();
    const flow = createDelegateFlow();

    const result = await flow.coordinatorStep.run("delegate a note", {
      runner: coordinatorRunner,
      scratchpad: rootScratchpad,
    });

    expect(result.succeeded).toBe(true);
    expect(flow.childSaw()).toEqual([{ id: "p1", text: "from-parent" }]);
    expect(readBackpack(rootScratchpad, notesPack, "assert").entries()).toContainEqual({
      id: "c1",
      text: "from-child",
    });
    expect(coordinatorRunner.callHistory).toHaveLength(1);
    expect(coordinatorRunner.callHistory[0]?.message).toBe("delegate a note");
    expect(flow.childRunner.callHistory).toHaveLength(1);
    expect(flow.childRunner.callHistory[0]?.message).toBe("add the child note");
  });

  it("T2 — MockRunner keeps branch-scoped child writes isolated from the root", async () => {
    const rootScratchpad = createScratchpad();
    rootScratchpad.set(delegatedBranchSlot, "from-parent");
    seedParentNote(rootScratchpad);
    const coordinatorRunner = mockCoordinatorRunner();
    const flow = createDelegateFlow();

    const result = await flow.coordinatorStep.run("delegate a note", {
      runner: coordinatorRunner,
      scratchpad: rootScratchpad,
    });

    expect(result.succeeded).toBe(true);
    expect(rootScratchpad.get(delegatedBranchSlot)).toBe("from-parent");
  });

  it("T3 — the delegation fork event names the shared backpack key", async () => {
    const eventBus = new AgentEventBus();
    const forkEvents: ScratchpadForkEvent[] = [];
    eventBus.subscribe("agent.scratchpad.fork", (event) => {
      forkEvents.push(event as ScratchpadForkEvent);
    });
    const rootScratchpad = new ObservedScratchpad(
      createStateEmitter(eventBus, { traceId: "trace-269", runId: "run-269" }),
    );
    seedParentNote(rootScratchpad);
    const coordinatorRunner = mockCoordinatorRunner();
    const flow = createDelegateFlow();

    const result = await flow.coordinatorStep.run("delegate a note", {
      runner: coordinatorRunner,
      scratchpad: rootScratchpad,
      eventBus,
    });

    expect(result.succeeded).toBe(true);
    expect(forkEvents.some((event) => event.sharedKeys.includes("backpack.notes"))).toBe(true);
  });

  it("T4 — AgentRunner shares the backpack through delegateTo on the live rail", async () => {
    let outerCalls = 0;
    const outerModel = new MockLanguageModelV3({
      doGenerate: async () => {
        outerCalls++;
        if (outerCalls === 1) {
          return {
            content: [
              {
                type: "tool-call" as const,
                toolCallId: "outer-notes-1",
                toolName: "notes",
                input: JSON.stringify({ task: "add the child note" }),
              },
            ],
            finishReason: { unified: "tool-calls" as const, raw: "tool-calls" },
            usage,
            warnings: [],
          };
        }
        return {
          content: [{ type: "text" as const, text: "coordinator done" }],
          finishReason: { unified: "stop" as const, raw: "stop" },
          usage,
          warnings: [],
        };
      },
    });
    const rootScratchpad = createScratchpad();
    seedParentNote(rootScratchpad);
    const liveRunner = new AgentRunner(outerModel, new AgentEventBus());
    const flow = createDelegateFlow();

    const result = await flow.coordinatorStep.run("delegate a note", {
      runner: liveRunner,
      scratchpad: rootScratchpad,
    });

    expect(result.succeeded).toBe(true);
    expect(result.output).toBe("coordinator done");
    expect(outerCalls).toBe(2);
    expect(flow.childSaw()).toEqual([{ id: "p1", text: "from-parent" }]);
    expect(readBackpack(rootScratchpad, notesPack, "assert").entries()).toContainEqual({
      id: "c1",
      text: "from-child",
    });
    expect(flow.childRunner.callHistory).toHaveLength(1);
    expect(flow.childRunner.callHistory[0]?.message).toBe("add the child note");
  });
});

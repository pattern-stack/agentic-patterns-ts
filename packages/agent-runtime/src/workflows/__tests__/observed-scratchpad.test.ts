/**
 * ObservedScratchpad (#226) — the event-publishing Scratchpad decorator.
 *
 * Pins the emission contract: write/read/fork/join events with byte-capped
 * previews and one monotonic per-run ordinal stream; `withOrigin` innate
 * tagging; and — load-bearing — that the decorator still IS a
 * `DefaultScratchpad` so FanOut joins keep merging (`slot.ts` join guard).
 */

import { describe, expect, it } from "vitest";
import { AgentEventBus } from "../../events/agent-event-bus.js";
import type {
  AgentEvent,
  ScratchpadJoinEvent,
  ScratchpadReadEvent,
  ScratchpadWriteEvent,
} from "../../events/types.js";
import { MockRunner } from "../../runner/mock-runner.js";
import { FanOut } from "../fan-out.js";
import { FunctionStep } from "../function-step.js";
import { ObservedScratchpad } from "../observed-scratchpad.js";
import { DefaultScratchpad, slot } from "../slot.js";
import {
  PREVIEW_MARKER,
  ROW_PREVIEW_BYTES,
  byteLength,
  createStateEmitter,
} from "../state-events.js";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function capture(): { pad: ObservedScratchpad; events: AgentEvent[] } {
  const bus = new AgentEventBus();
  const events: AgentEvent[] = [];
  bus.subscribeAll((e) => void events.push(e as AgentEvent));
  const pad = new ObservedScratchpad(
    createStateEmitter(bus, { traceId: "trace-1", runId: "run-1" }),
  );
  return { pad, events };
}

const ofType = <T extends AgentEvent>(events: AgentEvent[], type: T["type"]): T[] =>
  events.filter((e) => e.type === type) as T[];

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

describe("ObservedScratchpad — writes", () => {
  it("set publishes agent.scratchpad.write with op/hadValue/before/after previews", () => {
    const { pad, events } = capture();
    const s = slot<string | null>({ key: "notes.finding", scope: "run", init: () => null });

    pad.set(s, "first");
    pad.set(s, "second");

    const writes = ofType<ScratchpadWriteEvent>(events, "agent.scratchpad.write");
    expect(writes).toHaveLength(2);

    expect(writes[0]).toMatchObject({
      key: "notes.finding",
      op: "set",
      origin: "explicit",
      hadValue: false,
      after: "first", // string values preview verbatim (no JSON quoting)
      traceId: "trace-1",
      runId: "run-1",
    });
    expect(writes[0]!.before).toBeUndefined();

    expect(writes[1]).toMatchObject({
      op: "set",
      hadValue: true,
      before: "first",
      after: "second",
    });
  });

  it("update publishes a write with the fold's before/after", () => {
    const { pad, events } = capture();
    const counter = slot<number>({ key: "n", scope: "run", init: () => 0 });

    pad.update(counter, (n) => n + 1); // materializes via init — no prior observed value
    pad.update(counter, (n) => n + 1);

    const writes = ofType<ScratchpadWriteEvent>(events, "agent.scratchpad.write");
    expect(writes).toHaveLength(2);
    expect(writes[0]).toMatchObject({ op: "update", hadValue: false, after: "1" });
    expect(writes[0]!.before).toBeUndefined();
    expect(writes[1]).toMatchObject({ op: "update", hadValue: true, before: "1", after: "2" });
    // The store itself behaves exactly like the base class.
    expect(pad.get(counter)).toBe(2);
  });

  it("withOrigin tags the wrapped writes innate and restores explicit after", () => {
    const { pad, events } = capture();
    const s = slot<string | null>({ key: "agents.retrieve", scope: "run", init: () => null });

    pad.withOrigin("innate", () => pad.set(s, "stage output"));
    pad.set(s, "explicit follow-up");

    const writes = ofType<ScratchpadWriteEvent>(events, "agent.scratchpad.write");
    expect(writes.map((w) => w.origin)).toEqual(["innate", "explicit"]);
  });

  it("previews are byte-capped at construction with the explicit marker (512B/row)", () => {
    const { pad, events } = capture();
    const s = slot<string | null>({ key: "big", scope: "run", init: () => null });

    pad.set(s, "x".repeat(2000));

    const [write] = ofType<ScratchpadWriteEvent>(events, "agent.scratchpad.write");
    expect(write!.after.endsWith(PREVIEW_MARKER)).toBe(true);
    expect(byteLength(write!.after)).toBeLessThanOrEqual(ROW_PREVIEW_BYTES);
  });
});

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

describe("ObservedScratchpad — reads", () => {
  it("get and reader().get publish agent.scratchpad.read with a value preview", () => {
    const { pad, events } = capture();
    const s = slot<string | null>({ key: "view", scope: "run", init: () => null });
    pad.set(s, "windowed");

    pad.get(s);
    pad.reader().get(s);

    const reads = ofType<ScratchpadReadEvent>(events, "agent.scratchpad.read");
    expect(reads).toHaveLength(2);
    for (const read of reads) {
      expect(read).toMatchObject({ key: "view", preview: "windowed", origin: "explicit" });
    }
  });

  it("backpack.* slot-handle fetches do NOT publish scratchpad.read (accessor owns that domain)", () => {
    const { pad, events } = capture();
    const packSlot = slot<{ n: number }>({
      key: "backpack.evidence",
      scope: "run",
      init: () => ({ n: 0 }),
    });

    pad.get(packSlot);

    expect(ofType<ScratchpadReadEvent>(events, "agent.scratchpad.read")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Ordinals — ONE monotonic per-run stream
// ---------------------------------------------------------------------------

describe("ObservedScratchpad — ordinals", () => {
  it("mints a single strictly-increasing ordinal stream across mixed operations and forks", () => {
    const { pad, events } = capture();
    const s = slot<string | null>({ key: "a", scope: "run", init: () => null });

    pad.set(s, "1");
    pad.get(s);
    const child = pad.fork();
    child.set(s, "2"); // run-scoped: shared entry, child emits on the SAME emitter
    pad.join(child);

    const ordinals = events.map((e) => (e as { ordinal?: number }).ordinal);
    expect(ordinals.every((o) => typeof o === "number")).toBe(true);
    expect(ordinals).toEqual([...(ordinals as number[])].sort((a, b) => a - b));
    expect(new Set(ordinals).size).toBe(ordinals.length); // no duplicates
  });
});

// ---------------------------------------------------------------------------
// Fork / join
// ---------------------------------------------------------------------------

describe("ObservedScratchpad — fork/join", () => {
  it("fork publishes an innate scratchpad.fork carrying the shared run-scoped keys", () => {
    const { pad, events } = capture();
    const s = slot<string | null>({ key: "shared.key", scope: "run", init: () => null });
    pad.set(s, "v");

    const child = pad.fork();

    expect(child).toBeInstanceOf(ObservedScratchpad);
    expect(child).toBeInstanceOf(DefaultScratchpad); // the slot.ts join guard
    const forks = ofType(events, "agent.scratchpad.fork");
    expect(forks).toHaveLength(1);
    expect(forks[0]).toMatchObject({ origin: "innate", sharedKeys: ["shared.key"] });
  });

  it("join publishes mergedKeys AND discardedKeys (the silent-loss trap, made visible) — and still merges", () => {
    const { pad, events } = capture();
    const merged = slot<string[]>({
      key: "branch.merged",
      scope: "branch",
      init: () => [],
      merge: (parent, child) => [...parent, ...child],
    });
    const discarded = slot<string | null>({
      key: "branch.discarded",
      scope: "branch",
      init: () => null,
    });

    const child = pad.fork();
    child.update(merged, (cur) => [...cur, "from-branch"]);
    child.set(discarded, "lost at join");
    pad.join(child);

    const joins = ofType<ScratchpadJoinEvent>(events, "agent.scratchpad.join");
    expect(joins).toHaveLength(1);
    expect(joins[0]).toMatchObject({
      origin: "innate",
      mergedKeys: ["branch.merged"],
      discardedKeys: ["branch.discarded"],
    });
    // The merge genuinely happened (extends DefaultScratchpad — not a wrapper).
    expect(pad.get(merged)).toEqual(["from-branch"]);
    expect(pad.get(discarded)).toBeNull(); // discarded — parent kept its own init
  });

  it("FanOut over an observed pad still merges branch slots (instanceof guard end-to-end)", async () => {
    const { pad, events } = capture();
    const pool = slot<number[]>({
      key: "branch.pool",
      scope: "branch",
      init: () => [],
      merge: (parent, child) => [...parent, ...child],
    });

    const step = new FunctionStep<number, number>({
      name: "collect",
      fn: (i, scratchpad) => {
        scratchpad.update(pool, (cur) => [...cur, i]);
        return i;
      },
    });
    const fan = new FanOut<number[], number, number>({ over: (items) => items, step });
    const result = await fan.run([0, 1, 2], { runner: new MockRunner(), scratchpad: pad });

    expect(result.succeeded).toBe(true);
    // Deterministic INDEX-order fan-in, exactly as with a plain pad.
    expect(pad.get(pool)).toEqual([0, 1, 2]);
    expect(ofType(events, "agent.scratchpad.fork")).toHaveLength(3);
    expect(ofType(events, "agent.scratchpad.join")).toHaveLength(3);
  });
});

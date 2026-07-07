/**
 * `lib/runPicker.ts` — the RunPickerMenu's selection-pinning logic (port-map
 * §3.4: "MAX 2 inline newest-first run chips with selected-run pinning").
 */
import { describe, expect, it } from "vitest";
import type { RunSummary } from "../api/types";
import {
  MAX_RUN_CHIPS,
  pickOrDeselectRun,
  pinSelectedRun,
  sortRunsNewestFirst,
} from "../lib/runPicker";

function mkRun(runId: string, tsStart: string): RunSummary {
  return {
    runId,
    traceId: runId,
    tsStart,
    tsEnd: null,
    agentName: "retrieval-analyst",
    model: "sonnet",
    status: "ok",
    finishReason: "stop",
    toolCalls: 0,
    iterations: 1,
    inputTokens: 1,
    outputTokens: 1,
    elapsedMs: 1,
    answerLength: 1,
    hasPrompt: false,
  };
}

describe("MAX_RUN_CHIPS", () => {
  it("is 2 (port-map §3.4)", () => {
    expect(MAX_RUN_CHIPS).toBe(2);
  });
});

describe("sortRunsNewestFirst", () => {
  it("orders by tsStart descending, without mutating the input", () => {
    const runs = [
      mkRun("a", "2026-07-01T00:00:00Z"),
      mkRun("b", "2026-07-03T00:00:00Z"),
      mkRun("c", "2026-07-02T00:00:00Z"),
    ];
    const sorted = sortRunsNewestFirst(runs);
    expect(sorted.map((r) => r.runId)).toEqual(["b", "c", "a"]);
    expect(runs.map((r) => r.runId)).toEqual(["a", "b", "c"]); // original untouched
  });
});

describe("pinSelectedRun", () => {
  const runs = [
    mkRun("newest", "2026-07-05T00:00:00Z"),
    mkRun("second", "2026-07-04T00:00:00Z"),
    mkRun("third", "2026-07-03T00:00:00Z"),
    mkRun("oldest", "2026-07-02T00:00:00Z"),
  ];

  it("with no selection, returns the newest `max` runs untouched", () => {
    expect(pinSelectedRun(runs, null).map((r) => r.runId)).toEqual(["newest", "second"]);
  });

  it("when the selected run is already visible, the visible set is unchanged", () => {
    expect(pinSelectedRun(runs, "newest").map((r) => r.runId)).toEqual(["newest", "second"]);
    expect(pinSelectedRun(runs, "second").map((r) => r.runId)).toEqual(["newest", "second"]);
  });

  it("when the selected run has aged out of the top `max`, it is pinned in — bumping the oldest visible chip", () => {
    // "third" isn't in the top-2 (newest, second) — it gets pinned to the front,
    // and the top set's own oldest member ("second") is bumped to keep the count at max.
    expect(pinSelectedRun(runs, "third").map((r) => r.runId)).toEqual(["third", "newest"]);
    expect(pinSelectedRun(runs, "oldest").map((r) => r.runId)).toEqual(["oldest", "newest"]);
  });

  it("an unknown selected id (already expired/removed) is a no-op — falls back to the plain top set", () => {
    expect(pinSelectedRun(runs, "does-not-exist").map((r) => r.runId)).toEqual([
      "newest",
      "second",
    ]);
  });

  it("respects a custom max", () => {
    expect(pinSelectedRun(runs, null, 1).map((r) => r.runId)).toEqual(["newest"]);
    expect(pinSelectedRun(runs, "oldest", 1).map((r) => r.runId)).toEqual(["oldest"]);
    expect(pinSelectedRun(runs, null, 3).map((r) => r.runId)).toEqual([
      "newest",
      "second",
      "third",
    ]);
  });

  it("fewer runs than max: returns everything, selection or not", () => {
    const few = runs.slice(0, 1);
    expect(pinSelectedRun(few, null).map((r) => r.runId)).toEqual(["newest"]);
    expect(pinSelectedRun(few, "newest").map((r) => r.runId)).toEqual(["newest"]);
  });

  it("empty runs list returns empty regardless of selection", () => {
    expect(pinSelectedRun([], "anything")).toEqual([]);
  });
});

describe("pickOrDeselectRun", () => {
  it("selects a run that isn't currently active", () => {
    expect(pickOrDeselectRun("a", null)).toBe("a");
    expect(pickOrDeselectRun("a", "b")).toBe("a");
  });

  it("clicking the ALREADY-active run deselects it (null = return to demo)", () => {
    expect(pickOrDeselectRun("a", "a")).toBeNull();
  });
});

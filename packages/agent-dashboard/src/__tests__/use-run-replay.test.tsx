/**
 * Contract tests for the Live Run replay engine's LIVE drain (slice: replay
 * engine upgrade). The manual play/seek path is exercised via the UI; here we
 * pin the two live-specific guarantees:
 *   - the cursor drains toward the growing step frontier at `paceMs` cadence and
 *     re-arms as new steps append (live streaming), and
 *   - the honesty clamp holds — the cursor never advances past the arrived
 *     frontier (`cursor ≤ lastStep`), and `paceMs: 0` snaps to the frontier.
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Constellation } from "../graph/constellation-model";
import type { TraceStep } from "../graph/types";
import { useRunReplay } from "../graph/use-run-replay";

const GRAPH: Constellation = { nodes: [], edges: [] };
const mkSteps = (n: number): TraceStep[] =>
  Array.from({ length: n }, (_, i) => ({ seq: i + 1, iter: 1, kind: "model", ms: 0 }) as TraceStep);

describe("useRunReplay — live drain", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("drains the cursor toward the frontier at cadence, then re-arms as steps grow", () => {
    const { result, rerender } = renderHook(
      ({ steps }) => useRunReplay(steps, GRAPH, "run-1", { live: true, paceMs: 100 }),
      { initialProps: { steps: mkSteps(2) } },
    );

    expect(result.current.cursor).toBe(-1); // idle before the first beat

    act(() => void vi.advanceTimersByTime(280)); // LEAD_MS → first step
    expect(result.current.cursor).toBe(0);

    act(() => void vi.advanceTimersByTime(100)); // cadence → second (= frontier)
    expect(result.current.cursor).toBe(1);

    // honesty clamp: no more arrived steps → cursor parks, does not run ahead.
    act(() => void vi.advanceTimersByTime(1000));
    expect(result.current.cursor).toBe(1);

    // new steps stream in → the drain re-arms and continues.
    rerender({ steps: mkSteps(4) });
    act(() => void vi.advanceTimersByTime(100));
    expect(result.current.cursor).toBe(2);
    act(() => void vi.advanceTimersByTime(100));
    expect(result.current.cursor).toBe(3);
    act(() => void vi.advanceTimersByTime(1000));
    expect(result.current.cursor).toBe(3); // clamped at the frontier again
  });

  it("paceMs: 0 snaps straight to the arrived frontier (strict real-time)", () => {
    const { result } = renderHook(() =>
      useRunReplay(mkSteps(5), GRAPH, "run-2", { live: true, paceMs: 0 }),
    );
    // no timer advance needed — the drain sets cursor = lastStep synchronously.
    act(() => void vi.advanceTimersByTime(0));
    expect(result.current.cursor).toBe(4);
  });

  it("resets to idle when runKey changes", () => {
    const { result, rerender } = renderHook(
      ({ runKey }) => useRunReplay(mkSteps(3), GRAPH, runKey, { live: true, paceMs: 100 }),
      { initialProps: { runKey: "run-a" } },
    );
    act(() => void vi.advanceTimersByTime(280)); // LEAD → step 0
    act(() => void vi.advanceTimersByTime(100)); // → step 1
    act(() => void vi.advanceTimersByTime(100)); // → step 2 (frontier)
    expect(result.current.cursor).toBe(2);
    rerender({ runKey: "run-b" }); // new run → back to idle (before the next beat)
    expect(result.current.cursor).toBe(-1);
  });
});

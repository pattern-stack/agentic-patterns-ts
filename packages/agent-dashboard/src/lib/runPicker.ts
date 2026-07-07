/**
 * Run-picker selection logic (port-map §3.4) — pulled out of
 * `pages/RunSurfacePage.tsx` as pure, dependency-free helpers so they're
 * unit-testable without pulling in the whole page's module graph
 * (ConstellationGraph, chat-client, …). Mirrors swe-brain `LiveRunSurface.tsx`
 * lines 74-163's `visibleRuns` IIFE: keep the newest `MAX_RUN_CHIPS` runs
 * visible inline, but always keep the actively selected/replaying run visible
 * even if it has aged past the cap — so picking an older run from the
 * dropdown doesn't make its own chip vanish from the topbar.
 */
import type { RunSummary } from "../api/types";

/** How many run chips the topbar shows inline before the "N ▾" overflow menu takes over. */
export const MAX_RUN_CHIPS = 2;

/** Newest-first (defensive re-sort — the server already orders DESC by tsStart). */
export function sortRunsNewestFirst(runs: RunSummary[]): RunSummary[] {
  return [...runs].sort((a, b) => +new Date(b.tsStart) - +new Date(a.tsStart));
}

/**
 * The visible inline chip set: the newest `max` runs, with the actively
 * selected run pinned into view (prepended, bumping the oldest visible chip
 * out) when it isn't already among them.
 */
export function pinSelectedRun(
  runs: RunSummary[],
  selectedRunId: string | null,
  max: number = MAX_RUN_CHIPS,
): RunSummary[] {
  const top = runs.slice(0, max);
  if (selectedRunId && !top.some((r) => r.runId === selectedRunId)) {
    const sel = runs.find((r) => r.runId === selectedRunId);
    if (sel) return [sel, ...top.slice(0, Math.max(0, max - 1))];
  }
  return top;
}

/**
 * Clicking a run chip/row: if it's already the active replay, DESELECT it
 * (the caller returns to demo mode) — otherwise select it. Pulled out as
 * pure decision logic (port-map §3.4's "switch back to demo" acceptance,
 * which had no affordance at all before this — clicking the active chip
 * used to just re-fetch the same run) so it's unit-testable without
 * rendering `RunSurfacePage`. Returns the run id to replay, or `null` to
 * mean "return to demo".
 */
export function pickOrDeselectRun(runId: string, activeRunId: string | null): string | null {
  return runId === activeRunId ? null : runId;
}

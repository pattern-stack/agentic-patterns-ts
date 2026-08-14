/**
 * REST client for the read-only run-history endpoints (S5's `/admin/runs*`).
 *
 * Mirrors `lib/evalApi.ts`'s grammar: hand-mirrored row types (`api/types.ts`,
 * the dashboard has no `@pattern-stack/agentic-runtime` dependency), and explicit
 * 503 discrimination via `RunsFetch<T>` so "persistence not configured"
 * renders as a first-class UI state (the picker's honest-degradation note)
 * instead of collapsing into a flat error string. The by-id fetches also
 * discriminate 404 (`not-found`) — the `fetchEvalRunDetail` precedent — since
 * a run can disappear between the list fetch and a click (retention sweep,
 * server restart racing a stale picker).
 */

import type { PersistedEvent, RunRow, RunSummary } from "../api/types";

export type RunsFetch<T> = { kind: "ok"; data: T } | { kind: "unconfigured" };

export interface FetchRunsOptions {
  /** Max rows returned. Server clamps to [1, 500], default 50. */
  limit?: number;
  /** Filter to one agent (`?agent=`). */
  agent?: string;
  /** Filter to one run status (`?status=`). */
  status?: "running" | "ok" | "error";
  /** Only runs started at/after this ISO timestamp (`?since=`). */
  since?: string;
  /** Override default base URL (mostly for tests). */
  baseUrl?: string;
}

interface RunsResponse {
  runs: RunSummary[];
}

/** GET /admin/runs — newest first. `{ kind: "ok", data: [] }` (zero runs) is distinct from 503. */
export async function fetchRuns(opts: FetchRunsOptions = {}): Promise<RunsFetch<RunSummary[]>> {
  const params = new URLSearchParams();
  if (opts.limit) params.set("limit", String(opts.limit));
  if (opts.agent) params.set("agent", opts.agent);
  if (opts.status) params.set("status", opts.status);
  if (opts.since) params.set("since", opts.since);

  const base = opts.baseUrl ?? "";
  const url = `${base}/admin/runs${params.size ? `?${params}` : ""}`;

  const res = await fetch(url);
  if (res.status === 503) return { kind: "unconfigured" };
  if (!res.ok) throw new Error(`fetchRuns: HTTP ${res.status}`);

  const body = (await res.json()) as RunsResponse;
  return { kind: "ok", data: body.runs };
}

interface RunResponse {
  run: RunRow;
}

/** GET /admin/runs/:id — accepts a unique id prefix (server contract). */
export async function fetchRun(
  runId: string,
  opts: { baseUrl?: string } = {},
): Promise<RunsFetch<RunRow> | { kind: "not-found" }> {
  const base = opts.baseUrl ?? "";
  const res = await fetch(`${base}/admin/runs/${encodeURIComponent(runId)}`);
  if (res.status === 503) return { kind: "unconfigured" };
  if (res.status === 404) return { kind: "not-found" };
  if (!res.ok) throw new Error(`fetchRun: HTTP ${res.status}`);

  const body = (await res.json()) as RunResponse;
  return { kind: "ok", data: body.run };
}

export interface RunEventsResult {
  runId: string;
  events: PersistedEvent[];
}

/** GET /admin/runs/:id/events — ASC by id (insert order). */
export async function fetchRunEvents(
  runId: string,
  opts: { baseUrl?: string } = {},
): Promise<RunsFetch<RunEventsResult> | { kind: "not-found" }> {
  const base = opts.baseUrl ?? "";
  const res = await fetch(`${base}/admin/runs/${encodeURIComponent(runId)}/events`);
  if (res.status === 503) return { kind: "unconfigured" };
  if (res.status === 404) return { kind: "not-found" };
  if (!res.ok) throw new Error(`fetchRunEvents: HTTP ${res.status}`);

  return { kind: "ok", data: (await res.json()) as RunEventsResult };
}

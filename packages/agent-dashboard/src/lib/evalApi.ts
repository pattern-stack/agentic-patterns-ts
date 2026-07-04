/**
 * REST client for the read-only eval endpoints (#136's four GETs).
 *
 * Mirrors the `lib/eventApi.ts` precedent: hand-mirrored row types (the
 * dashboard has no `@agentic-patterns/runtime` dependency), and explicit 503
 * discrimination via `EvalFetch<T>` so "persistence not configured" renders
 * as a first-class UI state instead of collapsing into `useAdminData`'s flat
 * error string. Non-503 (and, for the detail fetch, non-404) failures throw
 * — pages render the standard error Card for those.
 */

import type { EvalCaseRow, EvalRunDetailResponse, EvalRunRow, EvalSplit } from "../api/types";

export type EvalFetch<T> = { kind: "ok"; data: T } | { kind: "unconfigured" };

interface EvalRunsResponse {
  runs: EvalRunRow[];
}

interface EvalCasesResponse {
  setId: string;
  cases: EvalCaseRow[];
}

export interface FetchEvalRunsOptions {
  /** Max rows returned. Server clamps to [1, 500], default 50. */
  limit?: number;
  /** Override default base URL (mostly for tests). */
  baseUrl?: string;
}

/** GET /eval/runs — newest first. `{ kind: "ok", data: [] }` (zero runs) is distinct from 503. */
export async function fetchEvalRuns(
  opts: FetchEvalRunsOptions = {},
): Promise<EvalFetch<EvalRunRow[]>> {
  const params = new URLSearchParams();
  if (opts.limit) params.set("limit", String(opts.limit));

  const base = opts.baseUrl ?? "";
  const url = `${base}/eval/runs${params.size ? `?${params}` : ""}`;

  const res = await fetch(url);
  if (res.status === 503) return { kind: "unconfigured" };
  if (!res.ok) throw new Error(`fetchEvalRuns: HTTP ${res.status}`);

  const body = (await res.json()) as EvalRunsResponse;
  return { kind: "ok", data: body.runs };
}

/** GET /eval/runs/:id — the joined per-case results + handler-computed summary. */
export async function fetchEvalRunDetail(
  id: string,
  opts: { baseUrl?: string } = {},
): Promise<EvalFetch<EvalRunDetailResponse> | { kind: "not-found" }> {
  const base = opts.baseUrl ?? "";
  const res = await fetch(`${base}/eval/runs/${id}`);
  if (res.status === 503) return { kind: "unconfigured" };
  if (res.status === 404) return { kind: "not-found" };
  if (!res.ok) throw new Error(`fetchEvalRunDetail: HTTP ${res.status}`);

  const body = (await res.json()) as EvalRunDetailResponse;
  return { kind: "ok", data: body };
}

/** GET /eval/sets/:id/cases — the case bank, for the client-side actual-vs-expected join. */
export async function fetchEvalCases(
  setId: string,
  opts: { baseUrl?: string } = {},
): Promise<EvalFetch<EvalCaseRow[]>> {
  const base = opts.baseUrl ?? "";
  const res = await fetch(`${base}/eval/sets/${setId}/cases`);
  if (res.status === 503) return { kind: "unconfigured" };
  if (!res.ok) throw new Error(`fetchEvalCases: HTTP ${res.status}`);

  const body = (await res.json()) as EvalCasesResponse;
  return { kind: "ok", data: body.cases };
}

export interface EvalRunFilters {
  set?: string;
  target?: string;
  variant?: string;
  split?: EvalSplit | "untagged";
}

/**
 * Pure; exported for direct unit tests. Each key narrows independently and
 * combined filters intersect. `split: "untagged"` matches only `split === null`.
 */
export function filterRuns(runs: EvalRunRow[], f: EvalRunFilters): EvalRunRow[] {
  return runs.filter((r) => {
    if (f.set && r.setId !== f.set) return false;
    if (f.target && r.targetId !== f.target) return false;
    if (f.variant && r.variant !== f.variant) return false;
    if (f.split) {
      if (f.split === "untagged") {
        if (r.split !== null) return false;
      } else if (r.split !== f.split) {
        return false;
      }
    }
    return true;
  });
}

/**
 * JSON.parse with raw-string fallback — `finalAnswer` is stored as whatever
 * raw string `finishRun` received, and the #135 CLI writes it JSON-serialized
 * (e.g. `"\"42\""`). Falls back to the raw string for non-JSON answers.
 */
export function safeParseAnswer(finalAnswer: string | null): unknown {
  if (finalAnswer === null) return null;
  try {
    return JSON.parse(finalAnswer);
  } catch {
    return finalAnswer;
  }
}

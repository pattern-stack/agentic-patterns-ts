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

import type {
  EvalCaseDetailResponse,
  EvalCaseRow,
  EvalRunDetailResponse,
  EvalRunRow,
  EvalSetSummary,
  EvalSplit,
  SplitAggregate,
} from "../api/types";

export type EvalFetch<T> = { kind: "ok"; data: T } | { kind: "unconfigured" };

interface EvalRunsResponse {
  runs: EvalRunRow[];
}

interface EvalSetsResponse {
  sets: EvalSetSummary[];
}

interface EvalCasesResponse {
  setId: string;
  cases: EvalCaseRow[];
}

interface SplitAggregatesResponse {
  aggregates: SplitAggregate[];
}

export interface FetchEvalRunsOptions {
  /** Max rows returned. Server clamps to [1, 500], default 50. */
  limit?: number;
  /** Filter to one set (`?set=` — server-side, store-indexed). */
  set?: string;
  /** Filter to one target agent (`?target=`). */
  target?: string;
  /** Override default base URL (mostly for tests). */
  baseUrl?: string;
}

/** GET /eval/runs — newest first. `{ kind: "ok", data: [] }` (zero runs) is distinct from 503. */
export async function fetchEvalRuns(
  opts: FetchEvalRunsOptions = {},
): Promise<EvalFetch<EvalRunRow[]>> {
  const params = new URLSearchParams();
  if (opts.limit) params.set("limit", String(opts.limit));
  if (opts.set) params.set("set", opts.set);
  if (opts.target) params.set("target", opts.target);

  const base = opts.baseUrl ?? "";
  const url = `${base}/eval/runs${params.size ? `?${params}` : ""}`;

  const res = await fetch(url);
  if (res.status === 503) return { kind: "unconfigured" };
  if (!res.ok) throw new Error(`fetchEvalRuns: HTTP ${res.status}`);

  const body = (await res.json()) as EvalRunsResponse;
  return { kind: "ok", data: body.runs };
}

/** GET /eval/sets — case-bank summaries (id + per-split counts), for the run launcher's set picker. */
export async function fetchEvalSets(
  opts: { baseUrl?: string } = {},
): Promise<EvalFetch<EvalSetSummary[]>> {
  const base = opts.baseUrl ?? "";
  const res = await fetch(`${base}/eval/sets`);
  if (res.status === 503) return { kind: "unconfigured" };
  if (!res.ok) throw new Error(`fetchEvalSets: HTTP ${res.status}`);

  const body = (await res.json()) as EvalSetsResponse;
  return { kind: "ok", data: body.sets };
}

/**
 * One set summary, derived from `GET /eval/sets` (there is no dedicated
 * single-set route — the list is the source of truth). `data: null` means the
 * set id was not found, distinct from `unconfigured`.
 */
export async function fetchEvalSet(
  id: string,
  opts: { baseUrl?: string } = {},
): Promise<EvalFetch<EvalSetSummary | null>> {
  const result = await fetchEvalSets(opts);
  if (result.kind === "unconfigured") return result;
  return { kind: "ok", data: result.data.find((s) => s.id === id) ?? null };
}

/** GET /eval/runs/:id — the joined per-case results + handler-computed summary. */
export async function fetchEvalRunDetail(
  id: string,
  opts: { baseUrl?: string } = {},
): Promise<EvalFetch<EvalRunDetailResponse> | { kind: "not-found" }> {
  const base = opts.baseUrl ?? "";
  const res = await fetch(`${base}/eval/runs/${encodeURIComponent(id)}`);
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
  const res = await fetch(`${base}/eval/sets/${encodeURIComponent(setId)}/cases`);
  if (res.status === 503) return { kind: "unconfigured" };
  if (!res.ok) throw new Error(`fetchEvalCases: HTTP ${res.status}`);

  const body = (await res.json()) as EvalCasesResponse;
  return { kind: "ok", data: body.cases };
}

/**
 * GET /eval/sets/:id/cases/:caseId — the case + its cross-run history.
 * Mirrors `fetchEvalRunDetail`'s 503/404 discrimination: `not-found` when the
 * set or case is unknown, `unconfigured` on 503, throw on other non-2xx.
 */
export async function fetchEvalCaseDetail(
  setId: string,
  caseId: string,
  opts: { baseUrl?: string } = {},
): Promise<EvalFetch<EvalCaseDetailResponse> | { kind: "not-found" }> {
  const base = opts.baseUrl ?? "";
  const res = await fetch(
    `${base}/eval/sets/${encodeURIComponent(setId)}/cases/${encodeURIComponent(caseId)}`,
  );
  if (res.status === 503) return { kind: "unconfigured" };
  if (res.status === 404) return { kind: "not-found" };
  if (!res.ok) throw new Error(`fetchEvalCaseDetail: HTTP ${res.status}`);

  const body = (await res.json()) as EvalCaseDetailResponse;
  return { kind: "ok", data: body };
}

export interface SplitAggregateFilters {
  set?: string;
  target?: string;
  variant?: string;
}

/** GET /eval/aggregates/splits — the store-wide per-split pass-rate rollup. */
export async function fetchSplitAggregates(
  filters: SplitAggregateFilters = {},
  opts: { baseUrl?: string } = {},
): Promise<EvalFetch<SplitAggregate[]>> {
  const params = new URLSearchParams();
  if (filters.set) params.set("set", filters.set);
  if (filters.target) params.set("target", filters.target);
  if (filters.variant) params.set("variant", filters.variant);

  const base = opts.baseUrl ?? "";
  const url = `${base}/eval/aggregates/splits${params.size ? `?${params}` : ""}`;

  const res = await fetch(url);
  if (res.status === 503) return { kind: "unconfigured" };
  if (!res.ok) throw new Error(`fetchSplitAggregates: HTTP ${res.status}`);

  const body = (await res.json()) as SplitAggregatesResponse;
  return { kind: "ok", data: body.aggregates };
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

// ---------------------------------------------------------------------------
// POST /eval/runs — run launcher (#139, E5c)
// ---------------------------------------------------------------------------

export interface LaunchEvalRunBody {
  setId: string;
  targetId: string;
  variant?: string;
  split?: EvalSplit;
  allowTest?: boolean;
  /** Named scorer id (server `SCORER_REGISTRY`). Absent → server default "exact-match". */
  scorer?: string;
}

// ---------------------------------------------------------------------------
// GET /eval/scorers — the named scorer registry, for the launcher's scorer picker
// ---------------------------------------------------------------------------

export interface ScorerOption {
  id: string;
  description: string;
}

interface ScorersResponse {
  scorers: ScorerOption[];
}

/**
 * The three built-in scorers, in server-registry order — the form's FALLBACK
 * when GET /eval/scorers fails (older server, transient error). Ids mirror the
 * server registry; the "exact-match" default is first.
 */
export const BUILTIN_SCORERS: readonly ScorerOption[] = [
  { id: "exact-match", description: "Expected-gated deep equality (the default)." },
  { id: "set-membership", description: "Deterministic cited-id precision/recall/F1." },
  { id: "none", description: "Execute + inspect only — always ungraded." },
];

/**
 * GET /eval/scorers — the named scorer registry (id + description) in display
 * order. The route is static (independent of persistence), so it answers even
 * when a run is not yet launchable. Throws on any non-2xx — the caller falls
 * back to `BUILTIN_SCORERS`.
 */
export async function fetchScorers(opts: { baseUrl?: string } = {}): Promise<ScorerOption[]> {
  const base = opts.baseUrl ?? "";
  const res = await fetch(`${base}/eval/scorers`);
  if (!res.ok) throw new Error(`fetchScorers: HTTP ${res.status}`);
  const body = (await res.json()) as ScorersResponse;
  return body.scorers;
}

export type LaunchEvalRunResult =
  | { kind: "ok"; runId: string; total: number }
  | { kind: "unconfigured" }
  | { kind: "refused" | "error"; message: string };

/**
 * POST /eval/runs. 202 -> `{kind:"ok", runId, total}`; 503 (either
 * "persistence not configured" or "eval execution not configured") ->
 * `{kind:"unconfigured"}`; 403 (held-out split refusal) -> `{kind:"refused"}`;
 * any other non-2xx (400 validation, 404 unknown set/target) -> `{kind:"error"}`
 * — the launcher renders `refused`/`error` inline (the runs-page error Card
 * grammar) and treats `unconfigured` like every other eval page's persistence hint.
 */
export async function launchEvalRun(
  body: LaunchEvalRunBody,
  opts: { baseUrl?: string } = {},
): Promise<LaunchEvalRunResult> {
  const base = opts.baseUrl ?? "";
  const res = await fetch(`${base}/eval/runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (res.status === 503) return { kind: "unconfigured" };
  if (res.status === 202) {
    const data = (await res.json()) as { runId: string; total: number };
    return { kind: "ok", runId: data.runId, total: data.total };
  }

  const errorBody = (await res.json().catch(() => ({}))) as { error?: string; hint?: string };
  const message = errorBody.hint ? `${errorBody.error} — ${errorBody.hint}` : errorBody.error;

  if (res.status === 403) {
    return { kind: "refused", message: message ?? "held-out split refused" };
  }
  return { kind: "error", message: message ?? `launchEvalRun: HTTP ${res.status}` };
}

// ---------------------------------------------------------------------------
// POST /eval/cases/from-session — capture-from-session (#140, E5d)
// ---------------------------------------------------------------------------

export interface CaptureFromSessionRequest {
  conversationId: string;
  setId: string;
  exchange?: number;
  expected?: string;
  split?: EvalSplit;
  tags?: string[];
  caseId?: string;
  createSet?: { name?: string; description?: string };
}

export interface CaptureFromSessionResponse {
  setId: string;
  caseId: string;
  created: boolean;
  input: string;
  expected: string;
  tags: string[];
  split: EvalSplit;
}

/**
 * POST /eval/cases/from-session. 503 -> `{kind:"unconfigured"}`; 201/200 ->
 * `{kind:"ok", data}` (`data.created` distinguishes a new row from an
 * updated existing one — the re-capture idempotence signal). Any other
 * non-2xx (400 validation, 404 unknown conversation/set/exchange) throws
 * with the server's `error` (+ `hint` when present) — the capture panel
 * catches it and renders the message inline (the `fetchEvalCases`
 * throw-on-non-503 idiom).
 */
export async function captureFromSession(
  body: CaptureFromSessionRequest,
  opts: { baseUrl?: string } = {},
): Promise<EvalFetch<CaptureFromSessionResponse>> {
  const base = opts.baseUrl ?? "";
  const res = await fetch(`${base}/eval/cases/from-session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (res.status === 503) return { kind: "unconfigured" };
  if (res.status === 201 || res.status === 200) {
    const data = (await res.json()) as CaptureFromSessionResponse;
    return { kind: "ok", data };
  }

  const errorBody = (await res.json().catch(() => ({}))) as { error?: string; hint?: string };
  const message = errorBody.hint
    ? `${errorBody.error} — ${errorBody.hint}`
    : (errorBody.error ?? `captureFromSession: HTTP ${res.status}`);
  throw new Error(message);
}

// ---------------------------------------------------------------------------
// Set / case write clients (WI-5) — POST/PATCH/PUT/DELETE the WI-2 routes.
// 503 -> `unconfigured`; 2xx -> `ok`; any other non-2xx throws the server's
// `error` (+ `hint`), the `captureFromSession` idiom — the modal renders it.
// ---------------------------------------------------------------------------

export interface SetWriteBody {
  id: string;
  name?: string;
  description?: string;
}

export interface CaseWriteBody {
  input: unknown;
  expected?: unknown;
  tags?: string[];
  split?: EvalSplit;
}

/** Read `error`/`hint` off a non-2xx body and throw — shared by the write clients. */
async function throwServerError(res: Response, fallback: string): Promise<never> {
  const errorBody = (await res.json().catch(() => ({}))) as { error?: string; hint?: string };
  const message = errorBody.hint
    ? `${errorBody.error} — ${errorBody.hint}`
    : (errorBody.error ?? fallback);
  throw new Error(message);
}

/** POST /eval/sets — create or upsert a set. 201/200 both resolve `ok`. */
export async function createEvalSet(
  body: SetWriteBody,
  opts: { baseUrl?: string } = {},
): Promise<EvalFetch<EvalSetSummary>> {
  const base = opts.baseUrl ?? "";
  const res = await fetch(`${base}/eval/sets`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.status === 503) return { kind: "unconfigured" };
  if (res.ok) return { kind: "ok", data: ((await res.json()) as { set: EvalSetSummary }).set };
  return throwServerError(res, `createEvalSet: HTTP ${res.status}`);
}

/** PATCH /eval/sets/:id — edit set metadata (name/description). */
export async function updateEvalSet(
  id: string,
  body: { name?: string; description?: string },
  opts: { baseUrl?: string } = {},
): Promise<EvalFetch<EvalSetSummary>> {
  const base = opts.baseUrl ?? "";
  const res = await fetch(`${base}/eval/sets/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.status === 503) return { kind: "unconfigured" };
  if (res.ok) return { kind: "ok", data: ((await res.json()) as { set: EvalSetSummary }).set };
  return throwServerError(res, `updateEvalSet: HTTP ${res.status}`);
}

/** PUT /eval/sets/:id/cases/:caseId — create or edit a case. */
export async function upsertEvalCase(
  setId: string,
  caseId: string,
  body: CaseWriteBody,
  opts: { baseUrl?: string } = {},
): Promise<EvalFetch<EvalCaseRow>> {
  const base = opts.baseUrl ?? "";
  const res = await fetch(
    `${base}/eval/sets/${encodeURIComponent(setId)}/cases/${encodeURIComponent(caseId)}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  if (res.status === 503) return { kind: "unconfigured" };
  if (res.ok) return { kind: "ok", data: ((await res.json()) as { case: EvalCaseRow }).case };
  return throwServerError(res, `upsertEvalCase: HTTP ${res.status}`);
}

/** DELETE /eval/sets/:id/cases/:caseId — remove a case. */
export async function deleteEvalCase(
  setId: string,
  caseId: string,
  opts: { baseUrl?: string } = {},
): Promise<EvalFetch<{ deleted: true; caseId: string }>> {
  const base = opts.baseUrl ?? "";
  const res = await fetch(
    `${base}/eval/sets/${encodeURIComponent(setId)}/cases/${encodeURIComponent(caseId)}`,
    {
      method: "DELETE",
    },
  );
  if (res.status === 503) return { kind: "unconfigured" };
  if (res.ok) return { kind: "ok", data: (await res.json()) as { deleted: true; caseId: string } };
  return throwServerError(res, `deleteEvalCase: HTTP ${res.status}`);
}

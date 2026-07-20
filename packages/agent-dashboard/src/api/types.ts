/**
 * Dashboard API types — aligned with @agentic-patterns/runtime admin schemas.
 *
 * These mirror the Zod-inferred types from the runtime's admin/schemas.ts,
 * representing the JSON shapes returned by the server's admin routes.
 * Dates are serialized as ISO strings over the wire.
 */

export interface ToolStats {
  toolName: string;
  callCount: number;
  errorCount: number;
  totalDurationMs: number;
  avgDurationMs: number;
  lastUsed?: string;
}

export interface AgentStats {
  agentName: string;
  status: "idle" | "running" | "error" | "completed";
  totalIterations: number;
  totalToolCalls: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalErrors: number;
  startedAt?: string;
  lastEventAt?: string;
  toolStats: ToolStats[];
}

export interface DashboardStats {
  agents: AgentStats[];
  activeAgentCount: number;
  totalTokensUsed: number;
  totalToolCalls: number;
  totalErrors: number;
  activeConversationCount: number;
  uptimeMs: number;
}

export interface ToolAnalytics {
  toolName: string;
  totalCalls: number;
  totalErrors: number;
  totalDurationMs: number;
  avgDurationMs: number;
  agentBreakdown: Array<{ agentName: string; callCount: number }>;
}

export interface TokenUsageGroup {
  key: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  conversationCount: number;
}

/**
 * Row returned by `GET /admin/conversations` — aligns with runtime
 * `ConversationSummary` emitted by DrizzleAdminService.
 */
export interface ConversationSummary {
  conversationId: string;
  agentName: string;
  messageCount: number;
  tokenCount: number;
  startedAt: string;
  lastMessageAt?: string;
  status: "active" | "completed" | "error";
}

/**
 * Record returned by Team 2's `GET /conversations/:id` — the raw Drizzle
 * row. Fields beyond the runtime `ConversationSummary` (agentConfigId,
 * completedAt, error, model, createdAt, updatedAt) are surfaced here so
 * the detail page can show duration + error banner.
 */
export interface ConversationDetail {
  id: string;
  agentConfigId: string | null;
  status: string;
  agentName: string;
  model: string;
  tokenCount: number;
  messageCount: number;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Row from `GET /conversations/:id/messages`. Parts are loaded separately
 * from `GET /messages/:id/parts` — the messages list does not embed them.
 */
export interface ConversationMessage {
  id: string;
  conversationId: string;
  kind: "request" | "response";
  runId: string | null;
  inputTokens: number;
  outputTokens: number;
  content: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationMessagePart {
  id: string;
  messageId: string;
  type: string;
  content: string | null;
  metadata: Record<string, unknown> | null;
  position: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * Eval types — hand-mirrored from `@agentic-patterns/runtime`'s `EvalStore`
 * row types (the dashboard has no runtime dependency, `ConversationSummary`
 * precedent above). Wire shapes served by #136's four `/eval/*` GETs.
 */

export type EvalSplit = "train" | "dev" | "test";

/** Row returned by `GET /eval/sets` — a case bank + per-split counts. */
export interface EvalSetSummary {
  id: string;
  name: string | null;
  description: string | null;
  createdTs: string;
  caseCount: number;
  splitCounts: Record<string, number>;
  /**
   * Set-level family metadata (schema v5) — question-bundle/bank identity per
   * `docs/eval-family-contract.md`. Absent/null = generic set or older server.
   */
  meta?: Record<string, unknown> | null;
}

/** Row returned by `GET /eval/sets/:id/cases`. */
export interface EvalCaseRow {
  setId: string;
  caseId: string;
  input: unknown;
  expected: unknown;
  tags: string[] | null;
  split: EvalSplit | null;
}

/**
 * Per-run pass rollup carried inline on `GET /eval/runs` list rows (additive,
 * #eval-list-passrate). `passRate` is over gated cases only; `null` when the
 * run has no gated case (fully ungated). Absent on `EvalRunRow` when the run
 * has no results (or from an older server) — callers fall back to "—".
 */
export interface EvalRunListSummary {
  cases: number;
  passed: number;
  failed: number;
  ungated: number;
  passRate: number | null;
}

/** Row returned by `GET /eval/runs` and the `run` field of `GET /eval/runs/:id`. */
export interface EvalRunRow {
  id: string;
  tsStart: string;
  tsEnd: string | null;
  setId: string | null;
  targetId: string | null;
  variant: string | null;
  split: EvalSplit | null;
  model: string | null;
  gitSha: string | null;
  /** Scorer id the run graded with (schema v4); null/absent = unrecorded (older rows/servers). */
  scorer?: string | null;
  status: "running" | "ok" | "error";
  /** Present on `GET /eval/runs` list rows when the run has results; absent otherwise. */
  summary?: EvalRunListSummary;
  /**
   * Run-level family metadata (schema v5) — see `docs/eval-family-contract.md`.
   * Absent/null = generic run or older server.
   */
  meta?: Record<string, unknown> | null;
}

export interface EvalScoreLike {
  name: string;
  value: number | null;
  passed?: boolean;
  detail?: Record<string, unknown>;
  error?: string;
}

/**
 * `eval_result` LEFT JOIN `runs` — annotation fields (scores/pass) alongside
 * run-owned fields (tokens, trace_id, status, final_answer). Never carries
 * `input`/`expected` — those live in the case bank (`EvalCaseRow`), joined
 * client-side by `caseId`.
 */
export interface JoinedEvalResultRow {
  evalRunId: string;
  caseId: string;
  runId: string | null;
  scores: EvalScoreLike[] | null;
  pass: boolean | null;
  traceId: string | null;
  runStatus: "running" | "ok" | "error" | null;
  finalAnswer: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  finishReason: string | null;
  elapsedMs: number | null;
  runError: string | null;
}

/** Handler-computed rollup — the `summary` field of `GET /eval/runs/:id`. */
export interface EvalRunSummary {
  cases: number;
  passed: number;
  failed: number;
  ungated: number;
  errored: number;
  passRate: number | null;
  inputTokens: number;
  outputTokens: number;
}

/** Full body of `GET /eval/runs/:id`. */
export interface EvalRunDetailResponse {
  run: EvalRunRow;
  results: JoinedEvalResultRow[];
  summary: EvalRunSummary;
}

/**
 * Row returned by `GET /eval/aggregates/splits` — mirror of `EvalStore`'s
 * `SplitAggregate` (`eval-store.ts:168-174`). Per-split rollup across *all*
 * matching `eval_result` rows in the store, not just the runs-table window.
 */
export interface SplitAggregate {
  split: EvalSplit | null; // null = untagged bucket
  results: number;
  passed: number;
  failed: number;
  passRate: number | null; // null when no result carried a pass verdict
}

/**
 * One run that evaluated a given case — mirror of `EvalStore`'s
 * `EvalCaseHistoryRow`. `split` is the RUN's label, not the case's bank split.
 * Served by `GET /eval/sets/:id/cases/:caseId`.
 */
export interface EvalCaseHistoryRow {
  evalRunId: string;
  tsStart: string;
  targetId: string | null;
  variant: string | null;
  split: EvalSplit | null;
  model: string | null;
  runStatus: "running" | "ok" | "error";
  pass: boolean | null;
  scores: EvalScoreLike[] | null;
  finalAnswer: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  elapsedMs: number | null;
}

/** Full body of `GET /eval/sets/:id/cases/:caseId` — the case + its cross-run history. */
export interface EvalCaseDetailResponse {
  case: EvalCaseRow;
  history: EvalCaseHistoryRow[];
}

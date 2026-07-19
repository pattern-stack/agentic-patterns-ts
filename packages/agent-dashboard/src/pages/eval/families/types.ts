/**
 * Eval-family identity + typed `meta` accessors.
 *
 * The bench-viewer's family organization (Renderer / SDC / Curation runs;
 * Answer-bank / Question-bundle sets) is carried on `eval_run.meta` /
 * `eval_set.meta` — an open JSON column (schema v5) that reaches the dashboard
 * as `Record<string, unknown>`. This module is the single place that reads it:
 * `familyOf` / `setFamilyOf` classify a run/set, and `readRunMeta` /
 * `readSetMeta` parse the blob defensively into typed shapes. Absent or
 * unknown family ⇒ `null` ⇒ the generic (pre-upgrade) UI renders unchanged.
 *
 * Contract source of truth: `packages/agent-dashboard/docs/eval-family-contract.md`.
 * Nothing here throws — a malformed blob degrades to `null`/omitted fields.
 */

export type RunFamily = "renderer" | "sdc" | "curation";
export type SetFamily = "answer-bank" | "question-bundle";

const RUN_FAMILIES: readonly RunFamily[] = ["renderer", "sdc", "curation"];
const SET_FAMILIES: readonly SetFamily[] = ["answer-bank", "question-bundle"];

/** Anything carrying an optional untyped `meta` blob (run or set row). */
export interface HasMeta {
  meta?: unknown;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}
function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
function strArr(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((x): x is string => typeof x === "string");
  return out.length ? out : undefined;
}

// ---- Run meta --------------------------------------------------------------

/** The two-lens judge value, whose meaning differs per family. */
export interface JudgeLens {
  kind: "mean" | "ratio";
  value: number;
  num?: number;
  den?: number;
}

/** Home-table rollup — one fetch feeds the family home tables. */
export interface RunSummary {
  detPassRate?: number;
  judgeLens?: JudgeLens;
  costUsd?: number;
  judgeCostUsd?: number;
  latencyP50?: number;
  flagsRate?: number;
  fallbackRate?: number;
  retriesRate?: number;
  survivalBest?: number;
  tokensAtBest?: number;
  compressionPct?: number;
  paretoCount?: number;
  configCount?: number;
  crashedCount?: number;
}

export interface RunMeta {
  family: RunFamily;
  benchmark?: string;
  judgeModel?: string;
  gitBranch?: string;
  summary?: RunSummary;
  /** Family-specific run-level artifacts (verbatim from the source bench). */
  renderer?: Record<string, unknown>;
  sdc?: Record<string, unknown>;
  curation?: Record<string, unknown>;
}

export interface SetMeta {
  family: SetFamily;
  source?: "cache" | "authoring";
  benchmark?: string;
  version?: string;
  dataset?: string;
  createdAt?: string;
  families?: string[];
}

function parseJudgeLens(v: unknown): JudgeLens | undefined {
  if (!isRecord(v)) return undefined;
  const value = num(v.value);
  const kind = v.kind === "mean" || v.kind === "ratio" ? v.kind : undefined;
  if (value === undefined || kind === undefined) return undefined;
  return { kind, value, num: num(v.num), den: num(v.den) };
}

function parseSummary(v: unknown): RunSummary | undefined {
  if (!isRecord(v)) return undefined;
  const s: RunSummary = {
    detPassRate: num(v.detPassRate),
    judgeLens: parseJudgeLens(v.judgeLens),
    costUsd: num(v.costUsd),
    judgeCostUsd: num(v.judgeCostUsd),
    latencyP50: num(v.latencyP50),
    flagsRate: num(v.flagsRate),
    fallbackRate: num(v.fallbackRate),
    retriesRate: num(v.retriesRate),
    survivalBest: num(v.survivalBest),
    tokensAtBest: num(v.tokensAtBest),
    compressionPct: num(v.compressionPct),
    paretoCount: num(v.paretoCount),
    configCount: num(v.configCount),
    crashedCount: num(v.crashedCount),
  };
  return s;
}

/** Parse a run's `meta` blob into a typed `RunMeta`, or `null` if not a family run. */
export function readRunMeta(run: HasMeta | null | undefined): RunMeta | null {
  const meta = run?.meta;
  if (!isRecord(meta)) return null;
  const family = meta.family;
  if (typeof family !== "string" || !RUN_FAMILIES.includes(family as RunFamily)) return null;
  return {
    family: family as RunFamily,
    benchmark: str(meta.benchmark),
    judgeModel: str(meta.judgeModel),
    gitBranch: str(meta.gitBranch),
    summary: parseSummary(meta.summary),
    renderer: isRecord(meta.renderer) ? meta.renderer : undefined,
    sdc: isRecord(meta.sdc) ? meta.sdc : undefined,
    curation: isRecord(meta.curation) ? meta.curation : undefined,
  };
}

/** Parse a set's `meta` blob into a typed `SetMeta`, or `null` if not a family set. */
export function readSetMeta(set: HasMeta | null | undefined): SetMeta | null {
  const meta = set?.meta;
  if (!isRecord(meta)) return null;
  const family = meta.family;
  if (typeof family !== "string" || !SET_FAMILIES.includes(family as SetFamily)) return null;
  const source = meta.source === "cache" || meta.source === "authoring" ? meta.source : undefined;
  return {
    family: family as SetFamily,
    source,
    benchmark: str(meta.benchmark),
    version: str(meta.version),
    dataset: str(meta.dataset),
    createdAt: str(meta.createdAt),
    families: strArr(meta.families),
  };
}

/** The run's family, or `null` for a generic (non-family) run. */
export function familyOf(run: HasMeta | null | undefined): RunFamily | null {
  return readRunMeta(run)?.family ?? null;
}

/** The set's family, or `null` for a generic (non-family) set. */
export function setFamilyOf(set: HasMeta | null | undefined): SetFamily | null {
  return readSetMeta(set)?.family ?? null;
}

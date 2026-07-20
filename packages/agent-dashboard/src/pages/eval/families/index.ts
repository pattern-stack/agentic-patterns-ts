/**
 * Family component registry — the `renderers/` registry idiom lifted one level
 * up: `meta.family` (via `familyOf`/`setFamilyOf`) is the discriminant, and a
 * resolved entry supplies the components that REPLACE the generic page body.
 *
 * THE ONE UI LAW: a family screen replaces the generic body entirely — it
 * never decorates or wraps it. `null` (absent/unknown family) means the
 * generic UI renders exactly as before.
 *
 * Dispatch sites:
 * - `EvalRunsPage` → `HomeTable` (one stacked section per run family)
 * - `EvalRunDetailPage` → `RunDetail` (replaces stat row + panels + table)
 * - `EvalSetDetailPage` → `SetView` (slice 9)
 * - `EvalCaseDetailPage` → `CaseView` (slice 9)
 *
 * Implementers replace the placeholder components wholesale; the prop
 * contracts exported here are the seam — code against them, don't widen them.
 * Contract source of truth: `packages/agent-dashboard/docs/eval-family-contract.md`.
 */

import type { ReactNode } from "react";
import type {
  EvalCaseHistoryRow,
  EvalCaseRow,
  EvalRunRow,
  EvalRunSummary,
  EvalSetSummary,
  JoinedEvalResultRow,
} from "../../../api/types";
import { BankCaseView } from "./bank/BankCaseView";
import { BankSetView } from "./bank/BankSetView";
import { BundleCaseView } from "./bundle/BundleCaseView";
import { BundleSetView } from "./bundle/BundleSetView";
import { CurationHomeTable } from "./curation/CurationHomeTable";
import { CurationRunDetail } from "./curation/CurationRunDetail";
import { RendererHomeTable } from "./renderer/RendererHomeTable";
import { RendererRunDetail } from "./renderer/RendererRunDetail";
import { SdcHomeTable } from "./sdc/SdcHomeTable";
import { SdcRunDetail } from "./sdc/SdcRunDetail";
import type { RunFamily, RunMeta, SetFamily, SetMeta } from "./types";

// ---- Component prop contracts (the seam implementers code against) ---------

/** Props for a family's home-page section table (`EvalRunsPage`). */
export interface FamilyHomeTableProps {
  /** This family's runs only (already partitioned by `familyOf`), fetch order preserved. */
  runs: readonly EvalRunRow[];
}

/**
 * Props for a family's run-detail body (`EvalRunDetailPage`). The shell
 * (header, badges, load/error states, SSE plumbing) stays with the page; this
 * component replaces everything below it (stat row, RunPanels, results table).
 */
export interface FamilyRunDetailProps {
  run: EvalRunRow;
  /** Joined result rows (stream-merged when live), what the generic table renders. */
  results: readonly JoinedEvalResultRow[];
  /** Handler-computed rollup from `GET /eval/runs/:id`. */
  summary: EvalRunSummary;
  /**
   * Case-bank join keyed by `caseId`. EMPTY when the bank is missing or the
   * fetch degraded — and for renderer/curation runs composite ids
   * (`fid#variantKey`, `configId#fixtureId`) never match bank case ids, so
   * always tolerate a miss.
   */
  casesById: ReadonlyMap<string, EvalCaseRow>;
  /** Parsed run meta — non-null by construction at the dispatch site. */
  meta: RunMeta;
}

/** Props for a set family's detail body (`EvalSetDetailPage`, slice 9). */
export interface FamilySetViewProps {
  set: EvalSetSummary;
  /** The set's cases (empty on a degraded fetch). */
  cases: readonly EvalCaseRow[];
  /** Runs against this set (client-filtered window; empty on a degraded fetch). */
  runs: readonly EvalRunRow[];
  /** Parsed set meta — non-null by construction at the dispatch site. */
  meta: SetMeta;
}

/** Props for a set family's case-detail body (`EvalCaseDetailPage`, slice 9). */
export interface FamilyCaseViewProps {
  caseRow: EvalCaseRow;
  /** Cross-run history, newest first (SDC-only for composite-id families — contract "Known limits"). */
  history: readonly EvalCaseHistoryRow[];
  /** Parsed set meta when the page has it; the case GET does not carry it today. */
  meta?: SetMeta | null;
}

/**
 * Family components are plain `(props) => ReactNode` functions (React 19
 * component-typed) — render them as JSX elements (`<C.RunDetail … />`) so
 * implementations get a real component boundary and may use hooks.
 */
export type FamilyHomeTable = (props: FamilyHomeTableProps) => ReactNode;
export type FamilyRunDetail = (props: FamilyRunDetailProps) => ReactNode;
export type FamilySetView = (props: FamilySetViewProps) => ReactNode;
export type FamilyCaseView = (props: FamilyCaseViewProps) => ReactNode;

export interface RunFamilyComponents {
  HomeTable: FamilyHomeTable;
  RunDetail: FamilyRunDetail;
}

export interface SetFamilyComponents {
  SetView: FamilySetView;
  CaseView: FamilyCaseView;
}

// ---- Registry --------------------------------------------------------------

const RUN_REGISTRY: Record<RunFamily, RunFamilyComponents> = {
  renderer: { HomeTable: RendererHomeTable, RunDetail: RendererRunDetail },
  sdc: { HomeTable: SdcHomeTable, RunDetail: SdcRunDetail },
  curation: { HomeTable: CurationHomeTable, RunDetail: CurationRunDetail },
};

const SET_REGISTRY: Record<SetFamily, SetFamilyComponents> = {
  "answer-bank": { SetView: BankSetView, CaseView: BankCaseView },
  "question-bundle": { SetView: BundleSetView, CaseView: BundleCaseView },
};

/** Canonical home-page section order (Renderer, SDC, Curation). */
export const RUN_FAMILY_ORDER: readonly RunFamily[] = ["renderer", "sdc", "curation"];

/**
 * The components for a run family, or `null` when the family is absent —
 * `null` means the generic UI renders unchanged. Never throws.
 */
export function resolveRunFamilyComponents(
  family: RunFamily | null | undefined,
): RunFamilyComponents | null {
  return family ? RUN_REGISTRY[family] : null;
}

/**
 * The components for a set family, or `null` when the family is absent —
 * `null` means the generic UI renders unchanged. Never throws.
 */
export function resolveSetFamilyComponents(
  family: SetFamily | null | undefined,
): SetFamilyComponents | null {
  return family ? SET_REGISTRY[family] : null;
}

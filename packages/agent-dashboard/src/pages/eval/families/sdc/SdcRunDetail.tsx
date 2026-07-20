/**
 * SDC-family run-detail body (plan §4.2b) — REPLACES the generic stat row +
 * RunPanels + results table entirely (the one UI law; the page shell keeps the
 * header/badges/SSE plumbing).
 *
 * Top to bottom:
 * - meta badges (gitBranch / benchmark / judgeModel) + stat tiles (fixtures,
 *   det k/n, judge verdict k/n from `meta.summary.judgeLens`, cost, latency p50)
 * - the run-level score map: DECLARED `meta.sdc.scores` when present (the
 *   bench's canonical scores.json, rendered verbatim), else the client-mean
 *   fallback `sdcAxisMeans(results)` — the source is chip-labeled
 * - distributions (hybrid + answer_correctness) and a cost-vs-latency scatter
 * - the crashed-fixtures strip from `meta.sdc.failures` (fixtures absent from
 *   `results` — surfaced here, never faked as table rows)
 * - the fixture table (status / hybrid / axis columns / judge k/n / deals /
 *   cost / latency) with status + failing-only + text filters; a row expands
 *   into the existing registry path (`CaseDetail` → score-map + judge-verdicts
 *   renderers) under an "↗ bundle" banner linking the fixture's bundle case.
 *   `?fixture=<caseId>` deep-links an auto-expanded row.
 */

import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import type { EvalScoreLike, JoinedEvalResultRow } from "../../../../api/types";
import { Badge } from "../../../../components/atoms/Badge";
import { Card } from "../../../../components/atoms/Card";
import { DataTable } from "../../../../components/organisms/DataTable";
import { p50, sdcAxisMeans } from "../../../../lib/evalAggregates";
import { CaseDetail } from "../../CaseDetail";
import { Histogram } from "../../charts/Histogram";
import { ScatterPlot } from "../../charts/ScatterPlot";
import { BarCell } from "../../components/BarCell";
import { ScoreMapView } from "../../renderers/ScoreMapView";
import { scoreColorVar } from "../../renderers/shared";
import type { FamilyRunDetailProps } from "../index";

// ---- defensive parsing helpers ---------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}
function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** First score detail carrying the given `kind`, or null. */
function detailOfKind(
  scores: EvalScoreLike[] | null,
  kind: string,
): Record<string, unknown> | null {
  if (!scores) return null;
  for (const s of scores) {
    if (isRecord(s.detail) && s.detail.kind === kind) return s.detail;
  }
  return null;
}

interface CrashedFixture {
  fixtureId: string;
  error: string;
}

/** `meta.sdc.failures` — crashed fixtures, absent from `results` by contract. */
function parseFailures(sdc: Record<string, unknown> | undefined): CrashedFixture[] {
  const raw = sdc?.failures;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((f) =>
    isRecord(f) && typeof f.fixtureId === "string"
      ? [{ fixtureId: f.fixtureId, error: typeof f.error === "string" ? f.error : "" }]
      : [],
  );
}

// ---- per-fixture projection off the score-map / judge-verdicts details ------

interface FixtureRow {
  row: JoinedEvalResultRow;
  hybrid: number | null;
  correctness: number | null;
  retrieval: number | null;
  citation: number | null;
  judgeNum: number | null;
  judgeDen: number | null;
  deals: string[];
  costUsd: number | null;
  latencyMs: number | null;
  missingContext: boolean;
}

function projectFixture(row: JoinedEvalResultRow): FixtureRow {
  const d = detailOfKind(row.scores, "score-map");
  const axes = d ? (isRecord(d.scores) ? d.scores : isRecord(d.axes) ? d.axes : null) : null;
  const verdictsRaw = detailOfKind(row.scores, "judge-verdicts")?.verdicts;
  const verdicts = Array.isArray(verdictsRaw) ? verdictsRaw.filter(isRecord) : null;
  const dealsRaw = d?.dealIds;
  return {
    row,
    hybrid: num(d?.hybrid) ?? (axes ? num(axes.hybrid) : null),
    correctness: axes ? num(axes.answer_correctness) : null,
    retrieval: axes ? num(axes.evidence_seen_recall) : null,
    citation: axes ? num(axes.citation_claim_support) : null,
    judgeNum: verdicts ? verdicts.filter((v) => v.passed === true).length : null,
    judgeDen: verdicts ? verdicts.length : null,
    deals: Array.isArray(dealsRaw)
      ? dealsRaw.filter((x): x is string => typeof x === "string")
      : [],
    costUsd: num(d?.costUsd),
    latencyMs: num(d?.latencyMs),
    missingContext: d?.missingContext === true,
  };
}

// ---- small display atoms ----------------------------------------------------

const monoStyle = { fontFamily: "var(--font-mono)", fontSize: 12 };
const mutedStyle = { color: "var(--fg-muted)", fontSize: 13 };

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div>
      <div style={{ fontSize: 12, color: "var(--fg-muted)", marginBottom: 2 }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 600 }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: "var(--fg-subtle)" }}>{sub}</div>}
    </div>
  );
}

function AxisValue({ value }: { value: number | null }) {
  return (
    <span style={{ ...monoStyle, color: scoreColorVar(value) }}>
      {value === null ? "—" : value.toFixed(2)}
    </span>
  );
}

function pct(v: number | null | undefined): string | undefined {
  return typeof v === "number" ? `${Math.round(v * 100)}%` : undefined;
}

const sectionHeadingStyle = {
  fontSize: 12,
  fontWeight: 600,
  textTransform: "uppercase" as const,
  letterSpacing: "0.05em",
  color: "var(--fg-subtle)",
};

// ---- the component ----------------------------------------------------------

type StatusFilter = "all" | "pass" | "fail";

export function SdcRunDetail({ run, results, summary, casesById, meta }: FamilyRunDetailProps) {
  const [searchParams, setSearchParams] = useSearchParams();
  // `?fixture=<caseId>` deep-links an auto-expanded row.
  const [expandedKey, setExpandedKey] = useState<string | undefined>(
    () => searchParams.get("fixture") ?? undefined,
  );

  // Keep the URL shareable on manual expand/collapse — the renderer sibling's
  // `?render=` idiom (RendererRunDetail.toggleExpand).
  const toggleExpand = (key: string) => {
    const next = expandedKey === key ? undefined : key;
    setExpandedKey(next);
    const q = new URLSearchParams(searchParams);
    if (next !== undefined) q.set("fixture", next);
    else q.delete("fixture");
    setSearchParams(q, { replace: true });
  };
  const [status, setStatus] = useState<StatusFilter>("all");
  const [failingOnly, setFailingOnly] = useState(false);
  const [text, setText] = useState("");

  const fixtures = useMemo(() => results.map(projectFixture), [results]);
  const failures = useMemo(() => parseFailures(meta.sdc), [meta.sdc]);

  // Declared-wins-else-compute (eval-family-contract.md): the bench's canonical
  // scores.json rides `meta.sdc.scores` verbatim; the client mean is fallback.
  const declaredScores = useMemo(() => {
    const raw = meta.sdc?.scores;
    return isRecord(raw) && Object.keys(raw).length > 0 ? raw : null;
  }, [meta.sdc]);
  const computedScores = useMemo(() => sdcAxisMeans(results), [results]);
  const axisMap: Record<string, unknown> = declaredScores ?? computedScores;
  const axisCount = Object.keys(axisMap).length;

  const filtered = useMemo(() => {
    const t = text.trim().toLowerCase();
    return fixtures.filter((f) => {
      if (failingOnly && f.row.pass !== false) return false;
      if (status === "pass" && f.row.pass !== true) return false;
      if (status === "fail" && f.row.pass !== false) return false;
      if (
        t &&
        !f.row.caseId.toLowerCase().includes(t) &&
        !f.deals.some((d) => d.toLowerCase().includes(t))
      )
        return false;
      return true;
    });
  }, [fixtures, status, failingOnly, text]);

  const runSummary = meta.summary;
  const judge = runSummary?.judgeLens;
  const costUsd =
    runSummary?.costUsd ??
    fixtures.reduce<number | null>(
      (acc, f) => (f.costUsd === null ? acc : (acc ?? 0) + f.costUsd),
      null,
    );
  const latencyP50 = runSummary?.latencyP50 ?? p50(fixtures.map((f) => f.latencyMs));
  const crashedCount = failures.length > 0 ? failures.length : (runSummary?.crashedCount ?? 0);

  const scatterPoints = fixtures.flatMap((f) =>
    f.latencyMs !== null && f.costUsd !== null
      ? [{ x: f.latencyMs, y: f.costUsd, label: f.row.caseId, emphasis: f.row.pass === false }]
      : [],
  );
  const hybridValues = fixtures.map((f) => f.hybrid).filter((v): v is number => v !== null);
  const correctnessValues = fixtures
    .map((f) => f.correctness)
    .filter((v): v is number => v !== null);
  const hasCharts =
    hybridValues.length > 0 || correctnessValues.length > 0 || scatterPoints.length > 0;

  return (
    <div data-testid="sdc-run-detail" style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <Card>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" }}>
          {meta.benchmark && <Badge tone="accent">benchmark · {meta.benchmark}</Badge>}
          {meta.gitBranch && <Badge tone="muted">branch · {meta.gitBranch}</Badge>}
          {meta.judgeModel && <Badge tone="muted">judge · {meta.judgeModel}</Badge>}
        </div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(110px, 1fr))",
            gap: 16,
            marginTop: 14,
          }}
        >
          <Tile
            label="Fixtures"
            value={String(results.length)}
            sub={crashedCount > 0 ? `+${crashedCount} crashed` : undefined}
          />
          <Tile
            label="Det pass"
            value={`${summary.passed}/${summary.cases}`}
            sub={pct(runSummary?.detPassRate ?? summary.passRate)}
          />
          <Tile
            label="Judge verdicts"
            value={
              judge
                ? judge.kind === "ratio" && judge.num !== undefined && judge.den !== undefined
                  ? `${judge.num}/${judge.den}`
                  : judge.value.toFixed(2)
                : "—"
            }
            sub={judge ? pct(judge.value) : undefined}
          />
          <Tile
            label="Cost"
            value={costUsd === null ? "—" : `$${costUsd.toFixed(2)}`}
            sub={
              runSummary?.judgeCostUsd !== undefined
                ? `+$${runSummary.judgeCostUsd.toFixed(2)} judge`
                : undefined
            }
          />
          <Tile
            label="Latency p50"
            value={latencyP50 === null ? "—" : `${Math.round(latencyP50).toLocaleString()} ms`}
          />
        </div>
      </Card>

      <Card data-testid="sdc-score-map">
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
          <div style={sectionHeadingStyle}>Score map</div>
          <Badge
            tone={declaredScores ? "accent" : "muted"}
            title={
              declaredScores
                ? "Canonical axis scores declared by the bench (meta.sdc.scores)"
                : "Client-computed per-axis means over this run's cases (no declared scores)"
            }
          >
            {declaredScores ? "declared" : "computed"}
          </Badge>
        </div>
        {axisCount > 0 ? (
          <ScoreMapView axes={axisMap} />
        ) : (
          <div style={mutedStyle}>no axis scores recorded</div>
        )}
      </Card>

      {hasCharts && (
        <Card>
          <div style={{ ...sectionHeadingStyle, marginBottom: 8 }}>Distributions</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 24, alignItems: "flex-end" }}>
            <Histogram
              values={hybridValues}
              bins={10}
              width={320}
              height={140}
              label="hybrid distribution"
            />
            <Histogram
              values={correctnessValues}
              bins={10}
              width={320}
              height={140}
              label="answer_correctness distribution"
            />
            <ScatterPlot
              points={scatterPoints}
              xLabel="latency ms"
              yLabel="cost $"
              width={360}
              height={200}
              formatY={(v) => `$${v.toFixed(3)}`}
            />
          </div>
        </Card>
      )}

      {failures.length > 0 && (
        <Card data-testid="sdc-crashed-strip" style={{ borderColor: "var(--red)" }}>
          <div style={{ ...sectionHeadingStyle, color: "var(--red)", marginBottom: 8 }}>
            Crashed fixtures ({failures.length}) — not in results
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {failures.map((f) => (
              <div key={f.fixtureId} style={{ display: "flex", gap: 10, alignItems: "baseline" }}>
                <span style={{ ...monoStyle, flexShrink: 0 }}>{f.fixtureId}</span>
                <span style={{ color: "var(--red)", fontSize: 12 }}>
                  {f.error || "(no error recorded)"}
                </span>
              </div>
            ))}
          </div>
        </Card>
      )}

      <Card padded={false}>
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 12,
            alignItems: "center",
            padding: "12px 14px",
            borderBottom: "1px solid var(--border)",
          }}
        >
          <input
            type="text"
            placeholder="Filter fixtures / deals…"
            value={text}
            onChange={(e) => setText(e.target.value)}
            style={{
              background: "var(--bg-inset)",
              border: "1px solid var(--border)",
              borderRadius: 6,
              color: "var(--fg-default)",
              fontSize: 13,
              padding: "6px 10px",
              width: 220,
            }}
          />
          <select
            aria-label="Status filter"
            value={status}
            onChange={(e) => setStatus(e.target.value as StatusFilter)}
            style={{
              background: "var(--bg-inset)",
              border: "1px solid var(--border)",
              borderRadius: 6,
              color: "var(--fg-default)",
              fontSize: 13,
              padding: "6px 8px",
            }}
          >
            <option value="all">all statuses</option>
            <option value="pass">pass</option>
            <option value="fail">fail</option>
          </select>
          <label
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              fontSize: 13,
              cursor: "pointer",
            }}
          >
            <input
              type="checkbox"
              checked={failingOnly}
              onChange={(e) => setFailingOnly(e.target.checked)}
            />
            failing only
          </label>
          <span style={{ ...mutedStyle, marginLeft: "auto" }}>
            {filtered.length}/{fixtures.length} fixtures
          </span>
        </div>
        <DataTable<FixtureRow>
          columns={[
            {
              key: "fixture",
              header: "Fixture",
              render: (f) => <span style={monoStyle}>{f.row.caseId}</span>,
            },
            {
              key: "status",
              header: "Status",
              render: (f) => (
                <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                  {f.row.pass === null ? (
                    <Badge tone="neutral">ungated</Badge>
                  ) : (
                    <Badge tone={f.row.pass ? "green" : "red"}>
                      {f.row.pass ? "pass" : "fail"}
                    </Badge>
                  )}
                  {f.missingContext && <Badge tone="yellow">missing ctx</Badge>}
                </span>
              ),
            },
            {
              key: "hybrid",
              header: "Hybrid",
              render: (f) => <BarCell value={f.hybrid} />,
            },
            {
              key: "correctness",
              header: "Correct",
              align: "right",
              render: (f) => <AxisValue value={f.correctness} />,
            },
            {
              key: "retrieval",
              header: "Retrieval",
              align: "right",
              render: (f) => <AxisValue value={f.retrieval} />,
            },
            {
              key: "citation",
              header: "Citation",
              align: "right",
              render: (f) => <AxisValue value={f.citation} />,
            },
            {
              key: "judge",
              header: "Judge",
              align: "right",
              render: (f) =>
                f.judgeNum !== null && f.judgeDen !== null ? (
                  <span
                    style={{
                      ...monoStyle,
                      color: scoreColorVar(f.judgeDen > 0 ? f.judgeNum / f.judgeDen : null),
                    }}
                  >
                    {f.judgeNum}/{f.judgeDen}
                  </span>
                ) : (
                  <span style={{ color: "var(--fg-subtle)" }}>—</span>
                ),
            },
            {
              key: "deals",
              header: "Deals",
              render: (f) => (
                <span style={{ ...monoStyle, color: "var(--fg-muted)" }}>
                  {f.deals.length > 0 ? f.deals.join(", ") : "—"}
                </span>
              ),
            },
            {
              key: "cost",
              header: "$",
              align: "right",
              render: (f) => (
                <span style={monoStyle}>
                  {f.costUsd === null ? "—" : `$${f.costUsd.toFixed(3)}`}
                </span>
              ),
            },
            {
              key: "latency",
              header: "ms",
              align: "right",
              render: (f) => (
                <span style={monoStyle}>
                  {f.latencyMs === null ? "—" : f.latencyMs.toLocaleString()}
                </span>
              ),
            },
          ]}
          data={filtered}
          rowKey={(f) => f.row.caseId}
          expandedKey={expandedKey}
          onToggleExpand={toggleExpand}
          renderExpanded={(f) => (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {run.setId && (
                <div data-testid="sdc-bundle-banner">
                  <Link
                    to={`/eval/sets/${encodeURIComponent(run.setId)}/cases/${encodeURIComponent(f.row.caseId)}`}
                    style={{ fontSize: 13, color: "var(--accent)", textDecoration: "none" }}
                    title="View this fixture's bundle case"
                  >
                    ↗ bundle · {f.row.caseId}
                  </Link>
                </div>
              )}
              <CaseDetail result={f.row} caseRow={casesById.get(f.row.caseId)} />
            </div>
          )}
        />
      </Card>
    </div>
  );
}

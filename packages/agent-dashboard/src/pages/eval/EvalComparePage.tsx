/**
 * /eval/compare/:aId/:bId — A/B compare, client-side (E5b, #138).
 *
 * Two parallel `fetchEvalRunDetail` calls (both already served by #136) —
 * strictly richer per case than the store's `compareEvalRuns` HTTP payload
 * would be (spec finding 3), so no server change backs this view. Alignment
 * + the six-bucket delta summary is the pure `lib/evalCompare.ts` merge.
 *
 * Family branch (slice 10): when BOTH runs share a family, renderer/sdc pairs
 * replace the generic comparison body with the `lib/evalFamilyCompare.ts`
 * delta table (per-variantKey / per-fixture). Curation pairs and mixed-family
 * pairs show a warning banner above the unchanged generic body; generic
 * (no-family) pairs render exactly as before.
 *
 * Deep-linkable and refresh-safe — the URL is the source of truth for A/B
 * order. The `Swap` button just navigates to the swapped URL.
 */

import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import type {
  EvalCaseRow,
  EvalRunDetailResponse,
  EvalRunRow,
  JoinedEvalResultRow,
} from "../../api/types";
import { Markdown } from "../../chat/atoms";
import { Badge, type BadgeTone } from "../../components/atoms/Badge";
import { Button } from "../../components/atoms/Button";
import { Card } from "../../components/atoms/Card";
import { Spinner } from "../../components/atoms/Spinner";
import { AlertIcon } from "../../components/atoms/icons";
import { DataTable } from "../../components/organisms/DataTable";
import { fetchEvalCases, fetchEvalRunDetail, safeParseAnswer } from "../../lib/evalApi";
import {
  type ComparisonCaseRow,
  type DeltaKind,
  alignResults,
  summarizeComparison,
} from "../../lib/evalCompare";
import {
  type MetricDelta,
  type RendererCompareRow,
  type SdcCompareRow,
  rendererCompare,
  sdcCompare,
} from "../../lib/evalFamilyCompare";
import { TraceSection } from "./CaseDetail";
import { DeltaCell } from "./components/DeltaCell";
import { familyOf } from "./families/types";

const preStyle = {
  margin: 0,
  padding: 10,
  background: "var(--bg-inset)",
  borderRadius: 6,
  fontSize: 12,
  fontFamily: "var(--font-mono)",
  overflowX: "auto" as const,
  whiteSpace: "pre-wrap" as const,
  wordBreak: "break-word" as const,
};

const mutedStyle = { color: "var(--fg-muted)", fontSize: 13 };

// Inset panel for rendered markdown — `preStyle` chrome without monospace/pre-wrap.
const mdPanelStyle = {
  margin: 0,
  padding: "2px 12px",
  background: "var(--bg-inset)",
  borderRadius: 6,
  fontSize: 13,
  overflowX: "auto" as const,
  wordBreak: "break-word" as const,
};

const sectionHeadingStyle = {
  fontSize: 12,
  fontWeight: 600,
  textTransform: "uppercase" as const,
  letterSpacing: "0.05em",
  color: "var(--fg-subtle)",
  marginBottom: 8,
};

function pretty(value: unknown): string {
  if (value === undefined) return "—";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

function shortSha(sha: string | null): string {
  return sha ? sha.slice(0, 7) : "—";
}

function statusTone(status: EvalRunRow["status"]): BadgeTone {
  switch (status) {
    case "ok":
      return "green";
    case "error":
      return "red";
    case "running":
      return "emerald";
    default:
      return "neutral";
  }
}

function scoresSummary(scores: JoinedEvalResultRow["scores"] | undefined): string {
  if (!scores || scores.length === 0) return "—";
  const passedCount = scores.filter((s) => s.passed === true).length;
  const first = scores[0];
  const firstStr = first ? `${first.name}: ${first.value ?? "—"}` : "";
  return `${passedCount}/${scores.length} · ${firstStr}`;
}

function resultBadge(r: JoinedEvalResultRow | null) {
  if (!r) return <Badge tone="muted">not run</Badge>;
  if (r.pass === true) return <Badge tone="green">pass</Badge>;
  if (r.pass === false) return <Badge tone="red">fail</Badge>;
  return <Badge tone="muted">ungated</Badge>;
}

function deltaBadge(kind: DeltaKind) {
  switch (kind) {
    case "regression":
      return <Badge tone="red">regression</Badge>;
    case "improvement":
      return <Badge tone="green">improvement</Badge>;
    case "same-pass":
    case "same-fail":
      return <Badge tone="muted">same</Badge>;
    case "ungated":
      return <Badge tone="muted">ungated</Badge>;
    case "a-only":
    case "b-only":
      return <Badge tone="muted">not run</Badge>;
  }
}

type CompareState =
  | { kind: "loading" }
  | { kind: "unconfigured" }
  | { kind: "not-found"; missingIds: string[] }
  | { kind: "error"; message: string }
  | { kind: "ok"; a: EvalRunDetailResponse; b: EvalRunDetailResponse };

export function EvalComparePage() {
  const { aId, bId } = useParams<{ aId: string; bId: string }>();
  const navigate = useNavigate();
  const [state, setState] = useState<CompareState>({ kind: "loading" });
  const [casesById, setCasesById] = useState<Map<string, EvalCaseRow>>(new Map());
  const [expandedKey, setExpandedKey] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (!aId || !bId) return;
    let cancelled = false;
    (async () => {
      setState({ kind: "loading" });
      setCasesById(new Map());
      setExpandedKey(undefined);
      try {
        const [aRes, bRes] = await Promise.all([fetchEvalRunDetail(aId), fetchEvalRunDetail(bId)]);
        if (cancelled) return;

        if (aRes.kind === "unconfigured" || bRes.kind === "unconfigured") {
          setState({ kind: "unconfigured" });
          return;
        }

        if (aRes.kind === "not-found" || bRes.kind === "not-found") {
          const missingIds: string[] = [];
          if (aRes.kind === "not-found") missingIds.push(aId);
          if (bRes.kind === "not-found") missingIds.push(bId);
          setState({ kind: "not-found", missingIds });
          return;
        }

        const aData = aRes.data;
        const bData = bRes.data;

        if (aData.run.setId && aData.run.setId === bData.run.setId) {
          try {
            const caseFetch = await fetchEvalCases(aData.run.setId);
            if (!cancelled && caseFetch.kind === "ok") {
              setCasesById(new Map(caseFetch.data.map((c) => [c.caseId, c])));
            }
            // unconfigured -> leave cases empty; expanded rows fall back per-case.
          } catch {
            // Case-bank fetch errors also degrade to the per-case fallback,
            // not a page error — the compare view is still useful without it.
          }
        }

        if (!cancelled) {
          setState({ kind: "ok", a: aData, b: bData });
        }
      } catch (e) {
        if (!cancelled) {
          setState({ kind: "error", message: e instanceof Error ? e.message : String(e) });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [aId, bId]);

  const backLink = (
    <Link to="/eval" style={{ color: "var(--fg-muted)", fontSize: 13, textDecoration: "none" }}>
      ← Eval runs
    </Link>
  );

  if (state.kind === "loading") {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 10,
          padding: "48px 0",
          color: "var(--fg-muted)",
        }}
      >
        <Spinner />
        <span>Loading compare...</span>
      </div>
    );
  }

  if (state.kind === "unconfigured") {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {backLink}
        <Card style={{ textAlign: "center", padding: 40, color: "var(--fg-muted)" }}>
          <div style={{ fontWeight: 600, color: "var(--fg-default)", marginBottom: 6 }}>
            Eval persistence is not configured
          </div>
          <div style={{ fontSize: 14 }}>
            Start <code>ap playground</code> with <code>AP_PERSISTENCE != 0</code> to enable eval
            queries.
          </div>
        </Card>
      </div>
    );
  }

  if (state.kind === "not-found") {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {backLink}
        <Card style={{ textAlign: "center", padding: 40, color: "var(--fg-muted)" }}>
          <div style={{ fontWeight: 600, color: "var(--fg-default)", marginBottom: 6 }}>
            Eval run not found
          </div>
          <div style={{ fontSize: 14 }}>
            No eval run with id {state.missingIds.map((id) => `"${id}"`).join(" and ")}.
          </div>
        </Card>
      </div>
    );
  }

  if (state.kind === "error") {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {backLink}
        <Card
          style={{ borderColor: "var(--red)", display: "flex", alignItems: "flex-start", gap: 12 }}
        >
          <span style={{ color: "var(--red)", display: "inline-flex", flexShrink: 0 }}>
            <AlertIcon size={18} />
          </span>
          <div>
            <div style={{ fontWeight: 600, color: "var(--red)", marginBottom: 4 }}>
              Failed to load compare
            </div>
            <div style={{ color: "var(--fg-muted)", fontSize: 14 }}>{state.message}</div>
          </div>
        </Card>
      </div>
    );
  }

  const { a, b } = state;
  const differentSets = a.run.setId !== b.run.setId;
  const aFamily = familyOf(a.run);
  const bFamily = familyOf(b.run);
  const sharedFamily = aFamily !== null && aFamily === bFamily ? aFamily : null;

  const header = (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        {backLink}
        <h1 style={{ fontSize: 20, fontWeight: 600, margin: 0 }}>Compare</h1>
      </div>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => aId && bId && navigate(`/eval/compare/${bId}/${aId}`)}
      >
        Swap
      </Button>
    </div>
  );

  const setsBanner = differentSets ? (
    <WarningBanner text="Runs are from different sets — case alignment may be sparse." />
  ) : null;

  const provenance = (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
      <ProvenanceCard label="A · baseline" run={a.run} />
      <ProvenanceCard label="B · candidate" run={b.run} />
    </div>
  );

  // Family branch: renderer/sdc pairs replace the generic comparison body.
  if (sharedFamily === "renderer" || sharedFamily === "sdc") {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
        {header}
        {setsBanner}
        {provenance}
        {sharedFamily === "renderer" ? (
          <RendererCompareBody aResults={a.results} bResults={b.results} />
        ) : (
          <SdcCompareBody aResults={a.results} bResults={b.results} />
        )}
      </div>
    );
  }

  // Curation pairs and mixed-family pairs warn, then fall through to generic.
  const familyNotice =
    sharedFamily === "curation"
      ? "Family compare is not available for curation runs — showing the generic compare."
      : aFamily !== bFamily
        ? "Runs are different families — showing the generic compare."
        : null;

  const aligned = alignResults(a.results, b.results);
  const summary = summarizeComparison(aligned);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {header}

      {familyNotice && <WarningBanner text={familyNotice} />}

      {setsBanner}

      {provenance}

      <Card>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(110px, 1fr))",
            gap: 16,
          }}
        >
          <Stat label="Both passed" value={summary.bothPassed} color="var(--green)" />
          <Stat
            label="Both failed"
            value={summary.bothFailed}
            color={summary.bothFailed > 0 ? "var(--red)" : undefined}
          />
          <Stat
            label="Regressions"
            value={summary.onlyAPassed}
            color={summary.onlyAPassed > 0 ? "var(--red)" : undefined}
          />
          <Stat
            label="Improvements"
            value={summary.onlyBPassed}
            color={summary.onlyBPassed > 0 ? "var(--green)" : undefined}
          />
          <Stat label="Only in A" value={summary.aOnly} />
          <Stat label="Only in B" value={summary.bOnly} />
        </div>
      </Card>

      <Card padded={false}>
        <DataTable<ComparisonCaseRow>
          columns={[
            {
              key: "caseId",
              header: "Case",
              render: (row) => (
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>{row.caseId}</span>
              ),
            },
            { key: "a", header: "A", render: (row) => resultBadge(row.a) },
            { key: "b", header: "B", render: (row) => resultBadge(row.b) },
            { key: "delta", header: "Δ", render: (row) => deltaBadge(row.delta) },
            {
              key: "scoresA",
              header: "Scores A",
              render: (row) => scoresSummary(row.a?.scores ?? undefined),
            },
            {
              key: "scoresB",
              header: "Scores B",
              render: (row) => scoresSummary(row.b?.scores ?? undefined),
            },
          ]}
          data={aligned}
          rowKey={(row) => row.caseId}
          expandedKey={expandedKey}
          onToggleExpand={(key) => setExpandedKey((prev) => (prev === key ? undefined : key))}
          renderExpanded={(row) => (
            <CompareCaseExpanded row={row} caseRow={casesById.get(row.caseId)} />
          )}
        />
      </Card>
    </div>
  );
}

function ProvenanceCard({ label, run }: { label: string; run: EvalRunRow }) {
  return (
    <Card>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 10,
        }}
      >
        <div style={{ fontWeight: 600 }}>{label}</div>
        <Badge tone={statusTone(run.status)}>{run.status}</Badge>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" }}>
        <Badge tone="muted">variant · {run.variant ?? "—"}</Badge>
        <Badge tone="muted">target · {run.targetId ?? "—"}</Badge>
        <Badge tone="muted">split · {run.split ?? "untagged"}</Badge>
        <Badge tone="muted">model · {run.model ?? "—"}</Badge>
        <Badge tone="muted" title={run.gitSha ?? undefined}>
          sha · {shortSha(run.gitSha)}
        </Badge>
        <Badge tone="muted">started · {new Date(run.tsStart).toLocaleString()}</Badge>
      </div>
    </Card>
  );
}

function Stat({
  label,
  value,
  color,
}: {
  label: string;
  value: string | number;
  color?: string;
}) {
  return (
    <div>
      <div style={{ fontSize: 12, color: "var(--fg-muted)", marginBottom: 2 }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 600, color: color ?? "var(--fg-default)" }}>
        {value}
      </div>
    </div>
  );
}

function WarningBanner({ text }: { text: string }) {
  return (
    <Card
      style={{
        borderColor: "var(--yellow)",
        display: "flex",
        alignItems: "flex-start",
        gap: 12,
      }}
    >
      <span style={{ color: "var(--yellow)", display: "inline-flex", flexShrink: 0 }}>
        <AlertIcon size={18} />
      </span>
      <div style={{ fontSize: 13, color: "var(--fg-muted)" }}>{text}</div>
    </Card>
  );
}

// ---- Family compare bodies (slice 10) --------------------------------------

const fmtPct = (v: number) => `${Math.round(v * 100)}%`;
const fmtPts = (v: number) => `${v > 0 ? "+" : ""}${(v * 100).toFixed(1)} pts`;
const fmtUsd = (v: number) => `$${v.toFixed(4)}`;
const fmtUsdDelta = (v: number) => `${v >= 0 ? "+" : "-"}$${Math.abs(v).toFixed(4)}`;
const fmt2 = (v: number) => v.toFixed(2);
const fmtSigned2 = (v: number) => `${v > 0 ? "+" : ""}${v.toFixed(2)}`;

/** "A → B" for one metric, muted mono; "—" per absent side. */
function ABPair({ m, fmt }: { m: MetricDelta; fmt: (v: number) => string }) {
  const f = (v: number | null) => (v === null ? "—" : fmt(v));
  return (
    <span style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--fg-muted)" }}>
      {f(m.a)} → {f(m.b)}
    </span>
  );
}

/** An uncolored delta — for metrics without a better direction (len-ratio). */
function NeutralDelta({ value, fmt }: { value: number | null; fmt: (v: number) => string }) {
  return (
    <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-muted)" }}>
      {value === null || !Number.isFinite(value) ? "—" : fmt(value)}
    </span>
  );
}

function RendererCompareBody({
  aResults,
  bResults,
}: {
  aResults: JoinedEvalResultRow[];
  bResults: JoinedEvalResultRow[];
}) {
  const rows = rendererCompare(aResults, bResults);
  return (
    <Card padded={false}>
      <DataTable<RendererCompareRow>
        columns={[
          {
            key: "variantKey",
            header: "Variant",
            render: (r) => (
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>{r.variantKey}</span>
            ),
          },
          {
            key: "n",
            header: "n (A/B)",
            render: (r) => (
              <span style={mutedStyle}>
                {r.a?.n ?? "—"} / {r.b?.n ?? "—"}
              </span>
            ),
          },
          {
            key: "detPass",
            header: "Det pass",
            render: (r) => <ABPair m={r.detPass} fmt={fmtPct} />,
          },
          {
            key: "dDetPass",
            header: "Δ det-pass",
            render: (r) => <DeltaCell value={r.detPass.delta} formatValue={fmtPts} />,
          },
          {
            key: "readability",
            header: "Readability",
            render: (r) => <ABPair m={r.readability} fmt={fmt2} />,
          },
          {
            key: "dReadability",
            header: "Δ readability",
            render: (r) => <DeltaCell value={r.readability.delta} />,
          },
          {
            key: "lenRatio",
            header: "Len ratio",
            render: (r) => <ABPair m={r.lenRatio} fmt={fmt2} />,
          },
          {
            key: "dLenRatio",
            header: "Δ len-ratio",
            render: (r) => <NeutralDelta value={r.lenRatio.delta} fmt={fmtSigned2} />,
          },
          {
            key: "usdPerRender",
            header: "$ / render",
            render: (r) => <ABPair m={r.usdPerRender} fmt={fmtUsd} />,
          },
          {
            key: "dUsdPerRender",
            header: "Δ $ / render",
            render: (r) => (
              <DeltaCell
                value={r.usdPerRender.delta}
                formatValue={fmtUsdDelta}
                higherIsBetter={false}
              />
            ),
          },
        ]}
        data={rows}
        rowKey={(r) => r.variantKey}
      />
    </Card>
  );
}

function SdcCompareBody({
  aResults,
  bResults,
}: {
  aResults: JoinedEvalResultRow[];
  bResults: JoinedEvalResultRow[];
}) {
  const rows = sdcCompare(aResults, bResults);
  return (
    <Card padded={false}>
      <DataTable<SdcCompareRow>
        columns={[
          {
            key: "caseId",
            header: "Fixture",
            render: (r) => (
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>{r.caseId}</span>
            ),
          },
          { key: "hybrid", header: "Hybrid", render: (r) => <ABPair m={r.hybrid} fmt={fmt2} /> },
          {
            key: "dHybrid",
            header: "Δ hybrid",
            render: (r) => <DeltaCell value={r.hybrid.delta} />,
          },
          {
            key: "correctness",
            header: "Correctness",
            render: (r) => <ABPair m={r.correctness} fmt={fmt2} />,
          },
          {
            key: "dCorrectness",
            header: "Δ correctness",
            render: (r) => <DeltaCell value={r.correctness.delta} />,
          },
          {
            key: "retrieval",
            header: "Retrieval",
            render: (r) => <ABPair m={r.retrieval} fmt={fmt2} />,
          },
          {
            key: "dRetrieval",
            header: "Δ retrieval",
            render: (r) => <DeltaCell value={r.retrieval.delta} />,
          },
        ]}
        data={rows}
        rowKey={(r) => r.caseId}
      />
    </Card>
  );
}

/**
 * The run's answer — markdown when persisted as an array of lines (canvas
 * evals), pretty JSON otherwise. Fail border preserved either way.
 */
function ActualAnswer({ finalAnswer, pass }: { finalAnswer: string | null; pass: boolean | null }) {
  const value = safeParseAnswer(finalAnswer);
  if (isStringArray(value)) {
    return (
      <div
        style={
          pass === false ? { ...mdPanelStyle, borderLeft: "3px solid var(--red)" } : mdPanelStyle
        }
      >
        <Markdown content={value.join("\n")} />
      </div>
    );
  }
  return (
    <pre style={pass === false ? { ...preStyle, borderLeft: "3px solid var(--red)" } : preStyle}>
      {pretty(value)}
    </pre>
  );
}

function SideActualPanel({ label, result }: { label: string; result: JoinedEvalResultRow | null }) {
  return (
    <div>
      <div style={sectionHeadingStyle}>{label} · Actual</div>
      {!result ? (
        <div style={mutedStyle}>not run in this eval run</div>
      ) : result.runStatus === "error" ? (
        <pre style={{ ...preStyle, borderLeft: "3px solid var(--red)", color: "var(--red)" }}>
          {result.runError ?? "(no error message recorded)"}
        </pre>
      ) : result.finalAnswer == null ? (
        <div style={mutedStyle}>no final answer recorded — see the run's detail page</div>
      ) : (
        <ActualAnswer finalAnswer={result.finalAnswer} pass={result.pass} />
      )}
    </div>
  );
}

function SideScoresPanel({ label, result }: { label: string; result: JoinedEvalResultRow | null }) {
  return (
    <div>
      <div style={sectionHeadingStyle}>{label} · Scores</div>
      {!result ? (
        <div style={mutedStyle}>not run in this eval run</div>
      ) : !result.scores || result.scores.length === 0 ? (
        <div style={mutedStyle}>no scores recorded</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {result.scores.map((score, i) => (
            <div
              key={`${score.name}-${i}`}
              style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}
            >
              <span style={{ fontFamily: "var(--font-mono)" }}>{score.name}</span>
              <span style={{ color: "var(--fg-muted)" }}>{score.value ?? "—"}</span>
              {score.passed !== undefined && (
                <Badge tone={score.passed ? "green" : "red"}>
                  {score.passed ? "pass" : "fail"}
                </Badge>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function CompareCaseExpanded({
  row,
  caseRow,
}: {
  row: ComparisonCaseRow;
  caseRow: EvalCaseRow | undefined;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {caseRow && (
        <details>
          <summary style={{ cursor: "pointer", fontSize: 12, color: "var(--fg-muted)" }}>
            Input / Expected
          </summary>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 6 }}>
            <div>
              <div style={sectionHeadingStyle}>Input</div>
              <pre style={preStyle}>{pretty(caseRow.input)}</pre>
            </div>
            <div>
              <div style={sectionHeadingStyle}>Expected</div>
              <pre style={preStyle}>{pretty(caseRow.expected)}</pre>
            </div>
          </div>
        </details>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <SideActualPanel label="A" result={row.a} />
        <SideActualPanel label="B" result={row.b} />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <SideScoresPanel label="A" result={row.a} />
        <SideScoresPanel label="B" result={row.b} />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <div>
          <div style={sectionHeadingStyle}>A · Trace</div>
          <TraceSection traceId={row.a?.traceId ?? null} />
        </div>
        <div>
          <div style={sectionHeadingStyle}>B · Trace</div>
          <TraceSection traceId={row.b?.traceId ?? null} />
        </div>
      </div>
    </div>
  );
}

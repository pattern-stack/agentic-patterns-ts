/**
 * /eval/compare/:aId/:bId — A/B compare, client-side (E5b, #138).
 *
 * Two parallel `fetchEvalRunDetail` calls (both already served by #136) —
 * strictly richer per case than the store's `compareEvalRuns` HTTP payload
 * would be (spec finding 3), so no server change backs this view. Alignment
 * + the six-bucket delta summary is the pure `lib/evalCompare.ts` merge.
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
import { Badge } from "../../components/atoms/Badge";
import { Button } from "../../components/atoms/Button";
import { Card } from "../../components/atoms/Card";
import { AnswerPanel } from "../../components/kit/AnswerPanel";
import { AsyncState } from "../../components/kit/AsyncState";
import { JsonBlock } from "../../components/kit/JsonBlock";
import { PageHeader } from "../../components/kit/PageHeader";
import { sectionMicroHeadingStyle } from "../../components/kit/SectionHeading";
import { Stat } from "../../components/kit/Stat";
import { DataTable } from "../../components/organisms/DataTable";
import { fetchEvalCases, fetchEvalRunDetail, safeParseAnswer } from "../../lib/evalApi";
import {
  type ComparisonCaseRow,
  type DeltaKind,
  alignResults,
  summarizeComparison,
} from "../../lib/evalCompare";
import { statusTone } from "../../lib/format";
import { TraceSection } from "./CaseDetail";

const mutedStyle = { color: "var(--mute)", fontSize: 13 };

function shortSha(sha: string | null): string {
  return sha ? sha.slice(0, 7) : "—";
}

function scoresSummary(scores: JoinedEvalResultRow["scores"] | undefined): string {
  if (!scores || scores.length === 0) return "—";
  const passedCount = scores.filter((s) => s.passed === true).length;
  const first = scores[0];
  const firstStr = first ? `${first.name}: ${first.value ?? "—"}` : "";
  return `${passedCount}/${scores.length} · ${firstStr}`;
}

function resultBadge(r: JoinedEvalResultRow | null) {
  if (!r) return <Badge tone="mute">not run</Badge>;
  if (r.pass === true) return <Badge tone="ok">pass</Badge>;
  if (r.pass === false) return <Badge tone="err">fail</Badge>;
  return <Badge tone="mute">ungated</Badge>;
}

function deltaBadge(kind: DeltaKind) {
  switch (kind) {
    case "regression":
      return <Badge tone="err">regression</Badge>;
    case "improvement":
      return <Badge tone="ok">improvement</Badge>;
    case "same-pass":
    case "same-fail":
      return <Badge tone="mute">same</Badge>;
    case "ungated":
      return <Badge tone="mute">ungated</Badge>;
    case "a-only":
    case "b-only":
      return <Badge tone="mute">not run</Badge>;
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
    <Link to="/eval" style={{ color: "var(--mute)", fontSize: 13, textDecoration: "none" }}>
      ← Eval runs
    </Link>
  );

  if (state.kind !== "ok") {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {backLink}
        <AsyncState
          kind={state.kind === "not-found" ? "not-found" : state.kind}
          loading="Loading compare..."
          notFound={
            state.kind === "not-found"
              ? {
                  title: "Eval run not found",
                  body: `No eval run with id ${state.missingIds.map((id) => `"${id}"`).join(" and ")}.`,
                }
              : undefined
          }
          error={
            state.kind === "error"
              ? { title: "Failed to load compare", message: state.message }
              : undefined
          }
        />
      </div>
    );
  }

  const { a, b } = state;
  const aligned = alignResults(a.results, b.results);
  const summary = summarizeComparison(aligned);
  const differentSets = a.run.setId !== b.run.setId;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <PageHeader
        title="Compare"
        actions={
          <Button
            variant="ghost"
            size="sm"
            onClick={() => aId && bId && navigate(`/eval/compare/${bId}/${aId}`)}
          >
            Swap
          </Button>
        }
      />
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: -12 }}>
        {backLink}
      </div>

      {differentSets && (
        <Card
          style={{ borderColor: "var(--warn)", display: "flex", alignItems: "flex-start", gap: 12 }}
        >
          <div style={{ fontSize: 13, color: "var(--mute)" }}>
            Runs are from different sets — case alignment may be sparse.
          </div>
        </Card>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <ProvenanceCard label="A · baseline" run={a.run} />
        <ProvenanceCard label="B · candidate" run={b.run} />
      </div>

      <Card>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(110px, 1fr))",
            gap: 16,
          }}
        >
          <Stat label="Both passed" value={summary.bothPassed} tone="ok" />
          <Stat
            label="Both failed"
            value={summary.bothFailed}
            tone={summary.bothFailed > 0 ? "err" : undefined}
          />
          <Stat
            label="Regressions"
            value={summary.onlyAPassed}
            tone={summary.onlyAPassed > 0 ? "err" : undefined}
          />
          <Stat
            label="Improvements"
            value={summary.onlyBPassed}
            tone={summary.onlyBPassed > 0 ? "ok" : undefined}
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
        <Badge tone="mute">variant · {run.variant ?? "—"}</Badge>
        <Badge tone="mute">target · {run.targetId ?? "—"}</Badge>
        <Badge tone="mute">split · {run.split ?? "untagged"}</Badge>
        <Badge tone="mute">model · {run.model ?? "—"}</Badge>
        <Badge tone="mute" title={run.gitSha ?? undefined}>
          sha · {shortSha(run.gitSha)}
        </Badge>
        <Badge tone="mute">started · {new Date(run.tsStart).toLocaleString()}</Badge>
      </div>
    </Card>
  );
}

function SideActualPanel({ label, result }: { label: string; result: JoinedEvalResultRow | null }) {
  return (
    <div>
      <div style={sectionMicroHeadingStyle()}>{label} · Actual</div>
      {!result ? (
        <div style={mutedStyle}>not run in this eval run</div>
      ) : result.runStatus === "error" ? (
        <JsonBlock
          value={result.runError ?? "(no error message recorded)"}
          raw
          errorTinted
          style={{ color: "var(--err)" }}
        />
      ) : (
        <AnswerPanel value={safeParseAnswer(result.finalAnswer)} pass={result.pass} />
      )}
    </div>
  );
}

function SideScoresPanel({ label, result }: { label: string; result: JoinedEvalResultRow | null }) {
  return (
    <div>
      <div style={sectionMicroHeadingStyle()}>{label} · Scores</div>
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
              <span style={{ color: "var(--mute)" }}>{score.value ?? "—"}</span>
              {score.passed !== undefined && (
                <Badge tone={score.passed ? "ok" : "err"}>{score.passed ? "pass" : "fail"}</Badge>
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
}: { row: ComparisonCaseRow; caseRow: EvalCaseRow | undefined }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {caseRow && (
        <details>
          <summary style={{ cursor: "pointer", fontSize: 12, color: "var(--mute)" }}>
            Input / Expected
          </summary>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 6 }}>
            <div>
              <div style={sectionMicroHeadingStyle()}>Input</div>
              <JsonBlock value={caseRow.input} />
            </div>
            <div>
              <div style={sectionMicroHeadingStyle()}>Expected</div>
              <JsonBlock value={caseRow.expected} />
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
          <div style={sectionMicroHeadingStyle()}>A · Trace</div>
          <TraceSection traceId={row.a?.traceId ?? null} />
        </div>
        <div>
          <div style={sectionMicroHeadingStyle()}>B · Trace</div>
          <TraceSection traceId={row.b?.traceId ?? null} />
        </div>
      </div>
    </div>
  );
}

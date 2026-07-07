/**
 * /eval/runs/:id — a single eval run's results (E5a, #137; live mode #139/E5c).
 *
 * Sequential dependent fetches (the `ConversationDetailPage` precedent):
 * `fetchEvalRunDetail(id)` first, then — when `run.setId` is non-null —
 * `fetchEvalCases(run.setId)` to build the case-bank map the expanded row
 * joins `expected` from. A missing/unconfigured case bank degrades to a
 * per-case fallback ("case not in bank"), not a page error — the run detail
 * is still useful without it.
 *
 * Live mode (#139): when the fetched run is `status === "running"`,
 * `useEvalRunStream` attaches the SSE feed — hydrate-then-attach recovers a
 * mid-run page reload for free (fact 5: the persisted partial state GET
 * already returns everything completed so far). Streamed `case.result` rows
 * are merged into the table by `caseId` (upsert, never duplicate); on
 * `run.finished` the REST detail is refetched (the store is truth, the
 * stream is a live approximation); on `run.detached` (a concurrent `ap eval`
 * or an orphaned row) the page falls back to 3s polling.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { EvalCaseRow, EvalRunRow, EvalRunSummary, JoinedEvalResultRow } from "../../api/types";
import { Badge, type BadgeTone } from "../../components/atoms/Badge";
import { Card } from "../../components/atoms/Card";
import { AsyncState } from "../../components/kit/AsyncState";
import { Stat } from "../../components/kit/Stat";
import { DataTable } from "../../components/organisms/DataTable";
import { type StreamedCaseResult, useEvalRunStream } from "../../hooks/useEvalRunStream";
import { fetchEvalCases, fetchEvalRunDetail } from "../../lib/evalApi";
import { formatDuration, formatMs, statusTone } from "../../lib/format";
import { CaseDetail } from "./CaseDetail";

/** `StreamedCaseResult` -> the `JoinedEvalResultRow` shape the table renders. */
function streamedToRow(evalRunId: string, s: StreamedCaseResult): JoinedEvalResultRow {
  return {
    evalRunId,
    caseId: s.caseId,
    runId: null,
    scores: s.scores,
    pass: s.pass,
    traceId: s.traceId ?? null,
    runStatus: s.succeeded ? "ok" : "error",
    finalAnswer: s.finalAnswer,
    inputTokens: s.inputTokens,
    outputTokens: s.outputTokens,
    finishReason: null,
    elapsedMs: null,
    runError: s.error ?? null,
  };
}

/** Merge streamed rows over the fetched results, keyed by caseId (upsert, no dupes). */
function mergeResults(
  fetched: readonly JoinedEvalResultRow[],
  evalRunId: string,
  streamed: ReadonlyMap<string, StreamedCaseResult>,
): JoinedEvalResultRow[] {
  if (streamed.size === 0) return [...fetched];
  const byId = new Map(fetched.map((r) => [r.caseId, r]));
  for (const s of streamed.values()) {
    byId.set(s.caseId, streamedToRow(evalRunId, s));
  }
  return [...byId.values()].sort((a, b) => a.caseId.localeCompare(b.caseId));
}

function shortSha(sha: string | null): string {
  return sha ? sha.slice(0, 7) : "—";
}

function passTone(pass: boolean | null): BadgeTone {
  if (pass === true) return "ok";
  if (pass === false) return "err";
  return "mute";
}

function passLabel(pass: boolean | null): string {
  if (pass === true) return "pass";
  if (pass === false) return "fail";
  return "ungated";
}

/** Round a numeric score to 3 sig-figs without trailing-zero noise (0.6666… → 0.667, 1 → 1). */
function fmtScoreValue(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return typeof value === "number" ? String(Number(value.toFixed(3))) : String(value);
}

function scoresSummary(scores: JoinedEvalResultRow["scores"]): string {
  if (!scores || scores.length === 0) return "—";
  const passedCount = scores.filter((s) => s.passed === true).length;
  const first = scores[0];
  const firstStr = first ? `${first.name}: ${fmtScoreValue(first.value)}` : "";
  return `${passedCount}/${scores.length} · ${firstStr}`;
}

type DetailState =
  | { kind: "loading" }
  | { kind: "not-found" }
  | { kind: "unconfigured" }
  | { kind: "error"; message: string }
  | { kind: "ok"; run: EvalRunRow; results: JoinedEvalResultRow[]; summary: EvalRunSummary };

export function EvalRunDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [state, setState] = useState<DetailState>({ kind: "loading" });
  const [casesById, setCasesById] = useState<Map<string, EvalCaseRow>>(new Map());
  const [expandedKey, setExpandedKey] = useState<string | undefined>(undefined);

  // Live mode (#139) — attach only once the fetched run is genuinely
  // "running"; disabled (`null`) otherwise, including while still loading.
  const streamRunId = id && state.kind === "ok" && state.run.status === "running" ? id : null;
  const {
    status: streamStatus,
    progress,
    results: streamedResults,
    finishedStatus,
  } = useEvalRunStream(streamRunId);

  const load = useCallback(
    async (opts: { showSpinner: boolean } = { showSpinner: true }): Promise<boolean> => {
      if (!id) return false;
      if (opts.showSpinner) {
        setState({ kind: "loading" });
        setExpandedKey(undefined);
      }
      try {
        const detail = await fetchEvalRunDetail(id);
        if (detail.kind === "not-found") {
          setState({ kind: "not-found" });
          return true;
        }
        if (detail.kind === "unconfigured") {
          setState({ kind: "unconfigured" });
          return true;
        }

        const { run, results, summary } = detail.data;
        let cases = new Map<string, EvalCaseRow>();
        if (run.setId) {
          try {
            const caseFetch = await fetchEvalCases(run.setId);
            if (caseFetch.kind === "ok") {
              cases = new Map(caseFetch.data.map((c) => [c.caseId, c]));
            }
            // unconfigured -> leave cases empty; CaseDetail falls back per-case.
          } catch {
            // Case-bank fetch errors also degrade to the per-case fallback,
            // not a page error — the run detail is still useful without it.
          }
        }
        setCasesById(cases);
        setState({ kind: "ok", run, results, summary });
        return run.status !== "running";
      } catch (e) {
        setState({ kind: "error", message: e instanceof Error ? e.message : String(e) });
        return true;
      }
    },
    [id],
  );

  // `load` is stable per `id` (see its own useCallback deps) — depending on
  // `id` directly here avoids re-running this effect on every render.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see comment above.
  useEffect(() => {
    void load();
  }, [id]);

  // On run.finished: the stream was a live approximation — refetch the
  // authoritative joined rows and let the natural state transition
  // (run.status leaves "running") disable the stream.
  const refetchedForFinish = useRef<string | null>(null);
  useEffect(() => {
    if (finishedStatus === null || !id) return;
    if (refetchedForFinish.current === id) return;
    refetchedForFinish.current = id;
    void load({ showSpinner: false });
  }, [finishedStatus, id, load]);

  // On run.detached (a concurrent `ap eval`, or an orphaned row from a
  // restarted server): 3s poll until terminal — this also makes a
  // concurrently-running CLI eval watchable from the dashboard.
  useEffect(() => {
    if (streamStatus !== "detached") return;
    const timer = setInterval(() => {
      void load({ showSpinner: false }).then((terminal) => {
        if (terminal) clearInterval(timer);
      });
    }, 3000);
    return () => clearInterval(timer);
  }, [streamStatus, load]);

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
          kind={state.kind}
          loading="Loading eval run..."
          notFound={{
            title: "Eval run not found",
            body: id ? <>No eval run with id "{id}".</> : "No eval run id given.",
          }}
          error={
            state.kind === "error"
              ? { title: "Failed to load eval run", message: state.message }
              : undefined
          }
        />
      </div>
    );
  }

  const { run, results, summary } = state;
  const duration = formatDuration(run.tsStart, run.tsEnd);
  const mergedResults = mergeResults(results, run.id, streamedResults);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        {backLink}
        <h1 style={{ fontSize: 20, fontWeight: 600, margin: 0 }}>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 14 }}>{run.id}</span>
        </h1>
        <Badge tone={statusTone(run.status)}>{run.status}</Badge>
        {streamStatus === "detached" && <Badge tone="mute">watching (detached)</Badge>}
      </div>

      <Card>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" }}>
          {run.setId ? (
            <Link
              to={`/eval/sets/${run.setId}`}
              style={{ textDecoration: "none" }}
              title="View this eval set"
            >
              <Badge tone="accent">set · {run.setId}</Badge>
            </Link>
          ) : (
            <Badge tone="mute">set · —</Badge>
          )}
          {run.targetId ? (
            <Link
              to={`/agents/${encodeURIComponent(run.targetId)}`}
              style={{ textDecoration: "none" }}
              title="View this agent"
            >
              <Badge tone="mute">target · {run.targetId}</Badge>
            </Link>
          ) : (
            <Badge tone="mute">target · —</Badge>
          )}
          <Badge tone="mute">variant · {run.variant ?? "—"}</Badge>
          <Badge tone="mute">split · {run.split ?? "untagged"}</Badge>
          <Badge tone="mute">model · {run.model ?? "—"}</Badge>
          {run.scorer != null && <Badge tone="mute">scorer · {run.scorer}</Badge>}
          <Badge tone="mute" title={run.gitSha ?? undefined}>
            sha · {shortSha(run.gitSha)}
          </Badge>
          <Badge tone="mute">started · {new Date(run.tsStart).toLocaleString()}</Badge>
          {duration && <Badge tone="mute">{duration}</Badge>}
        </div>
      </Card>

      {run.status === "running" && progress && (
        <Card>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div style={{ fontSize: 13, color: "var(--mute)", whiteSpace: "nowrap" }}>
              {progress.completed}
              {progress.total !== null ? ` / ${progress.total}` : ""} cases
            </div>
            <div
              style={{
                flex: 1,
                height: 8,
                background: "var(--background)",
                borderRadius: 999,
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  width:
                    progress.total && progress.total > 0
                      ? `${Math.round((progress.completed / progress.total) * 100)}%`
                      : "0%",
                  height: "100%",
                  background: "var(--accent)",
                }}
              />
            </div>
          </div>
        </Card>
      )}

      <Card>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(110px, 1fr))",
            gap: 16,
          }}
        >
          <Stat label="Cases" value={summary.cases} />
          <Stat label="Passed" value={summary.passed} tone="ok" />
          <Stat
            label="Failed"
            value={summary.failed}
            tone={summary.failed > 0 ? "err" : undefined}
          />
          <Stat label="Ungated" value={summary.ungated} />
          <Stat
            label="Errored"
            value={summary.errored}
            tone={summary.errored > 0 ? "err" : undefined}
          />
          <Stat
            label="Pass Rate"
            value={summary.passRate === null ? "—" : `${Math.round(summary.passRate * 100)}%`}
          />
          <Stat label="Tokens In" value={summary.inputTokens.toLocaleString()} />
          <Stat label="Tokens Out" value={summary.outputTokens.toLocaleString()} />
        </div>
      </Card>

      <Card padded={false}>
        <DataTable<JoinedEvalResultRow>
          columns={[
            {
              key: "caseId",
              header: "Case",
              render: (row) => (
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>{row.caseId}</span>
              ),
            },
            {
              key: "pass",
              header: "Result",
              render: (row) => <Badge tone={passTone(row.pass)}>{passLabel(row.pass)}</Badge>,
            },
            {
              key: "scores",
              header: "Scores",
              render: (row) => scoresSummary(row.scores),
            },
            {
              key: "runStatus",
              header: "Run",
              render: (row) =>
                row.runStatus === "error" ? (
                  <Badge tone="err">error</Badge>
                ) : (
                  <span style={{ color: "var(--ink-3)" }}>—</span>
                ),
            },
            {
              key: "tokens",
              header: "Tokens",
              align: "right",
              render: (row) => `${row.inputTokens ?? 0} / ${row.outputTokens ?? 0}`,
            },
            {
              key: "elapsedMs",
              header: "Elapsed",
              align: "right",
              render: (row) => formatMs(row.elapsedMs),
            },
          ]}
          data={mergedResults}
          rowKey={(row) => row.caseId}
          expandedKey={expandedKey}
          onToggleExpand={(key) => setExpandedKey((prev) => (prev === key ? undefined : key))}
          renderExpanded={(row) => <CaseDetail result={row} caseRow={casesById.get(row.caseId)} />}
        />
      </Card>
    </div>
  );
}

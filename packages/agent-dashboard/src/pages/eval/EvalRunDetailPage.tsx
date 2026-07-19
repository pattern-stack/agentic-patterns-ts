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
import { Spinner } from "../../components/atoms/Spinner";
import { AlertIcon } from "../../components/atoms/icons";
import { DataTable } from "../../components/organisms/DataTable";
import { type StreamedCaseResult, useEvalRunStream } from "../../hooks/useEvalRunStream";
import { fetchEvalCases, fetchEvalRunDetail } from "../../lib/evalApi";
import { CaseDetail } from "./CaseDetail";
import { RunPanels } from "./panels/RunPanels";

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

function formatDuration(startedAt: string, completedAt: string | null): string | null {
  if (!completedAt) return null;
  const ms = new Date(completedAt).getTime() - new Date(startedAt).getTime();
  if (Number.isNaN(ms) || ms < 0) return null;
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 1000)}s`;
}

function formatElapsed(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
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

function passTone(pass: boolean | null): BadgeTone {
  if (pass === true) return "green";
  if (pass === false) return "red";
  return "muted";
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
        <span>Loading eval run...</span>
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
            {id ? <>No eval run with id "{id}".</> : "No eval run id given."}
          </div>
        </Card>
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
              Failed to load eval run
            </div>
            <div style={{ color: "var(--fg-muted)", fontSize: 14 }}>{state.message}</div>
          </div>
        </Card>
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
        {streamStatus === "detached" && <Badge tone="muted">watching (detached)</Badge>}
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
            <Badge tone="muted">set · —</Badge>
          )}
          {run.targetId ? (
            <Link
              to={`/agents/${encodeURIComponent(run.targetId)}`}
              style={{ textDecoration: "none" }}
              title="View this agent"
            >
              <Badge tone="muted">target · {run.targetId}</Badge>
            </Link>
          ) : (
            <Badge tone="muted">target · —</Badge>
          )}
          <Badge tone="muted">variant · {run.variant ?? "—"}</Badge>
          <Badge tone="muted">split · {run.split ?? "untagged"}</Badge>
          <Badge tone="muted">model · {run.model ?? "—"}</Badge>
          {run.scorer != null && <Badge tone="muted">scorer · {run.scorer}</Badge>}
          <Badge tone="muted" title={run.gitSha ?? undefined}>
            sha · {shortSha(run.gitSha)}
          </Badge>
          <Badge tone="muted">started · {new Date(run.tsStart).toLocaleString()}</Badge>
          {duration && <Badge tone="muted">{duration}</Badge>}
        </div>
      </Card>

      {run.status === "running" && progress && (
        <Card>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div style={{ fontSize: 13, color: "var(--fg-muted)", whiteSpace: "nowrap" }}>
              {progress.completed}
              {progress.total !== null ? ` / ${progress.total}` : ""} cases
            </div>
            <div
              style={{
                flex: 1,
                height: 8,
                background: "var(--bg-inset)",
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
          <Stat label="Passed" value={summary.passed} color="var(--green)" />
          <Stat
            label="Failed"
            value={summary.failed}
            color={summary.failed > 0 ? "var(--red)" : undefined}
          />
          <Stat label="Ungated" value={summary.ungated} />
          <Stat
            label="Errored"
            value={summary.errored}
            color={summary.errored > 0 ? "var(--red)" : undefined}
          />
          <Stat
            label="Pass Rate"
            value={summary.passRate === null ? "—" : `${Math.round(summary.passRate * 100)}%`}
          />
          <Stat label="Tokens In" value={summary.inputTokens.toLocaleString()} />
          <Stat label="Tokens Out" value={summary.outputTokens.toLocaleString()} />
        </div>
      </Card>

      <RunPanels results={mergedResults} />

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
                  <Badge tone="red">error</Badge>
                ) : (
                  <span style={{ color: "var(--fg-subtle)" }}>—</span>
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
              render: (row) => formatElapsed(row.elapsedMs),
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

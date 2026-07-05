/**
 * /eval/sets/:id/cases/:caseId — one case + its cross-run history (WI-4).
 *
 * One fetch (`fetchEvalCaseDetail`) returns the banked case and every run that
 * evaluated it (newest-first). The case's input/expected render as pretty JSON
 * (the `CaseDetail` `preStyle` idiom); the history is a `DataTable` whose rows
 * link to their run and expand to show that run's actual answer against the
 * case's expected. Case editing lands in WI-5.
 */

import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import type { EvalCaseHistoryRow, EvalCaseRow } from "../../api/types";
import { Badge, type BadgeTone } from "../../components/atoms/Badge";
import { Button } from "../../components/atoms/Button";
import { Card } from "../../components/atoms/Card";
import { Chip } from "../../components/atoms/Chip";
import { Spinner } from "../../components/atoms/Spinner";
import { AlertIcon } from "../../components/atoms/icons";
import { DataTable } from "../../components/organisms/DataTable";
import { fetchEvalCaseDetail, safeParseAnswer } from "../../lib/evalApi";
import { CaseEditModal } from "./CaseEditModal";

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

function relative(dateStr: string | undefined | null): string {
  if (!dateStr) return "—";
  const then = new Date(dateStr).getTime();
  if (Number.isNaN(then)) return String(dateStr);
  const diffSec = Math.round((Date.now() - then) / 1000);
  const abs = Math.abs(diffSec);
  if (abs < 60) return `${diffSec}s ago`;
  if (abs < 3600) return `${Math.round(diffSec / 60)}m ago`;
  if (abs < 86400) return `${Math.round(diffSec / 3600)}h ago`;
  return `${Math.round(diffSec / 86400)}d ago`;
}

function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

function formatElapsed(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
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

type LoadState =
  | { kind: "loading" }
  | { kind: "not-found" }
  | { kind: "unconfigured" }
  | { kind: "error"; message: string }
  | { kind: "ok"; case: EvalCaseRow; history: EvalCaseHistoryRow[] };

export function EvalCaseDetailPage() {
  const { id, caseId } = useParams<{ id: string; caseId: string }>();
  const navigate = useNavigate();
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [expandedKey, setExpandedKey] = useState<string | undefined>(undefined);
  const [editing, setEditing] = useState(false);

  const load = useCallback(async () => {
    if (!id || !caseId) return;
    setState({ kind: "loading" });
    setExpandedKey(undefined);
    try {
      const detail = await fetchEvalCaseDetail(id, caseId);
      if (detail.kind === "not-found") {
        setState({ kind: "not-found" });
        return;
      }
      if (detail.kind === "unconfigured") {
        setState({ kind: "unconfigured" });
        return;
      }
      setState({ kind: "ok", case: detail.data.case, history: detail.data.history });
    } catch (e) {
      setState({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    }
  }, [id, caseId]);

  useEffect(() => {
    void load();
  }, [load]);

  const backLink = (
    <Link
      to={id ? `/eval/sets/${id}` : "/eval/sets"}
      style={{ color: "var(--fg-muted)", fontSize: 13, textDecoration: "none" }}
    >
      ← {id ?? "Eval sets"}
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
        <span>Loading eval case...</span>
      </div>
    );
  }

  if (state.kind === "not-found") {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {backLink}
        <Card style={{ textAlign: "center", padding: 40, color: "var(--fg-muted)" }}>
          <div style={{ fontWeight: 600, color: "var(--fg-default)", marginBottom: 6 }}>
            Eval case not found
          </div>
          <div style={{ fontSize: 14 }}>
            No case "{caseId}" in set "{id}".
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
              Failed to load eval case
            </div>
            <div style={{ color: "var(--fg-muted)", fontSize: 14 }}>{state.message}</div>
          </div>
        </Card>
      </div>
    );
  }

  const { case: caseRow, history } = state;
  const heldOut = caseRow.split === "test";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 10,
          flexWrap: "wrap",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          {backLink}
          <h1 style={{ fontSize: 20, fontWeight: 600, margin: 0 }}>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 15 }}>{caseRow.caseId}</span>
          </h1>
          <Badge tone={heldOut ? "yellow" : "muted"}>{caseRow.split ?? "untagged"}</Badge>
          {heldOut && <Badge tone="yellow">held-out</Badge>}
        </div>
        <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>
          Edit
        </Button>
      </div>

      {editing && id && (
        <CaseEditModal
          setId={id}
          mode="edit"
          initial={caseRow}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            void load();
          }}
        />
      )}

      <Card>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
          {caseRow.tags && caseRow.tags.length > 0 ? (
            caseRow.tags.map((t) => (
              <Chip key={t} tone="mono">
                {t}
              </Chip>
            ))
          ) : (
            <span style={{ fontSize: 13, color: "var(--fg-subtle)" }}>no tags</span>
          )}
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 14 }}>
          <div>
            <div style={sectionHeadingStyle}>Input</div>
            <pre style={preStyle}>{pretty(caseRow.input)}</pre>
          </div>
          <div>
            <div style={sectionHeadingStyle}>Expected</div>
            {caseRow.expected === null || caseRow.expected === undefined ? (
              <div style={{ color: "var(--fg-muted)", fontSize: 13 }}>no expected value</div>
            ) : (
              <pre style={preStyle}>{pretty(caseRow.expected)}</pre>
            )}
          </div>
        </div>
      </Card>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <h2 style={{ fontSize: 16, fontWeight: 600, margin: 0 }}>Run history</h2>
        {history.length === 0 ? (
          <Card style={{ textAlign: "center", padding: 32, color: "var(--fg-muted)" }}>
            This case has not been evaluated in any run yet.
          </Card>
        ) : (
          <Card padded={false}>
            <DataTable<EvalCaseHistoryRow>
              columns={[
                {
                  key: "evalRunId",
                  header: "Run",
                  render: (row) => (
                    <span style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>
                      {shortId(row.evalRunId)}
                    </span>
                  ),
                },
                { key: "tsStart", header: "Started", render: (row) => relative(row.tsStart) },
                { key: "targetId", header: "Target", render: (row) => row.targetId ?? "—" },
                { key: "variant", header: "Variant", render: (row) => row.variant ?? "—" },
                {
                  key: "split",
                  header: "Split",
                  render: (row) => <Badge tone="muted">{row.split ?? "untagged"}</Badge>,
                },
                {
                  key: "pass",
                  header: "Result",
                  render: (row) => <Badge tone={passTone(row.pass)}>{passLabel(row.pass)}</Badge>,
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
              data={history}
              rowKey={(row) => row.evalRunId}
              expandedKey={expandedKey}
              onToggleExpand={(key) => setExpandedKey((prev) => (prev === key ? undefined : key))}
              renderExpanded={(row) => (
                <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                    <div>
                      <div style={sectionHeadingStyle}>Expected</div>
                      {caseRow.expected === null || caseRow.expected === undefined ? (
                        <div style={{ color: "var(--fg-muted)", fontSize: 13 }}>
                          no expected value
                        </div>
                      ) : (
                        <pre style={preStyle}>{pretty(caseRow.expected)}</pre>
                      )}
                    </div>
                    <div>
                      <div style={sectionHeadingStyle}>Actual</div>
                      <pre
                        style={
                          row.pass === false
                            ? { ...preStyle, borderLeft: "3px solid var(--red)" }
                            : preStyle
                        }
                      >
                        {pretty(safeParseAnswer(row.finalAnswer))}
                      </pre>
                    </div>
                  </div>
                  <Link
                    to={`/eval/runs/${row.evalRunId}`}
                    style={{ fontSize: 13, color: "var(--accent)", textDecoration: "none" }}
                    onClick={(e) => {
                      e.preventDefault();
                      navigate(`/eval/runs/${row.evalRunId}`);
                    }}
                  >
                    View full run →
                  </Link>
                </div>
              )}
            />
          </Card>
        )}
      </div>
    </div>
  );
}

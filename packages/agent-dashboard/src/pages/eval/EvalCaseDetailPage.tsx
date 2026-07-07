/**
 * /eval/sets/:id/cases/:caseId — one case + its cross-run history (WI-4).
 *
 * One fetch (`fetchEvalCaseDetail`) returns the banked case and every run that
 * evaluated it (newest-first). The case's input/expected render as pretty JSON
 * (the kit `JsonBlock` idiom); the history is a `DataTable` whose rows link to
 * their run and expand to show that run's actual answer against the case's
 * expected. Case editing lands in WI-5.
 */

import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import type { EvalCaseHistoryRow, EvalCaseRow } from "../../api/types";
import { Badge, type BadgeTone } from "../../components/atoms/Badge";
import { Button } from "../../components/atoms/Button";
import { Card } from "../../components/atoms/Card";
import { AnswerPanel } from "../../components/kit/AnswerPanel";
import { AsyncState } from "../../components/kit/AsyncState";
import { JsonBlock } from "../../components/kit/JsonBlock";
import { sectionMicroHeadingStyle } from "../../components/kit/SectionHeading";
import { DataTable } from "../../components/organisms/DataTable";
import { fetchEvalCaseDetail, safeParseAnswer } from "../../lib/evalApi";
import { formatMs, relTime, shortId } from "../../lib/format";
import { CaseEditModal } from "./CaseEditModal";

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
      style={{ color: "var(--mute)", fontSize: 13, textDecoration: "none" }}
    >
      ← {id ?? "Eval sets"}
    </Link>
  );

  if (state.kind !== "ok") {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {backLink}
        <AsyncState
          kind={state.kind}
          loading="Loading eval case..."
          notFound={{ title: "Eval case not found", body: `No case "${caseId}" in set "${id}".` }}
          error={
            state.kind === "error"
              ? { title: "Failed to load eval case", message: state.message }
              : undefined
          }
        />
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
          <Badge tone={heldOut ? "warn" : "mute"}>{caseRow.split ?? "untagged"}</Badge>
          {heldOut && <Badge tone="warn">held-out</Badge>}
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
              <Badge key={t} tone="mute" mono>
                {t}
              </Badge>
            ))
          ) : (
            <span style={{ fontSize: 13, color: "var(--ink-3)" }}>no tags</span>
          )}
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 14 }}>
          <div>
            <div style={sectionMicroHeadingStyle()}>Input</div>
            <JsonBlock value={caseRow.input} />
          </div>
          <div>
            <div style={sectionMicroHeadingStyle()}>Expected</div>
            {caseRow.expected === null || caseRow.expected === undefined ? (
              <div style={{ color: "var(--ink-2)", fontSize: 13 }}>no expected value</div>
            ) : (
              <JsonBlock value={caseRow.expected} />
            )}
          </div>
        </div>
      </Card>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <h2 style={{ fontSize: 16, fontWeight: 600, margin: 0 }}>Run history</h2>
        {history.length === 0 ? (
          <AsyncState
            kind="empty"
            empty={{ title: "This case has not been evaluated in any run yet." }}
          />
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
                { key: "tsStart", header: "Started", render: (row) => relTime(row.tsStart) },
                { key: "targetId", header: "Target", render: (row) => row.targetId ?? "—" },
                { key: "variant", header: "Variant", render: (row) => row.variant ?? "—" },
                {
                  key: "split",
                  header: "Split",
                  render: (row) => <Badge tone="mute">{row.split ?? "untagged"}</Badge>,
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
              data={history}
              rowKey={(row) => row.evalRunId}
              expandedKey={expandedKey}
              onToggleExpand={(key) => setExpandedKey((prev) => (prev === key ? undefined : key))}
              renderExpanded={(row) => (
                <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                    <div>
                      <div style={sectionMicroHeadingStyle()}>Expected</div>
                      {caseRow.expected === null || caseRow.expected === undefined ? (
                        <div style={{ color: "var(--ink-2)", fontSize: 13 }}>no expected value</div>
                      ) : (
                        <JsonBlock value={caseRow.expected} />
                      )}
                    </div>
                    <div>
                      <div style={sectionMicroHeadingStyle()}>Actual</div>
                      <AnswerPanel value={safeParseAnswer(row.finalAnswer)} pass={row.pass} />
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

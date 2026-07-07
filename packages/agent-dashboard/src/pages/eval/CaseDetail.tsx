/**
 * Expanded-row content for a per-case eval result (`EvalRunDetailPage`'s
 * `DataTable.renderExpanded`). Top to bottom: the case input (collapsed by
 * default, context for reading the diff), actual-vs-expected side by side,
 * the full score list, and a lazy trace drill-down.
 */

import { useState } from "react";
import type { EvalCaseRow, EvalScoreLike, JoinedEvalResultRow } from "../../api/types";
import { Markdown } from "../../chat/atoms";
import { Badge } from "../../components/atoms/Badge";
import { Button } from "../../components/atoms/Button";
import { Spinner } from "../../components/atoms/Spinner";
import { AnswerPanel } from "../../components/kit/AnswerPanel";
import { JsonBlock } from "../../components/kit/JsonBlock";
import { sectionMicroHeadingStyle } from "../../components/kit/SectionHeading";
import { EventStream } from "../../components/organisms/EventStream";
import type { StreamEvent } from "../../hooks/useEventStream";
import { safeParseAnswer } from "../../lib/evalApi";
import { fetchTraceEvents } from "../../lib/eventApi";

const mutedStyle = { color: "var(--mute)", fontSize: 13 };

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

/**
 * Score details often carry a `explanationMdLines: string[]` (a judge's
 * rationale as markdown lines). Returns the joined markdown, or null when
 * absent/malformed (caller keeps the raw-JSON expander either way).
 */
function explanationMd(detail: EvalScoreLike["detail"]): string | null {
  const lines = (detail as { explanationMdLines?: unknown } | undefined)?.explanationMdLines;
  return isStringArray(lines) && lines.length > 0 ? lines.join("\n") : null;
}

interface CaseDetailProps {
  result: JoinedEvalResultRow;
  caseRow: EvalCaseRow | undefined;
}

export function CaseDetail({ result, caseRow }: CaseDetailProps) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {caseRow && (
        <details>
          <summary style={{ cursor: "pointer", fontSize: 12, color: "var(--mute)" }}>Input</summary>
          <div style={{ marginTop: 6 }}>
            <JsonBlock value={caseRow.input} />
          </div>
        </details>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <div>
          <div style={sectionMicroHeadingStyle()}>Expected</div>
          {caseRow ? (
            <JsonBlock value={caseRow.expected} />
          ) : (
            <div style={mutedStyle}>expected unavailable — case not in bank</div>
          )}
        </div>
        <div>
          <div style={sectionMicroHeadingStyle()}>Actual</div>
          {result.runStatus === "error" ? (
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
      </div>

      <div>
        <div style={sectionMicroHeadingStyle()}>Scores</div>
        {!result.scores || result.scores.length === 0 ? (
          <div style={mutedStyle}>no scores recorded</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {result.scores.map((score, i) => (
              <ScoreRow key={`${score.name}-${i}`} score={score} />
            ))}
          </div>
        )}
      </div>

      <div>
        <div style={sectionMicroHeadingStyle()}>Trace</div>
        <TraceSection traceId={result.traceId} />
      </div>
    </div>
  );
}

function ScoreRow({ score }: { score: EvalScoreLike }) {
  const extra = score.detail ?? (score.error ? { error: score.error } : undefined);
  const mdExplanation = explanationMd(score.detail);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
        <span style={{ fontFamily: "var(--font-mono)" }}>{score.name}</span>
        <span style={{ color: "var(--mute)" }}>
          {typeof score.value === "number" ? Number(score.value.toFixed(3)) : (score.value ?? "—")}
        </span>
        {score.passed !== undefined && (
          <Badge tone={score.passed ? "ok" : "err"}>{score.passed ? "pass" : "fail"}</Badge>
        )}
      </div>
      {mdExplanation && (
        <div
          style={{
            margin: 0,
            marginTop: 2,
            padding: "2px 12px",
            background: "var(--background)",
            borderRadius: "var(--radius-sm)",
            fontSize: 13,
            overflowX: "auto",
            wordBreak: "break-word",
          }}
        >
          <Markdown content={mdExplanation} />
        </div>
      )}
      {extra && (
        <details>
          <summary style={{ cursor: "pointer", fontSize: 12, color: "var(--mute)" }}>
            {mdExplanation ? "raw detail" : "details"}
          </summary>
          <div style={{ marginTop: 4 }}>
            <JsonBlock value={extra} />
          </div>
        </details>
      )}
    </div>
  );
}

type TraceState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "loaded"; events: StreamEvent[] }
  | { kind: "error"; message: string };

export function TraceSection({ traceId }: { traceId: string | null }) {
  const [state, setState] = useState<TraceState>({ kind: "idle" });

  if (traceId === null) {
    return <div style={mutedStyle}>No trace recorded for this case.</div>;
  }

  const load = async () => {
    setState({ kind: "loading" });
    try {
      const events = await fetchTraceEvents(traceId);
      setState({ kind: "loaded", events });
    } catch (e) {
      setState({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        {state.kind !== "loaded" && (
          <Button variant="ghost" size="sm" onClick={load} disabled={state.kind === "loading"}>
            {state.kind === "loading" && <Spinner size={12} />}
            Load trace
          </Button>
        )}
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--mute)" }}>
          {traceId}
        </span>
      </div>
      {state.kind === "error" && (
        <div style={{ color: "var(--err)", fontSize: 13 }}>{state.message}</div>
      )}
      {state.kind === "loaded" &&
        (state.events.length === 0 ? (
          <div style={mutedStyle}>No trace events found — the event log may have been purged.</div>
        ) : (
          <EventStream events={state.events} height={360} />
        ))}
    </div>
  );
}

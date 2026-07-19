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
import { EventStream } from "../../components/organisms/EventStream";
import type { StreamEvent } from "../../hooks/useEventStream";
import { safeParseAnswer } from "../../lib/evalApi";
import { fetchTraceEvents } from "../../lib/eventApi";
import { resolveDetailRenderer } from "./renderers";

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

// Inset panel for rendered markdown — the `preStyle` box chrome without the
// monospace/pre-wrap (the markdown tags own their own layout).
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

/**
 * Score details often carry a `explanationMdLines: string[]` (a judge's
 * rationale as markdown lines). Returns the joined markdown, or null when
 * absent/malformed (caller keeps the raw-JSON expander either way).
 */
function explanationMd(detail: EvalScoreLike["detail"]): string | null {
  const lines = (detail as { explanationMdLines?: unknown } | undefined)?.explanationMdLines;
  return isStringArray(lines) && lines.length > 0 ? lines.join("\n") : null;
}

/**
 * The run's answer. Canvas evals persist markdown as an array of lines
 * (`safeParseAnswer` yields a `string[]`) — render those as markdown; every
 * other shape stays pretty-printed JSON. The fail border is preserved either way.
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

interface CaseDetailProps {
  result: JoinedEvalResultRow;
  caseRow: EvalCaseRow | undefined;
}

export function CaseDetail({ result, caseRow }: CaseDetailProps) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {caseRow && (
        <details>
          <summary style={{ cursor: "pointer", fontSize: 12, color: "var(--fg-muted)" }}>
            Input
          </summary>
          <pre style={{ ...preStyle, marginTop: 6 }}>{pretty(caseRow.input)}</pre>
        </details>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <div>
          <div style={sectionHeadingStyle}>Expected</div>
          {caseRow ? (
            <pre style={preStyle}>{pretty(caseRow.expected)}</pre>
          ) : (
            <div style={mutedStyle}>expected unavailable — case not in bank</div>
          )}
        </div>
        <div>
          <div style={sectionHeadingStyle}>Actual</div>
          {result.runStatus === "error" ? (
            <pre
              style={{
                ...preStyle,
                borderLeft: "3px solid var(--red)",
                color: "var(--red)",
              }}
            >
              {result.runError ?? "(no error message recorded)"}
            </pre>
          ) : (
            <ActualAnswer finalAnswer={result.finalAnswer} pass={result.pass} />
          )}
        </div>
      </div>

      <div>
        <div style={sectionHeadingStyle}>Scores</div>
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
        <div style={sectionHeadingStyle}>Trace</div>
        <TraceSection traceId={result.traceId} />
      </div>
    </div>
  );
}

function ScoreRow({ score }: { score: EvalScoreLike }) {
  const extra = score.detail ?? (score.error ? { error: score.error } : undefined);
  const mdExplanation = explanationMd(score.detail);
  // A registered renderer for this detail's `kind` renders the structured
  // payload; `null` (no kind / unknown / malformed) leaves only the fallbacks.
  const Renderer = score.detail ? resolveDetailRenderer(score.detail) : null;
  const custom = Renderer
    ? Renderer({ detail: score.detail as Record<string, unknown>, score })
    : null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
        <span style={{ fontFamily: "var(--font-mono)" }}>{score.name}</span>
        <span style={{ color: "var(--fg-muted)" }}>
          {typeof score.value === "number" ? Number(score.value.toFixed(3)) : (score.value ?? "—")}
        </span>
        {score.passed !== undefined && (
          <Badge tone={score.passed ? "green" : "red"}>{score.passed ? "pass" : "fail"}</Badge>
        )}
      </div>
      {custom}
      {mdExplanation && (
        <div style={{ ...mdPanelStyle, marginTop: 2 }}>
          <Markdown content={mdExplanation} />
        </div>
      )}
      {extra && (
        <details>
          <summary style={{ cursor: "pointer", fontSize: 12, color: "var(--fg-muted)" }}>
            {custom || mdExplanation ? "raw detail" : "details"}
          </summary>
          <pre style={{ ...preStyle, marginTop: 4 }}>{pretty(extra)}</pre>
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
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--fg-muted)" }}>
          {traceId}
        </span>
      </div>
      {state.kind === "error" && (
        <div style={{ color: "var(--red)", fontSize: 13 }}>{state.message}</div>
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

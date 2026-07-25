/**
 * LiveTracePanel — the live trace ("the trace IS the scrubber"). Adapted from
 * swe-brain's Agent Plane. Rows grouped Setup / Iteration N / Finish; each row
 * is a typed spine dot + label + a waterfall bar (kind-coloured, placed on the
 * run's shared timeline) + mono ms/tokens. Every row is a button that seeks
 * the constellation to that step. The run is framed as chat: request at the
 * top, the final answer at the bottom (revealed only once the cursor reaches the
 * end, so the answer never lands before the graph finishes animating).
 *
 * Layout: `layout="side"` (default) is the fixed-width right-hand rail on
 * desktop; `layout="stacked"` renders full-width beneath the graph (below the
 * `md` breakpoint, per `RunSurfacePage`'s `isNarrow` switch) with a capped,
 * inner-scrolling height so it doesn't blow past one phone-screen height.
 *
 * Coexistence with `chat/`: this panel SUPERSEDES the separate chat thread on the
 * Live Run surface (it IS the run's request/answer framing + the scrubber). The
 * standalone `/chat` route keeps `chat/ChatPanel` for free-form conversation; the
 * two do not both render on the same surface.
 */
import { useEffect, useRef } from "react";
import { BLAST_COLOR } from "../graph/catalog";
import type { TraceStep } from "../graph/types";
import { T } from "../ui/tokens";

const TRACE_WIDTH = 372;
const STACKED_MAX_H = 420;

function phaseOf(step: TraceStep): string {
  if (step.kind === "finish") return "Finish";
  if (step.iter === 0 || step.kind === "context") return "Setup";
  return `Iteration ${step.iter}`;
}

function dotColor(step: TraceStep): string {
  switch (step.kind) {
    case "model":
      return "var(--accent)";
    case "tool_call":
    case "tool_result":
      return step.blast ? BLAST_COLOR[step.blast] : "var(--mute)";
    case "finish":
      return step.status === "error" ? T.tone.err.color : T.tone.ok.color;
    default:
      return "var(--mute)";
  }
}

function rowLabel(step: TraceStep): string {
  if (step.kind === "model" && step.status === "thinking") return "Thinking…";
  if (step.label) return step.label;
  if (step.kind === "tool_call") return `→ ${step.tool ?? "tool"}`;
  if (step.kind === "tool_result") {
    if (step.status === "rejected") return `${step.tool ?? "tool"} · rejected`;
    return `${step.tool ?? "tool"} · result`;
  }
  return step.kind;
}

function fmtMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

function metaRight(step: TraceStep): string {
  if (step.kind === "model") {
    const parts: string[] = [];
    if (typeof step.ctxTokens === "number") parts.push(`${(step.ctxTokens / 1000).toFixed(1)}k`);
    if (typeof step.outTokens === "number") parts.push(`${step.outTokens}`);
    return parts.join("/");
  }
  return step.note ?? "";
}

function TraceRow({
  step,
  index,
  cursor,
  startMs,
  totalMs,
  onSeek,
}: {
  step: TraceStep;
  index: number;
  cursor: number;
  startMs: number;
  totalMs: number;
  onSeek: (index: number) => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const isCurrent = index === cursor;
  const isDone = index < cursor;
  const isPending = index > cursor;

  // keep the active step in view as playback advances
  useEffect(() => {
    if (isCurrent) ref.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [isCurrent]);

  // waterfall: place the bar at its start on the run's shared timeline; colour by
  // KIND (matching the spine dot) so colour reads as direction, not speed.
  const leftPct = totalMs > 0 ? (startMs / totalMs) * 100 : 0;
  const widthPct = totalMs > 0 ? Math.max(2, (step.ms / totalMs) * 100) : 0;
  const dot = dotColor(step);
  const isTool = step.kind === "tool_call" || step.kind === "tool_result";

  return (
    <button
      ref={ref}
      type="button"
      onClick={() => onSeek(index)}
      style={{
        display: "grid",
        gridTemplateColumns: "22px 1fr auto",
        gap: 8,
        width: "100%",
        textAlign: "left",
        border: "none",
        background: isCurrent ? "var(--accent-soft)" : "transparent",
        borderLeft: `2px solid ${isCurrent ? "var(--accent)" : "transparent"}`,
        padding: "6px 12px 6px 8px",
        cursor: "pointer",
        opacity: isPending ? 0.5 : 1,
        font: "inherit",
      }}
    >
      {/* rail: spine + typed dot */}
      <span
        style={{
          position: "relative",
          display: "flex",
          justifyContent: "center",
          alignSelf: "stretch",
        }}
      >
        <span
          aria-hidden
          style={{ position: "absolute", top: 0, bottom: 0, width: 1, background: "var(--line)" }}
        />
        <span
          aria-hidden
          style={{
            position: "relative",
            marginTop: 4,
            width: 9,
            height: 9,
            borderRadius: "999px",
            background: isDone || isCurrent ? dot : "var(--paper)",
            border: `1.5px solid ${dot}`,
            boxShadow: isCurrent ? "0 0 0 3px var(--accent-soft)" : undefined,
          }}
        />
      </span>

      {/* body */}
      <span style={{ minWidth: 0 }}>
        <span
          style={{
            display: "block",
            fontSize: T.fz.small,
            fontWeight: isCurrent ? 600 : 500,
            color: "var(--ink)",
            fontFamily: isTool ? T.font.mono : T.font.sans,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {rowLabel(step)}
        </span>
        {step.detail && (
          <span
            style={{
              display: "block",
              fontSize: T.fz.micro,
              color: "var(--mute)",
              marginTop: 1,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {step.detail}
          </span>
        )}
        {step.ms > 0 && (
          <span
            aria-hidden
            style={{
              position: "relative",
              display: "block",
              height: 3,
              marginTop: 5,
              borderRadius: "999px",
              background: "var(--fill)",
              overflow: "hidden",
            }}
          >
            <span
              style={{
                position: "absolute",
                top: 0,
                bottom: 0,
                left: `${leftPct}%`,
                width: `${widthPct}%`,
                background: dot,
                borderRadius: "999px",
              }}
            />
          </span>
        )}
      </span>

      {/* meta */}
      <span
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "flex-end",
          gap: 2,
          fontFamily: T.font.mono,
          fontSize: T.fz.micro,
          color: "var(--ink-2)",
        }}
      >
        <span>{fmtMs(step.ms)}</span>
        {metaRight(step) && <span style={{ color: "var(--mute)" }}>{metaRight(step)}</span>}
      </span>
    </button>
  );
}

/** A minimal Q&A bubble framing the trace — request at top, answer at the bottom. */
function ChatTurn({
  who,
  text,
  edge,
}: {
  who: "user" | "assistant";
  text: string;
  edge: "top" | "bottom";
}) {
  const mine = who === "user";
  return (
    <div
      style={{
        display: "flex",
        justifyContent: mine ? "flex-end" : "flex-start",
        padding: 12,
        [edge === "top" ? "borderBottom" : "borderTop"]: "1px solid var(--line)",
      }}
    >
      <div
        style={{
          maxWidth: "88%",
          fontSize: T.fz.small,
          lineHeight: 1.5,
          color: mine ? "var(--accent-ink)" : "var(--ink)",
          background: mine ? "var(--accent-soft)" : "var(--fill)",
          border: "1px solid var(--line)",
          borderRadius: T.radius.lg,
          padding: "8px 12px",
          whiteSpace: "pre-wrap",
        }}
      >
        {text}
      </div>
    </div>
  );
}

export function LiveTracePanel({
  steps,
  cursor,
  onSeek,
  request,
  answer,
  layout = "side",
}: {
  steps: TraceStep[];
  cursor: number;
  onSeek: (index: number) => void;
  /** the run's request (user turn) — framed above the trace */
  request?: string;
  /** the run's final answer (agent turn) — framed below the trace */
  answer?: string;
  /** "side" (default) = fixed 372px right rail; "stacked" = full-width block
   *  beneath the graph with a capped, inner-scrolling height. */
  layout?: "side" | "stacked";
}) {
  const stacked = layout === "stacked";
  // shared waterfall timeline: cumulative ms before each step + the run total.
  const totalMs = steps.reduce((m, s) => m + s.ms, 0);
  let acc = 0;
  const startMs = steps.map((s) => {
    const at = acc;
    acc += s.ms;
    return at;
  });

  let lastPhase = "";
  const rows: React.ReactNode[] = [];
  steps.forEach((step, i) => {
    const phase = phaseOf(step);
    if (phase !== lastPhase) {
      lastPhase = phase;
      rows.push(
        <div
          key={`grp-${phase}`}
          style={{
            padding: "12px 12px 4px 12px",
            fontSize: T.fz.micro,
            fontFamily: T.font.mono,
            textTransform: "uppercase",
            letterSpacing: "0.06em",
            color: "var(--mute)",
          }}
        >
          {phase}
        </div>,
      );
    }
    rows.push(
      <TraceRow
        key={step.seq}
        step={step}
        index={i}
        cursor={cursor}
        startMs={startMs[i] ?? 0}
        totalMs={totalMs}
        onSeek={onSeek}
      />,
    );
  });

  return (
    <aside
      data-layout={layout}
      style={{
        width: stacked ? "100%" : TRACE_WIDTH,
        flex: "none",
        maxHeight: stacked ? STACKED_MAX_H : undefined,
        border: "1px solid var(--line)",
        borderRadius: T.radius.lg,
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        background: "var(--paper)",
        overflow: "hidden",
      }}
    >
      <div style={{ flex: 1, overflowY: "auto", minHeight: 0, paddingBottom: 12 }}>
        {request && <ChatTurn who="user" text={request} edge="top" />}
        {steps.length === 0 ? (
          <div style={{ padding: 24, fontSize: T.fz.small, color: "var(--mute)" }}>
            No steps in this run.
          </div>
        ) : (
          rows
        )}
        {/* the answer lands only once the cursor has walked to the end of the
            trace — so the chat doesn't "respond" before the constellation
            finishes animating (live) / before you've scrubbed there (replay). */}
        {answer && steps.length > 0 && cursor >= steps.length - 1 && (
          <ChatTurn who="assistant" text={answer} edge="bottom" />
        )}
      </div>
    </aside>
  );
}

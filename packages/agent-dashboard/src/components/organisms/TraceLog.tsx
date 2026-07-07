/**
 * TraceLog — the same `TraceStep[]` as a compact, terminal-dense, one-line-
 * per-event log with a cumulative time offset from run start.
 *
 * Ported from swe-brain's `AgentDevSurface.tsx` `TraceLog` (port-map §5.2) with
 * the EXACT rendering math preserved: the cumulative-offset fold
 * (`let acc = 0; const at = acc; acc += step.ms;` -> `+${(at/1000).toFixed(2)}s`),
 * the `56px 36px 1fr auto` grid, and the message templates per kind. Only the
 * plumbing changed — see `TraceWaterfall.tsx`'s header comment for the same
 * notes (typed against this repo's `TraceStep`, tokens instead of oklch
 * literals, takes `steps` directly).
 */
import type { ReactNode } from "react";
import type { TraceStep, TraceStepKind } from "../../graph/types";
import { T } from "../../ui/tokens";

const KIND_LABEL: Record<TraceStepKind, string> = {
  context: "CTX",
  model: "LLM",
  tool_call: "CALL",
  tool_result: "RES",
  finish: "END",
};

function logKindStyle(kind: TraceStepKind): { background: string; color: string } {
  switch (kind) {
    case "model":
      return { background: "var(--accent-soft)", color: "var(--accent-ink)" };
    case "finish":
      return { background: "var(--ok-soft)", color: "var(--ok-ink)" };
    default:
      return { background: "var(--fill)", color: "var(--ink-2)" };
  }
}

function logMessage(step: TraceStep): ReactNode {
  if (step.kind === "tool_call") {
    return (
      <>
        → call <b>{step.tool}</b> {JSON.stringify(step.args)}
      </>
    );
  }
  if (step.kind === "tool_result") {
    return (
      <>
        ← <b>{step.tool}</b> returned {step.note} · {step.status}
      </>
    );
  }
  if (step.kind === "model") {
    return (
      <>
        <b>{step.label}</b> · {step.ctxTokens?.toLocaleString()} ctx → {step.outTokens} out
        {step.emits && step.emits.length > 0 ? ` · emits ${step.emits.join(", ")}` : ""}
      </>
    );
  }
  return (
    <>
      {step.label}
      {step.detail ? ` · ${step.detail}` : ""}
    </>
  );
}

export function TraceLog({ steps }: { steps: TraceStep[] }) {
  if (steps.length === 0) {
    return (
      <div style={{ fontSize: T.fz.small, color: "var(--mute)", padding: "12px 4px" }}>
        No steps in this run.
      </div>
    );
  }

  let acc = 0;
  return (
    <div style={{ fontFamily: T.font.mono, fontSize: T.fz.small, lineHeight: 1.85 }}>
      {steps.map((step) => {
        const at = acc;
        acc += step.ms;
        const ks = logKindStyle(step.kind);
        return (
          <div
            key={step.seq}
            data-testid={`log-row-${step.seq}`}
            style={{
              display: "grid",
              gridTemplateColumns: "56px 36px 1fr auto",
              gap: "var(--space-2)",
              padding: "1px 6px",
              borderRadius: T.radius.xs,
              alignItems: "baseline",
            }}
          >
            <span data-testid={`log-offset-${step.seq}`} style={{ color: "var(--mute)" }}>
              +{(at / 1000).toFixed(2)}s
            </span>
            <span
              style={{
                fontSize: "9.5px",
                padding: "0 5px",
                borderRadius: T.radius.xs,
                textTransform: "uppercase",
                letterSpacing: "0.04em",
                background: ks.background,
                color: ks.color,
                textAlign: "center",
              }}
            >
              {KIND_LABEL[step.kind]}
            </span>
            <span style={{ color: "var(--ink-2)", minWidth: 0 }}>{logMessage(step)}</span>
            <span style={{ color: "var(--mute)" }}>{step.ms === 0 ? "" : `${step.ms}ms`}</span>
          </div>
        );
      })}
    </div>
  );
}

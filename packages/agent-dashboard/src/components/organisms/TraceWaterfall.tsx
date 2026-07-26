/**
 * TraceWaterfall — a run's `TraceStep[]` as a vertical timeline: context-compile
 * -> model call -> tool_call -> tool_result -> finish, grouped by iteration, with
 * duration bars + per-step tokens + click-to-expand args/result JSON.
 *
 * Ported from swe-brain's `AgentDevSurface.tsx` `TraceWaterfall` (port-map §5.1)
 * with the EXACT rendering math preserved (row grid, iteration-grouping fold,
 * bar-width formula, expand-state semantics) — only the plumbing changed:
 *   - typed against this repo's `TraceStep` (`graph/types.ts`) instead of
 *     swe-brain's local sample-run-trace types (the field names already match
 *     1:1 — no adapter needed).
 *   - takes `steps: TraceStep[]` directly rather than a `{ trace: RunTrace }`
 *     wrapper — both call sites (Console trace rail, Agent Lens Runs lens)
 *     already own a `RunTrace`-shaped header of their own, so the organism
 *     doesn't need the envelope.
 *   - blast ink + the tool_result bar fill read this app's own tokens
 *     (`--blast-*`, `--category-3`) instead of swe-brain's hard-coded oklch
 *     literals — this app already has those tokens (S2); using them is
 *     strictly better than re-hard-coding the same colors.
 *   - expand JSON renders through the shared kit `JsonBlock` (styled to match
 *     swe-brain's `DevJson` look) instead of a bespoke `<pre>`.
 *   - default expand state is the empty set (all collapsed) — swe-brain's
 *     `new Set([3, 4])` default was a demo-fixture quirk, not a real default.
 *
 * Shared by the Console's collapsible trace rail (ChatPage) and the Agent
 * Lens's Runs lens (AgentLensPage) — see port-map §4.2.3 / §5.
 */
import { useState } from "react";
import type { TraceStep, TraceStepKind } from "../../graph/types";
import { T } from "../../ui/tokens";
import { JsonBlock } from "../kit/JsonBlock";

const KIND_LABEL: Record<TraceStepKind, string> = {
  context: "CTX",
  model: "LLM",
  tool_call: "CALL",
  tool_result: "RES",
  finish: "END",
};
const TILE_GLYPH: Record<TraceStepKind, string> = {
  context: "⚙",
  model: "◆",
  tool_call: "→",
  tool_result: "←",
  finish: "✓",
};
/** read/write/external ink — the app's own blast tokens (tokens-base.css), not
 *  swe-brain's hard-coded oklch triples. */
const BLAST_INK: Record<"read" | "write" | "external", string> = {
  read: "var(--blast-read)",
  write: "var(--blast-write)",
  external: "var(--blast-external)",
};

function tileStyle(kind: TraceStepKind): {
  background: string;
  color: string;
  borderColor: string;
} {
  switch (kind) {
    case "model":
      return {
        background: "var(--accent-soft)",
        color: "var(--accent-ink)",
        borderColor: "var(--accent)",
      };
    case "finish":
      return {
        background: "var(--ok-soft)",
        color: "var(--ok-ink)",
        borderColor: "var(--ok)",
      };
    case "context":
      return { background: "var(--fill)", color: "var(--mute)", borderColor: "var(--line)" };
    default:
      return { background: "var(--paper)", color: "var(--ink-2)", borderColor: "var(--line)" };
  }
}

/** Bar fill by kind (port-map §5.1: model = accent-tinted, tool_result = the
 *  `--category-3` ("emit") slot — not a hard-coded oklch literal — else `--mute`. */
function barFill(kind: TraceStepKind): string {
  if (kind === "model") return "color-mix(in oklch, var(--accent) 55%, var(--paper))";
  if (kind === "tool_result") return "var(--category-3)";
  return "var(--mute)";
}

/** Row indent for the meta/detail/expander lines under the row-1 tile+label —
 *  22px tile + 8px gap, so text lines up under the label rather than the tile. */
const NARROW_INDENT = 30;

/**
 * #388 — minimal cache/reasoning breakdown chip: `12,400 ctx (11,900 cached) ·
 * 320 out (140 rsn)`. Byte-identical to the pre-#388 string when
 * `tokenDetails` is absent — parentheticals appear only for defined members
 * (absent ≠ zero; no `(0 cached)` for a step that simply didn't report it).
 */
function formatTokenChip(step: TraceStep): string {
  const ctxPart = step.ctxTokens
    ? `${step.ctxTokens.toLocaleString()}${step.tokenDetails?.cacheRead !== undefined ? ` (${step.tokenDetails.cacheRead.toLocaleString()} cached)` : ""} ctx · `
    : "";
  const outPart = `${step.outTokens}${step.tokenDetails?.reasoning !== undefined ? ` (${step.tokenDetails.reasoning.toLocaleString()} rsn)` : ""} out`;
  return `${ctxPart}${outPart}`;
}

/**
 * `layout="narrow"` step row — spec's "Narrow step anatomy": stacked full-width
 * rows (header · meta · detail · bar) instead of the wide 4-column grid. Same
 * `toggle`/`open` state, same `barFill`/`maxMs` math, same test hooks — only
 * the arrangement changes.
 */
function NarrowStepRow({
  step,
  tile,
  hasJson,
  isOpen,
  maxMs,
  toggle,
}: {
  step: TraceStep;
  tile: { background: string; color: string; borderColor: string };
  hasJson: boolean;
  isOpen: boolean;
  maxMs: number;
  toggle: (seq: number) => void;
}) {
  const isToolish = step.kind === "tool_call" || step.kind === "tool_result";

  // Row 2 (meta): KIND · blast · model tokens · tool capability · result note —
  // whichever apply, joined with " · " and ellipsized as one line. Keyed by a
  // descriptive slot name (not array index) since the parts are conditional.
  const metaNodes: { key: string; node: React.ReactNode }[] = [
    { key: "kind", node: KIND_LABEL[step.kind] },
  ];
  if (step.blast) {
    metaNodes.push({
      key: "blast",
      node: <span style={{ color: BLAST_INK[step.blast] }}>● {step.blast}</span>,
    });
  }
  if (step.kind === "model" && step.outTokens != null) {
    metaNodes.push({ key: "tokens", node: formatTokenChip(step) });
  }
  if (step.kind === "tool_call" && step.capability) {
    metaNodes.push({ key: "capability", node: `via ${step.capability}` });
  }
  if (step.kind === "tool_result" && step.note) {
    metaNodes.push({ key: "note", node: step.note });
  }

  // Row-wide click-to-toggle (the wide layout's convenience) is deliberately
  // NOT reused here — the explicit ▸ button below is the sole toggle
  // affordance in narrow, so the row itself needs no onClick/keyboard pairing.
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 3,
        padding: "7px 4px",
        borderRadius: T.radius.sm,
      }}
    >
      {/* row 1: tile · label (flex, ellipsizes) · duration (right-aligned, tool_result gets an "ok · "/"error · " prefix here — no room to spare in row 3 at 320px). */}
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span
          style={{
            flex: "none",
            width: 22,
            height: 22,
            borderRadius: T.radius.sm,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            fontFamily: T.font.mono,
            fontSize: T.fz.micro,
            fontWeight: 600,
            border: `1px solid ${tile.borderColor}`,
            background: tile.background,
            color: tile.color,
          }}
        >
          {TILE_GLYPH[step.kind]}
        </span>
        <span
          style={{
            flex: 1,
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            fontSize: T.fz.small,
            fontWeight: isToolish ? 600 : 500,
            fontFamily: isToolish ? T.font.mono : undefined,
          }}
        >
          {isToolish ? step.tool : step.label}
        </span>
        <span
          style={{
            flex: "none",
            fontFamily: T.font.mono,
            fontSize: T.fz.small,
            fontWeight: 600,
            whiteSpace: "nowrap",
          }}
        >
          {step.kind === "tool_result" && step.status && (
            // ok green, error/rejected red (`--err`, TraceRail's own error ink) —
            // the failure case is the one a glanceable rail most needs to flag.
            <span style={{ color: step.status === "ok" ? "var(--ok-ink)" : "var(--err)" }}>
              {step.status} ·{" "}
            </span>
          )}
          {step.ms === 0 ? "—" : `${step.ms}ms`}
        </span>
      </div>

      {/* row 2: meta line */}
      <div
        style={{
          fontFamily: T.font.mono,
          fontSize: T.fz.micro,
          color: "var(--mute)",
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
          paddingLeft: NARROW_INDENT,
        }}
      >
        {metaNodes.map((m, i) => (
          <span key={m.key}>
            {i > 0 && " · "}
            {m.node}
          </span>
        ))}
      </div>

      {/* row 3: detail sentence (context/model/finish/rejected only — tool_call's
       *  redundant "calls <tool>" prose is dropped, the header IS the tool name) */}
      {step.detail && (
        <div
          style={{
            fontSize: T.fz.small,
            color: "var(--ink-2)",
            lineHeight: 1.45,
            paddingLeft: NARROW_INDENT,
          }}
        >
          {step.detail}
        </div>
      )}

      {hasJson && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            toggle(step.seq);
          }}
          style={{
            appearance: "none",
            background: "none",
            border: "none",
            padding: 0,
            paddingLeft: NARROW_INDENT,
            fontFamily: T.font.mono,
            fontSize: T.fz.micro,
            color: "var(--mute)",
            cursor: "pointer",
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
            alignSelf: "flex-start",
          }}
        >
          {isOpen ? "▾" : "▸"} {step.args !== undefined ? "args" : "result"}
        </button>
      )}
      {hasJson && isOpen && (
        <JsonBlock
          value={step.args !== undefined ? step.args : step.output}
          style={{
            marginLeft: NARROW_INDENT,
            background: "color-mix(in oklch, var(--fill) 55%, var(--paper))",
            padding: "9px 11px",
            fontSize: T.fz.tiny,
            lineHeight: 1.55,
          }}
        />
      )}

      {/* row 4: duration bar, full row width (not indented — spans edge to edge) */}
      <div
        style={{
          height: 6,
          borderRadius: 4,
          background: "var(--fill)",
          marginTop: 2,
          position: "relative",
          overflow: "hidden",
        }}
      >
        <div
          data-testid={`waterfall-bar-${step.seq}`}
          style={{
            position: "absolute",
            top: 0,
            bottom: 0,
            left: 0,
            width: `${Math.max(3, (step.ms / maxMs) * 100)}%`,
            borderRadius: 4,
            background: barFill(step.kind),
          }}
        />
      </div>
    </div>
  );
}

export function TraceWaterfall({
  steps,
  layout = "wide",
}: {
  steps: TraceStep[];
  /** `"wide"` (default) — today's 4-column grid, byte-for-byte unchanged (Agent
   *  Lens Runs lens). `"narrow"` — stacked full-width rows for the fixed-320px
   *  chat trace rail (`.ai-docs/specs/trace-rail-narrow-waterfall.md`): kind
   *  tile + label + duration on row 1, a meta line, the detail sentence, then
   *  a full-width duration bar. */
  layout?: "wide" | "narrow";
}) {
  const [open, setOpen] = useState<Set<number>>(() => new Set());
  const maxMs = Math.max(...steps.map((s) => s.ms)) || 1;
  const toggle = (seq: number) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(seq)) next.delete(seq);
      else next.add(seq);
      return next;
    });

  if (steps.length === 0) {
    return (
      <div style={{ fontSize: T.fz.small, color: "var(--mute)", padding: "12px 4px" }}>
        No steps in this run.
      </div>
    );
  }

  let lastIter: number | null = null;
  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      {steps.map((step) => {
        const showIter = step.iter !== lastIter;
        lastIter = step.iter;
        const hasJson = step.args !== undefined || step.output !== undefined;
        const isOpen = open.has(step.seq);
        const tile = tileStyle(step.kind);
        return (
          <div key={step.seq} data-testid={`waterfall-step-${step.seq}`}>
            {showIter && (
              <div
                data-testid={`waterfall-iter-header-${step.seq}`}
                style={{
                  fontFamily: T.font.mono,
                  fontSize: T.fz.micro,
                  textTransform: "uppercase",
                  letterSpacing: "0.08em",
                  color: "var(--mute)",
                  padding: "10px 4px 6px",
                  borderTop: step.seq === 1 ? "none" : "1px dashed var(--line-2)",
                  marginTop: step.seq === 1 ? 0 : 4,
                }}
              >
                {step.iter === 0 ? "setup" : `iteration ${step.iter}`}
              </div>
            )}
            {layout === "narrow" ? (
              <NarrowStepRow
                step={step}
                tile={tile}
                hasJson={hasJson}
                isOpen={isOpen}
                maxMs={maxMs}
                toggle={toggle}
              />
            ) : (
              // biome-ignore lint/a11y/useKeyWithClickEvents: row toggle has an explicit button affordance below; the row click is a non-essential convenience
              <div
                onClick={hasJson ? () => toggle(step.seq) : undefined}
                style={{
                  display: "grid",
                  gridTemplateColumns: "30px 150px 1fr 116px",
                  gap: "var(--space-3)",
                  alignItems: "start",
                  padding: "7px 4px",
                  borderRadius: T.radius.sm,
                  cursor: hasJson ? "pointer" : "default",
                }}
              >
                <div
                  style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 3 }}
                >
                  <span
                    style={{
                      width: 22,
                      height: 22,
                      borderRadius: T.radius.sm,
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontFamily: T.font.mono,
                      fontSize: T.fz.micro,
                      fontWeight: 600,
                      border: `1px solid ${tile.borderColor}`,
                      background: tile.background,
                      color: tile.color,
                    }}
                  >
                    {TILE_GLYPH[step.kind]}
                  </span>
                  <span style={{ fontFamily: T.font.mono, fontSize: "9px", color: "var(--mute)" }}>
                    {String(step.seq).padStart(2, "0")}
                  </span>
                </div>

                <div style={{ paddingTop: 2 }}>
                  <div style={{ fontSize: T.fz.small, fontWeight: 500 }}>
                    {step.kind === "tool_call" || step.kind === "tool_result" ? (
                      <span style={{ fontFamily: T.font.mono, fontWeight: 600 }}>{step.tool}</span>
                    ) : (
                      step.label
                    )}
                  </div>
                  <div
                    style={{
                      fontFamily: T.font.mono,
                      fontSize: T.fz.micro,
                      color: "var(--mute)",
                      marginTop: 2,
                    }}
                  >
                    {KIND_LABEL[step.kind]}
                    {step.blast && (
                      <>
                        {" · "}
                        <span style={{ color: BLAST_INK[step.blast] }}>● {step.blast}</span>
                      </>
                    )}
                  </div>
                </div>

                <div style={{ minWidth: 0, paddingTop: 1 }}>
                  {(step.kind === "tool_call" || step.kind === "tool_result") && (
                    <div style={{ fontSize: T.fz.small, color: "var(--ink-2)", lineHeight: 1.45 }}>
                      {step.kind === "tool_call" ? (
                        <>
                          calls <span style={{ fontFamily: T.font.mono }}>{step.tool}</span>
                          {step.capability && (
                            <>
                              {" "}
                              via <span style={{ fontFamily: T.font.mono }}>{step.capability}</span>
                            </>
                          )}
                        </>
                      ) : (
                        <>
                          {step.note} · status <b>{step.status}</b>
                        </>
                      )}
                    </div>
                  )}
                  {step.detail && (
                    <div style={{ fontSize: T.fz.small, color: "var(--ink-2)", lineHeight: 1.45 }}>
                      {step.detail}
                    </div>
                  )}
                  <div
                    style={{
                      height: 7,
                      borderRadius: 4,
                      background: "var(--fill)",
                      marginTop: 7,
                      position: "relative",
                      overflow: "hidden",
                    }}
                  >
                    <div
                      data-testid={`waterfall-bar-${step.seq}`}
                      style={{
                        position: "absolute",
                        top: 0,
                        bottom: 0,
                        left: 0,
                        width: `${Math.max(3, (step.ms / maxMs) * 100)}%`,
                        borderRadius: 4,
                        background: barFill(step.kind),
                      }}
                    />
                  </div>
                  {hasJson && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        toggle(step.seq);
                      }}
                      style={{
                        appearance: "none",
                        background: "none",
                        border: "none",
                        padding: "4px 0 0",
                        fontFamily: T.font.mono,
                        fontSize: T.fz.micro,
                        color: "var(--mute)",
                        cursor: "pointer",
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 5,
                      }}
                    >
                      {isOpen ? "▾" : "▸"} {step.args !== undefined ? "args" : "result"}
                      {step.kind === "tool_result" && step.note ? ` (${step.note})` : ""}
                    </button>
                  )}
                  {hasJson && isOpen && (
                    <JsonBlock
                      value={step.args !== undefined ? step.args : step.output}
                      style={{
                        marginTop: 7,
                        background: "color-mix(in oklch, var(--fill) 55%, var(--paper))",
                        padding: "9px 11px",
                        fontSize: T.fz.tiny,
                        lineHeight: 1.55,
                      }}
                    />
                  )}
                </div>

                <div
                  style={{
                    textAlign: "right",
                    paddingTop: 2,
                    display: "flex",
                    flexDirection: "column",
                    gap: 3,
                    alignItems: "flex-end",
                  }}
                >
                  <span style={{ fontFamily: T.font.mono, fontSize: T.fz.small, fontWeight: 600 }}>
                    {step.ms === 0 ? "—" : `${step.ms}ms`}
                  </span>
                  {step.outTokens != null && (
                    <span
                      style={{
                        fontFamily: T.font.mono,
                        fontSize: T.fz.micro,
                        color: "var(--mute)",
                      }}
                    >
                      {formatTokenChip(step)}
                    </span>
                  )}
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

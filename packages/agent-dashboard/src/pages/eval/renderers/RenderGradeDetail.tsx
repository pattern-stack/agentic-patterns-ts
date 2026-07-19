/**
 * `kind: "render-grade"` — the Dealbrain answer-renderer's deterministic gate
 * report (`RenderGradeReport`). Six fidelity gates (invented/dropped ids,
 * invented dates/money, coverage honesty, table integrity) as pass/fail chips,
 * plus a relative-length readout (a report axis, not a gate). Failing gates
 * surface their offending tokens inline.
 *
 * Payload: `{ kind: "render-grade", report: RenderGradeReport }`. Any shape
 * mismatch returns `null` so `ScoreRow` falls back to the raw-JSON expander.
 */

import type { ReactNode } from "react";
import { Badge } from "../../../components/atoms/Badge";
import type { DetailRenderer } from "./types";

interface GatePass {
  pass: boolean;
}
interface CoverageHonesty {
  status: "not_declared" | "honest" | "dishonest";
  pass: boolean;
  actualCarried?: number;
  actualTotal?: number;
}
interface RelativeLength {
  stateWords?: number;
  renderedWords?: number;
  ratio: number | null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}
function gate(v: unknown): (GatePass & Record<string, unknown>) | null {
  return isRecord(v) && typeof v.pass === "boolean"
    ? (v as GatePass & Record<string, unknown>)
    : null;
}
function strList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

const chipRow = { display: "flex", flexWrap: "wrap" as const, gap: 6, alignItems: "center" };
const detailLine = {
  fontSize: 12,
  color: "var(--fg-muted)",
  fontFamily: "var(--font-mono)",
  wordBreak: "break-word" as const,
};

/** One gate → a tone-coded chip. Optional trailing detail (offending tokens). */
function GateChip({
  label,
  pass,
  note,
}: {
  label: string;
  pass: boolean;
  note?: string;
}) {
  return (
    <Badge tone={pass ? "green" : "red"} title={note}>
      {label} {pass ? "✓" : "✕"}
      {note ? ` · ${note}` : ""}
    </Badge>
  );
}

export const RenderGradeDetail: DetailRenderer = ({ detail }) => {
  const report = (detail as { report?: unknown }).report;
  if (!isRecord(report)) return null;

  const chips: ReactNode[] = [];
  const push = (key: string, label: string, noteFrom?: (g: Record<string, unknown>) => string) => {
    const g = gate(report[key]);
    if (!g) return;
    chips.push(
      <GateChip
        key={key}
        label={label}
        pass={g.pass}
        note={noteFrom && !g.pass ? noteFrom(g) : undefined}
      />,
    );
  };

  push("inventedIds", "invented ids", (g) => {
    const ids = strList(g.inventedIds);
    return ids.length
      ? `${ids.length}: ${ids.slice(0, 3).join(", ")}${ids.length > 3 ? "…" : ""}`
      : "";
  });
  push("droppedIds", "dropped ids", (g) => {
    const ids = strList(g.droppedIds);
    const ratio = typeof g.dropRatio === "number" ? ` (${Math.round(g.dropRatio * 100)}%)` : "";
    return ids.length ? `${ids.length}${ratio}` : "";
  });
  push("inventedDates", "invented dates", (g) => strList(g.invented).slice(0, 3).join(", "));
  push("inventedMoney", "invented money", (g) => strList(g.invented).slice(0, 3).join(", "));

  // coverageHonesty is a status gate, not a plain pass gate.
  const cov = report.coverageHonesty;
  if (isRecord(cov) && typeof cov.pass === "boolean") {
    const c = cov as unknown as CoverageHonesty;
    const carried = typeof c.actualCarried === "number" ? c.actualCarried : "?";
    const total = typeof c.actualTotal === "number" ? c.actualTotal : "?";
    const note = c.status === "not_declared" ? "not declared" : `${carried}/${total}`;
    chips.push(<GateChip key="coverageHonesty" label="coverage" pass={c.pass} note={note} />);
  }

  push("tableIntegrity", "table", (g) => {
    const stray = strList(g.strayPipeLines).length;
    const unbal = strList(g.unbalancedRowLines).length;
    const parts = [stray ? `${stray} stray` : "", unbal ? `${unbal} unbalanced` : ""].filter(
      Boolean,
    );
    return parts.join(", ");
  });

  if (chips.length === 0) return null;

  // relativeLength: report axis (not a gate) — a plain readout.
  const rl = report.relativeLength;
  let lengthNote: string | null = null;
  if (isRecord(rl)) {
    const r = rl as unknown as RelativeLength;
    if (typeof r.ratio === "number") {
      const words =
        typeof r.renderedWords === "number" && typeof r.stateWords === "number"
          ? ` (${r.renderedWords}w vs ${r.stateWords}w)`
          : "";
      lengthNote = `length ratio ${r.ratio.toFixed(2)}×${words}`;
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 2 }}>
      <div style={chipRow}>{chips}</div>
      {lengthNote && <div style={detailLine}>{lengthNote}</div>}
    </div>
  );
};

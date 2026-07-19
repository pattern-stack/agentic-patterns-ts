/**
 * Small shared helpers for detail renderers: defensive parsing guards + a
 * threshold-colored meter bar (0..1 → green/yellow/red, matching the Dealbrain
 * viewer's ≥0.8 good / ≥0.5 warn / else crit scale).
 */

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

export function numOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export function strList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/** Threshold color for a 0..1 score, as a CSS var. Null/undefined = muted. */
export function scoreColorVar(v: number | null): string {
  if (v === null) return "var(--fg-muted)";
  if (v >= 0.8) return "var(--green)";
  if (v >= 0.5) return "var(--yellow)";
  return "var(--red)";
}

const trackStyle = {
  position: "relative" as const,
  height: 6,
  borderRadius: 3,
  background: "var(--bg-surface-hover)",
  overflow: "hidden" as const,
};

/** A 0..1 value as a threshold-colored horizontal meter. */
export function MeterBar({ value }: { value: number | null }) {
  const pct = value === null ? 0 : Math.max(0, Math.min(100, value * 100));
  return (
    <div style={trackStyle}>
      <span
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          bottom: 0,
          width: `${pct}%`,
          background: scoreColorVar(value),
        }}
      />
    </div>
  );
}

export const rendererSectionStyle = {
  display: "flex",
  flexDirection: "column" as const,
  gap: 8,
  marginTop: 2,
};

export const rendererHeadingStyle = {
  fontSize: 11,
  fontWeight: 600,
  textTransform: "uppercase" as const,
  letterSpacing: "0.04em",
  color: "var(--fg-subtle)",
};

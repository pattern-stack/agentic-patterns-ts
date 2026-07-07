/**
 * SectionHeading — ported from swe-brain's `SectionHeader` idiom (port-map
 * §7.2): uppercase tiny eyebrow, 0.08em tracking, border-bottom, optional
 * right-aligned mono rollup. Replaces the `sectionHeadingStyle` const
 * hand-copied across EvalComparePage / EvalCaseDetailPage / CaseDetail.tsx.
 */
import type { ReactNode } from "react";
import { T } from "../../ui/tokens";

export function SectionHeading({
  eyebrow,
  blurb,
  rollup,
}: {
  eyebrow: string;
  blurb?: string;
  rollup?: ReactNode;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "baseline",
        justifyContent: "space-between",
        gap: 12,
        padding: "0 0 8px",
        borderBottom: "1px solid var(--line)",
        marginBottom: 12,
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 12, minWidth: 0 }}>
        <span
          style={{
            fontFamily: T.font.sans,
            fontSize: T.fz.tiny,
            fontWeight: 600,
            textTransform: "uppercase",
            letterSpacing: "0.08em",
            color: "var(--mute)",
            whiteSpace: "nowrap",
          }}
        >
          {eyebrow}
        </span>
        {blurb && (
          <span
            style={{
              fontSize: T.fz.small,
              color: "var(--mute)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {blurb}
          </span>
        )}
      </div>
      {rollup && (
        <span
          style={{
            fontFamily: T.font.mono,
            fontSize: T.fz.micro,
            color: "var(--mute)",
            whiteSpace: "nowrap",
          }}
        >
          {rollup}
        </span>
      )}
    </div>
  );
}

/** Micro heading used inline above a value (the `sectionHeadingStyle` const, standalone). */
export function sectionMicroHeadingStyle() {
  return {
    fontSize: T.fz.tiny,
    fontWeight: 600,
    textTransform: "uppercase" as const,
    letterSpacing: "0.05em",
    color: "var(--mute)",
    marginBottom: 8,
  };
}

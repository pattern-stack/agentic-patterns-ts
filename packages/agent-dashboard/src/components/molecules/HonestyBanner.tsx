/**
 * HonestyBanner — the standard "this is a fixture / degraded, not live data"
 * band (port-map §6, mechanism 1: "fixture-until-live"). Ported from
 * swe-brain's `AgentDevSurface.tsx` `SampleBanner`, generalized: swe-brain's
 * version hard-coded the run/trace-domain-pending copy; this one takes the
 * message as `children` so every honest-degradation call site (Agent Lens
 * Runs lens with no persisted runs yet, and any future one) can state its own
 * reason without re-hand-rolling the warn-soft band.
 */
import type { ReactNode } from "react";
import { T } from "../../ui/tokens";
import { Chip } from "../atoms/Chip";

export function HonestyBanner({
  children,
  label = "sample",
}: {
  children: ReactNode;
  /** The chip's word — "sample" (fixture data) by default; pass e.g. "unknown" for other degradations. */
  label?: string;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--space-2)",
        flexWrap: "wrap",
        border: "1px solid color-mix(in oklch, var(--warn) 30%, var(--line))",
        background: "var(--warn-soft)",
        color: "var(--warn-ink)",
        borderRadius: T.radius.md,
        padding: "var(--space-2) var(--space-3)",
        fontSize: T.fz.small,
      }}
    >
      <Chip tone="warn" title={label}>
        {label}
      </Chip>
      <span>{children}</span>
    </div>
  );
}

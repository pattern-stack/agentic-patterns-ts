/**
 * Segmented — ported from swe-brain's `Segmented` atom (port-map §7.2),
 * trimmed to the `track` variant (the only one any current caller needs).
 * Replaces 4 hand-rolled segmented controls that had converged on the exact
 * same CSS by hand: RunSurfacePage's Chain/Composition `ModeToggle`,
 * AgentLensPage's declared/delivered `ModeChip`, NodeInspector's four-tab
 * strip, and TokensPage's by-agent/by-model toggle.
 */
import type { ReactNode } from "react";
import { T } from "../../ui/tokens";

export interface SegmentedOption<V extends string> {
  value: V;
  label: ReactNode;
  /** Native tooltip for this segment (e.g. explaining what it switches to). */
  title?: string;
}

export interface SegmentedProps<V extends string> {
  options: SegmentedOption<V>[];
  value: V;
  onChange: (value: V) => void;
  size?: "sm" | "md";
  /** Stretch to the parent's width with equal-width segments (NodeInspector's
   *  tab strip); default is content-sized (RunSurfacePage's Chain/Composition
   *  toggle, TokensPage's group-by toggle). */
  fullWidth?: boolean;
  "aria-label"?: string;
}

export function Segmented<V extends string>({
  options,
  value,
  onChange,
  size = "md",
  fullWidth = false,
  "aria-label": ariaLabel,
}: SegmentedProps<V>) {
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      style={{
        display: fullWidth ? "flex" : "inline-flex",
        gap: 3,
        background: "var(--fill)",
        padding: 3,
        borderRadius: T.radius.md,
      }}
    >
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            role="tab"
            aria-selected={active}
            title={opt.title}
            onClick={() => onChange(opt.value)}
            style={{
              flex: fullWidth ? 1 : undefined,
              border: "none",
              cursor: "pointer",
              fontFamily: "inherit",
              fontSize: size === "sm" ? T.fz.micro : T.fz.small,
              fontWeight: active ? 600 : 500,
              padding: size === "sm" ? "5px 10px" : "6px 14px",
              borderRadius: T.radius.sm,
              background: active ? "var(--paper)" : "transparent",
              color: active ? "var(--ink)" : "var(--mute)",
              boxShadow: active ? T.shadow.s1 : "none",
            }}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Badge atom — small label pill. Mirrors chat-patterns' Badge variants
 * (outline vs filled) with a tone mapped onto our semantic tokens.
 */

import type { CSSProperties, ReactNode } from "react";

export type BadgeTone =
  | "neutral"
  | "accent"
  | "green"
  | "red"
  | "yellow"
  | "purple"
  | "emerald"
  | "muted";

export type BadgeVariant = "outline" | "filled";

interface BadgeProps {
  children: ReactNode;
  tone?: BadgeTone;
  variant?: BadgeVariant;
  title?: string;
  style?: CSSProperties;
}

const TONE_COLORS: Record<BadgeTone, { fg: string; bg: string; border: string }> = {
  neutral: { fg: "var(--fg-muted)", bg: "var(--bg-surface-hover)", border: "var(--border)" },
  accent: { fg: "var(--accent)", bg: "rgba(88, 166, 255, 0.12)", border: "var(--accent)" },
  green: { fg: "var(--green)", bg: "rgba(63, 185, 80, 0.12)", border: "var(--green)" },
  red: { fg: "var(--red)", bg: "rgba(248, 81, 73, 0.12)", border: "var(--red)" },
  yellow: { fg: "var(--yellow)", bg: "rgba(210, 153, 34, 0.12)", border: "var(--yellow)" },
  purple: { fg: "var(--purple)", bg: "rgba(188, 140, 255, 0.12)", border: "var(--purple)" },
  emerald: {
    fg: "var(--accent-emerald)",
    bg: "var(--accent-emerald-dim)",
    border: "var(--accent-emerald)",
  },
  muted: { fg: "var(--fg-subtle)", bg: "transparent", border: "var(--border-muted)" },
};

export function Badge({
  children,
  tone = "neutral",
  variant = "outline",
  title,
  style,
}: BadgeProps) {
  const c = TONE_COLORS[tone];
  const visual: CSSProperties =
    variant === "filled"
      ? { background: c.fg, color: "#0d1117", border: `1px solid ${c.fg}` }
      : { background: c.bg, color: c.fg, border: `1px solid ${c.border}` };

  return (
    <span
      title={title}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        padding: "2px 8px",
        fontSize: 11,
        fontFamily: "var(--font-mono)",
        borderRadius: 999,
        lineHeight: 1.4,
        whiteSpace: "nowrap",
        ...visual,
        ...style,
      }}
    >
      {children}
    </span>
  );
}

/**
 * Badge atom — small label pill, rewritten on cockpit tokens (port-map §7.1).
 *
 * `Tone` is the cockpit's one semantic set (ok/err/warn/accent/mute/run/violet
 * — the same vocabulary `components/kit`, `Chip`, and `Stat` speak). The
 * pre-cockpit admin-surface tone names (`green`/`red`/`yellow`/`purple`/
 * `emerald`/`neutral`/`muted`) and their `LEGACY_TONE_MAP` resolver were swept
 * off every call site and deleted in S8 (port-map §7.1 migration table) —
 * `BadgeTone` is just `Tone` now.
 */

import type { CSSProperties, ReactNode } from "react";
import { T } from "../../ui/tokens";

export type Tone = "ok" | "err" | "warn" | "accent" | "mute" | "run" | "violet";
export type BadgeTone = Tone;
export type BadgeVariant = "outline" | "filled";

/** Soft tinted background per tone — the outline/default Badge look. */
const TONE_SOFT_BG: Record<Tone, string> = {
  ok: "var(--ok-soft)",
  err: "var(--err-soft)",
  warn: "var(--warn-soft)",
  accent: "var(--accent-soft)",
  mute: "var(--fill)",
  run: "color-mix(in oklch, var(--accent) 18%, var(--paper))",
  violet: "var(--violet-soft)",
};
const TONE_INK: Record<Tone, string> = {
  ok: "var(--ok-ink)",
  err: "var(--err-ink)",
  warn: "var(--warn-ink)",
  accent: "var(--accent-ink)",
  mute: "var(--ink-2)",
  run: "var(--accent-ink)",
  violet: "var(--violet-ink)",
};
/** Saturated solid color per tone — the `filled` Badge look (paired with `--paper` text). */
export const TONE_SOLID: Record<Tone, string> = {
  ok: "var(--ok)",
  err: "var(--err)",
  warn: "var(--warn)",
  accent: "var(--accent)",
  mute: "var(--mute)",
  run: "var(--accent)",
  violet: "var(--violet)",
};

interface BadgeProps {
  children: ReactNode;
  tone?: BadgeTone;
  variant?: BadgeVariant;
  /** Mono (tabular) label — run ids, counts, tool names. */
  mono?: boolean;
  title?: string;
  style?: CSSProperties;
}

export function Badge({
  children,
  tone = "mute",
  variant = "outline",
  mono,
  title,
  style,
}: BadgeProps) {
  const visual: CSSProperties =
    variant === "filled"
      ? { background: TONE_SOLID[tone], color: "var(--paper)" }
      : { background: TONE_SOFT_BG[tone], color: TONE_INK[tone] };

  return (
    <span
      title={title}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        padding: "2px 8px",
        fontSize: T.fz.tiny,
        fontWeight: 600,
        borderRadius: T.radius.pill,
        lineHeight: 1.4,
        fontFamily: mono ? T.font.mono : T.font.sans,
        whiteSpace: "nowrap",
        ...visual,
        ...style,
      }}
    >
      {children}
    </span>
  );
}

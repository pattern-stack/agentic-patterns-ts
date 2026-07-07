/**
 * Badge atom — small label pill, rewritten on cockpit tokens (port-map §7.1).
 *
 * Two tone vocabularies live here on purpose: `Tone` is the cockpit's semantic
 * set (ok/err/warn/accent/mute/run/violet — the same one `components/kit`,
 * `Chip`, and `Stat` speak), `LegacyTone` is the pre-cockpit admin-surface
 * names still passed at ~30 call sites. `LEGACY_TONE_MAP` resolves the latter
 * onto the former so every existing caller keeps working unchanged; sweep the
 * legacy names at call sites in S8 (see port-map §7.1 migration table), then
 * delete the alias map.
 */

import type { CSSProperties, ReactNode } from "react";
import { T } from "../../ui/tokens";

export type Tone = "ok" | "err" | "warn" | "accent" | "mute" | "run" | "violet";
/** @deprecated legacy admin-surface tone names — mapped onto {@link Tone}. */
export type LegacyTone = "neutral" | "green" | "red" | "yellow" | "purple" | "emerald" | "muted";
export type BadgeTone = Tone | LegacyTone;
export type BadgeVariant = "outline" | "filled";

const LEGACY_TONE_MAP: Record<LegacyTone, Tone> = {
  neutral: "mute",
  muted: "mute",
  green: "ok",
  emerald: "ok",
  red: "err",
  yellow: "warn",
  purple: "violet",
};

export function resolveTone(tone: BadgeTone): Tone {
  return tone in LEGACY_TONE_MAP ? LEGACY_TONE_MAP[tone as LegacyTone] : (tone as Tone);
}

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
  const resolved = resolveTone(tone);
  const visual: CSSProperties =
    variant === "filled"
      ? { background: TONE_SOLID[resolved], color: "var(--paper)" }
      : { background: TONE_SOFT_BG[resolved], color: TONE_INK[resolved] };

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

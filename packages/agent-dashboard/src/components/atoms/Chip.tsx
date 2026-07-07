/**
 * Chip atom — small inline tag, rewritten on cockpit tokens (port-map §7.1).
 * Same tone vocabulary and visuals as before; the underlying CSS vars are now
 * the cockpit's native names (`--ink-2`, `--fill`, `--line`, `--accent-soft`,
 * `--err-soft`) instead of the admin bridge's muted-text/inset-surface/border
 * aliases it read through previously — same resolved colors today, no
 * dependency on the bridge now that it's deleted (S8).
 */
import type { CSSProperties, ReactNode } from "react";

export type ChipTone = "neutral" | "accent" | "mono" | "warn";

const TONES: Record<ChipTone, CSSProperties> = {
  neutral: {
    color: "var(--ink-2)",
    background: "var(--fill)",
    borderColor: "var(--line)",
  },
  accent: {
    color: "var(--accent-ink)",
    background: "var(--accent-soft)",
    borderColor: "var(--accent)",
  },
  mono: {
    color: "var(--ink-2)",
    background: "var(--fill)",
    borderColor: "var(--line)",
    fontFamily: "var(--font-mono)",
  },
  warn: {
    color: "var(--err-ink)",
    background: "var(--err-soft)",
    borderColor: "var(--err)",
  },
};

/** Small inline tag — provenance chips, tiers, model ids, counts. */
export function Chip({
  children,
  tone = "neutral",
  title,
  style,
}: {
  children: ReactNode;
  tone?: ChipTone;
  title?: string;
  style?: CSSProperties;
}) {
  return (
    <span
      title={title}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        padding: "1px 7px",
        borderRadius: "var(--radius-sm)",
        fontSize: "var(--fz-tiny)",
        lineHeight: 1.5,
        border: "1px solid",
        whiteSpace: "nowrap",
        ...TONES[tone],
        ...style,
      }}
    >
      {children}
    </span>
  );
}

/**
 * Provenance chip — the collision-catcher's core signal (docs §5). Maps each
 * tier to a tone + glyph so an agent's slot origins read at a glance:
 *   preset (framework) · library (context) · local (agent) · inline · preset? (uncertain)
 */
export function ProvenanceChip({ tier, sourcePath }: { tier: string; sourcePath?: string }) {
  const meta: Record<string, { tone: ChipTone; glyph: string }> = {
    preset: { tone: "accent", glyph: "◆" },
    "preset?": { tone: "warn", glyph: "◈" },
    library: { tone: "neutral", glyph: "▣" },
    local: { tone: "mono", glyph: "●" },
    inline: { tone: "neutral", glyph: "○" },
  };
  const m = meta[tier] ?? { tone: "neutral" as ChipTone, glyph: "○" };
  return (
    <Chip tone={m.tone} title={sourcePath ?? tier}>
      <span aria-hidden style={{ opacity: 0.7 }}>
        {m.glyph}
      </span>
      {tier}
    </Chip>
  );
}

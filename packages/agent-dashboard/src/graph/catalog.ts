/**
 * Blast-radius palette + capability metadata helpers (ported from swe-brain's
 * catalog, trimmed to what the constellation renders). The concrete
 * capability→tool catalog for the retrieval agent lives in composition.ts; this
 * file only owns the cross-cutting blast-radius display language.
 */
import type { BlastRadius, CapabilityMeta } from "./types";

/**
 * read = no tint (--mute) · write = the theme's "emit" category hue · external
 * = the theme's "generate" category hue. Values live behind `--blast-*`
 * tokens (styles/tokens-base.css derivation layer), which now derive from
 * each theme's `--category-3`/`--category-4` slots (styles/theme-<id>.css) —
 * the per-theme retuning flagged here in S1 landed in S2.
 */
export const BLAST_COLOR: Record<BlastRadius, string> = {
  read: "var(--blast-read)",
  write: "var(--blast-write)",
  external: "var(--blast-external)",
};
export const BLAST_NOTE: Record<BlastRadius, string> = {
  read: "observes only — safe",
  write: "mutates your records",
  external: "leaves your walls",
};
export const BLAST_ORDER: BlastRadius[] = ["read", "write", "external"];

/** Title-case a capability slug for a fallback label (`query-surface` → `Query Surface`). */
export function prettifySlug(slug: string): string {
  return slug
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export type { BlastRadius, CapabilityMeta };

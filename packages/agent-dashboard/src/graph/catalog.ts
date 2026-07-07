/**
 * Blast-radius palette + capability metadata helpers (ported from swe-brain's
 * catalog, trimmed to what the constellation renders). The concrete
 * capability→tool catalog for the retrieval agent lives in composition.ts; this
 * file only owns the cross-cutting blast-radius display language.
 */
import type { BlastRadius, CapabilityMeta } from "./types";

/**
 * read = no tint · write = green (Emit hue 155) · external = amber (Generate
 * hue 75). Values now live behind `--blast-*` tokens (styles/theme.css) rather
 * than raw oklch here, per port-map §7.1's hard-coded-color kill list; the
 * hues stay unchanged. Per-theme retuning (`--category-*` slots) lands in S2.
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

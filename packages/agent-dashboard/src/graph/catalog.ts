/**
 * Blast-radius palette + capability metadata helpers (ported from swe-brain's
 * catalog, trimmed to what the constellation renders). The concrete
 * capability→tool catalog for the retrieval agent lives in composition.ts; this
 * file only owns the cross-cutting blast-radius display language.
 */
import type { BlastRadius, CapabilityMeta } from "./types";

/** read = no tint · write = green (Emit hue 155) · external = amber (Generate hue 75). */
export const BLAST_COLOR: Record<BlastRadius, string> = {
  read: "var(--mute)",
  write: "oklch(0.6 0.13 155)",
  external: "oklch(0.66 0.15 75)",
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

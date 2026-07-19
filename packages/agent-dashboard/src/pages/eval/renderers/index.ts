/**
 * Detail-renderer registry. Maps a `Score.detail.kind` discriminant to a
 * presentational renderer for that payload. `ScoreRow` (`CaseDetail.tsx`)
 * consults `resolveDetailRenderer` before falling back to the raw-JSON expander.
 *
 * To add an app-specific eval visualization: write a `DetailRenderer`, register
 * it here under its `kind`, and have the scorer emit `{ kind, <payload> }` on
 * the score's `detail`. No framework store/route/schema change is needed — the
 * blob already flows end-to-end (grader → SQLite → REST/SSE → this dispatch).
 */

import { RenderGradeDetail } from "./RenderGradeDetail";
import { type DetailRenderer, detailKind } from "./types";

const REGISTRY: Record<string, DetailRenderer> = {
  "render-grade": RenderGradeDetail,
};

/**
 * The renderer for a detail blob's `kind`, or `null` when there's no `kind`
 * discriminant or none is registered for it. Never throws.
 */
export function resolveDetailRenderer(
  detail: Record<string, unknown> | undefined,
): DetailRenderer | null {
  const kind = detailKind(detail);
  return kind ? (REGISTRY[kind] ?? null) : null;
}

export { detailKind } from "./types";
export type { DetailRenderer, DetailRendererProps } from "./types";

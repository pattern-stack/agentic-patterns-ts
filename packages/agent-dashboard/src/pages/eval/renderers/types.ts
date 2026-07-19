/**
 * Detail-renderer registry contract.
 *
 * A `Score.detail` blob (`Record<string, unknown>`, opaque to the framework)
 * MAY carry a `kind` discriminant naming a registered renderer. When it does,
 * `CaseDetail`'s `ScoreRow` dispatches the blob to that renderer instead of the
 * raw-JSON `<details>` fallback — the seam that lets an app (e.g. Dealbrain)
 * ship domain-specific eval visualizations without a framework schema change.
 *
 * Contract:
 * - The discriminant is `detail.kind: string`. Absent/unknown ⇒ no custom
 *   render; the caller keeps its existing behavior.
 * - A renderer receives the whole `detail` blob (still untyped) and MUST parse
 *   it defensively — the framework never validates app payloads. Returning
 *   `null` signals "not my shape / malformed"; the caller then falls back to
 *   the raw-JSON expander, so a bad payload degrades, never throws.
 * - Renderers are pure presentational components: no data fetching, no routing.
 *
 * Payload convention: namespace the app data under a key so it can't collide
 * with future framework fields on `detail` — `{ kind: "<name>", <name-payload> }`.
 * The gate report, for example, is `{ kind: "render-grade", report: {...} }`.
 */

import type { ReactNode } from "react";
import type { EvalScoreLike } from "../../../api/types";

export interface DetailRendererProps {
  /** The full `Score.detail` blob. Untyped — the renderer guards it. */
  detail: Record<string, unknown>;
  /** The owning score, for name/value/pass context if a renderer wants it. */
  score: EvalScoreLike;
}

/** A registered renderer. Returns `null` when the blob isn't its shape. */
export type DetailRenderer = (props: DetailRendererProps) => ReactNode;

/** Reads the `kind` discriminant off a detail blob, or `null` when absent. */
export function detailKind(detail: EvalScoreLike["detail"]): string | null {
  if (!detail || typeof detail !== "object") return null;
  const kind = (detail as { kind?: unknown }).kind;
  return typeof kind === "string" && kind.length > 0 ? kind : null;
}

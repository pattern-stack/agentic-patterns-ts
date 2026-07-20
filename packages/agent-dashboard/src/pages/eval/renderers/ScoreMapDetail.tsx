/**
 * `kind: "score-map"` — a wide multi-axis score object (e.g. the SDC agent's
 * ~45 axes) grouped into readable buckets with threshold-colored meters. The
 * grouping + meter layout lives in `ScoreMapView` (shared with the run-grain
 * SDC score map); this renderer is the per-case adapter over `detail.axes`.
 *
 * Payload: `{ kind: "score-map", scores: Record<string, number | null> }` —
 * `scores` is the contract-canonical key (eval-family-contract.md); `axes` is
 * the accepted legacy alias. Neither an object ⇒ `null` (fall back to the
 * raw-JSON expander).
 */

import { ScoreMapView } from "./ScoreMapView";
import { isRecord } from "./shared";
import type { DetailRenderer } from "./types";

export const ScoreMapDetail: DetailRenderer = ({ detail }) => {
  const d = detail as { scores?: unknown; axes?: unknown };
  const axes = isRecord(d.scores) ? d.scores : d.axes;
  if (!isRecord(axes)) return null;
  // Called as a plain function so an empty axis map propagates `null` to the
  // caller (the raw-detail fallback), exactly as before the extraction.
  return ScoreMapView({ axes });
};

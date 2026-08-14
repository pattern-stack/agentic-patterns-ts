/**
 * Shared `RunOptions.host` → `RenderContext` narrowing (#444 Gate 2.5 M3 —
 * previously duplicated verbatim in both runners; the empty-string-is-absent
 * rule is a real semantic that must stay in lockstep).
 *
 * The runner reads exactly two keys off the opaque host bag: `host.scope`
 * (#308) and `host.recall` (#444 — the turn-1 recall block the HOST assembled
 * via `assembleRecall`, rendered by `Awareness.fromRecall`). An empty-string
 * `recall` is treated as ABSENT — `assembleRecall` returns `""` for "nothing
 * recalled", and rendering must stay byte-identical to the no-recall case.
 *
 * Lives in `runner/` (not `workflows/scope-host.ts`) deliberately:
 * `workflows` depends on `runner`, so a runner importing it back would be a
 * reverse layering violation. This module mirrors `hostOf`'s shape without
 * the import.
 */

import type { RenderContext } from "@pattern-stack/agentic-core";
import type { RunOptions } from "./types.js";

export function narrowRenderCtx(options?: RunOptions): RenderContext | undefined {
  const host = options?.host as { scope?: Record<string, unknown>; recall?: string } | undefined;
  const scope = host?.scope;
  const recall =
    typeof host?.recall === "string" && host.recall.length > 0 ? host.recall : undefined;
  if (!scope && recall === undefined) return undefined;
  return { ...(scope ? { scope } : {}), ...(recall !== undefined ? { recall } : {}) };
}

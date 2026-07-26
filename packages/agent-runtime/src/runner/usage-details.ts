// #388 — cache/reasoning token detail extraction + merge.
//
// Placed in the runner (layer 7), not events (layer 5): it imports the `ai`
// package's `LanguageModelUsage` type, and the events layer must stay
// SDK-free (plain interfaces only — see events/types.ts header).

import type { LanguageModelUsage } from "ai";
import type { TokenUsageDetails } from "../events/types.js";

/**
 * Extracts the five optional detail members from an ai@7 `LanguageModelUsage`.
 *
 * ABSENT MEANS UNREPORTED, NEVER ZERO: `LanguageModelUsage.inputTokenDetails`
 * and `.outputTokenDetails` are always-present objects whose members are each
 * independently `number | undefined` — a provider that doesn't report
 * cache/reasoning yields `undefined` members, never `0`. When every one of
 * the five members is `undefined` (e.g. our still-V2 `ClaudeCodeLanguageModel`,
 * whose V2→V3 shim maps none of these), this returns `undefined` so the
 * carrying event omits the whole `usageDetails` field rather than zero-filling
 * it. When at least one member is defined, the returned object carries only
 * the defined members.
 */
export function detailsFromUsage(
  usage: LanguageModelUsage | undefined,
): TokenUsageDetails | undefined {
  if (!usage) return undefined;

  const noCacheTokens = usage.inputTokenDetails?.noCacheTokens;
  const cacheReadTokens = usage.inputTokenDetails?.cacheReadTokens;
  const cacheWriteTokens = usage.inputTokenDetails?.cacheWriteTokens;
  const textTokens = usage.outputTokenDetails?.textTokens;
  const reasoningTokens = usage.outputTokenDetails?.reasoningTokens;

  if (
    noCacheTokens === undefined &&
    cacheReadTokens === undefined &&
    cacheWriteTokens === undefined &&
    textTokens === undefined &&
    reasoningTokens === undefined
  ) {
    return undefined;
  }

  return {
    ...(noCacheTokens !== undefined ? { noCacheTokens } : {}),
    ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
    ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
    ...(textTokens !== undefined ? { textTokens } : {}),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
  };
}

/**
 * Merges two (possibly absent) detail objects, per field.
 *
 * Mirrors ai@7's own `addTokenCounts` (`ai/dist/index.js:2614-2616` in the
 * installed `ai@7.0.37`), which `addLanguageModelUsage` applies per-field
 * when accumulating usage across steps: `undefined + undefined = undefined`;
 * otherwise sum, treating `undefined` as `0`. This is the exact semantics
 * ai@7 itself uses — do not "fix" this to something else; a run whose every
 * step under-reports a field should surface that as absence, not a false 0.
 */
export function mergeUsageDetails(
  a: TokenUsageDetails | undefined,
  b: TokenUsageDetails | undefined,
): TokenUsageDetails | undefined {
  if (!a) return b;
  if (!b) return a;

  const noCacheTokens = addField(a.noCacheTokens, b.noCacheTokens);
  const cacheReadTokens = addField(a.cacheReadTokens, b.cacheReadTokens);
  const cacheWriteTokens = addField(a.cacheWriteTokens, b.cacheWriteTokens);
  const textTokens = addField(a.textTokens, b.textTokens);
  const reasoningTokens = addField(a.reasoningTokens, b.reasoningTokens);

  if (
    noCacheTokens === undefined &&
    cacheReadTokens === undefined &&
    cacheWriteTokens === undefined &&
    textTokens === undefined &&
    reasoningTokens === undefined
  ) {
    return undefined;
  }

  return {
    ...(noCacheTokens !== undefined ? { noCacheTokens } : {}),
    ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
    ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
    ...(textTokens !== undefined ? { textTokens } : {}),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
  };
}

function addField(a: number | undefined, b: number | undefined): number | undefined {
  return a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0);
}

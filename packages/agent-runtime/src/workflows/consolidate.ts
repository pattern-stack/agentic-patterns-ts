/**
 * Shared typed consolidation contract for `Parallel` + `FanOut` (DESIGN §6.1).
 *
 * Optional reduce of N branch outputs into one. Omit ⇒ the result is the array
 * `TOut[]`. This types the legacy untyped `Consolidator`; the reduce now
 * operates on typed `TOut[]` and its result BECOMES the node's `TOut`, so a
 * downstream node receives it by threading.
 */
export type Consolidate<TOut, TConsolidated> = (outputs: readonly TOut[]) => TConsolidated;

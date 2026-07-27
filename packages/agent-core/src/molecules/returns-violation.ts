/**
 * Shared returns-violation tag — package-internal machinery used by both
 * `defineTool` (toolbox.ts) and `definePlay` (playbook.ts) to mark a thrown
 * error as "the callback's output failed its declared `returns` schema" so
 * the owning boundary (`Toolbox.execute` / `Playbook.execute`) can rename it
 * with the tool/play's name instead of it being indistinguishable from an
 * ordinary thrown error.
 *
 * Hoisted verbatim from `toolbox.ts` (#266) — the `Symbol.for` string must
 * exist in exactly one place; duplicating it across modules is the failure
 * mode this file prevents. NOT exported from the package barrel
 * (`molecules/index.ts`): this is internal wiring, not public API.
 */

/**
 * Marks a return-schema validation failure raised inside a `defineTool` or
 * `definePlay` wrapper. A globally registered symbol rather than an error
 * subclass: deployments are known to carry two copies of core across a
 * package boundary, where an `instanceof` check would spuriously fail.
 */
export const RETURNS_VIOLATION = Symbol.for("agentic-patterns.core.returns-violation");

/** Structural check for the marker — never `instanceof`. */
export function isReturnsViolation(err: unknown): err is Error & { cause: unknown } {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as Record<PropertyKey, unknown>)[RETURNS_VIOLATION] === true
  );
}

/**
 * The one copy of the user-facing phrase. #264's own quality review
 * (`tool-authoring-sugar.md:747`) flagged it duplicated across `toolbox.ts:179`
 * and `:252`; this module exists so both the tool side and the play side
 * compose their message from a single constant instead of adding a third and
 * fourth copy.
 */
export const RETURNS_VIOLATION_PHRASE = "output violated its returns schema";

/** Construct the tagged error both `defineTool` and `definePlay` throw. */
export function returnsViolation(message: string, cause: unknown): Error {
  const violation = new Error(message, { cause });
  (violation as unknown as Record<PropertyKey, unknown>)[RETURNS_VIOLATION] = true;
  return violation;
}

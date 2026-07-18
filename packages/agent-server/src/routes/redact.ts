/**
 * Shared context/scope redaction for the conversation-create and
 * composition-delivered echoes (#268 Decision 3, #308) — both routes must
 * redact identically or the composition lens leaks what the create response
 * hides.
 *
 * Shallow only: the copy is top-level, so a nested object/array VALUE under a
 * non-redacted key is still shared by reference with whatever the hook
 * received. Deliberate, not an oversight — the context contract (Decision 3
 * "context carries identifiers, not credentials") is scalar identifiers at
 * the top level; nested structures are outside that contract's redaction
 * guarantee.
 */
export function redactContext(
  context: Record<string, unknown> | undefined,
  keys: readonly string[] | undefined,
): { context: Record<string, unknown> | undefined; redactedKeys: string[] | undefined } {
  if (context === undefined || !keys || keys.length === 0) {
    return { context, redactedKeys: undefined };
  }
  const present = keys.filter((k) => k in context);
  if (present.length === 0) {
    return { context, redactedKeys: undefined };
  }
  const redacted = { ...context };
  for (const k of present) redacted[k] = "[redacted]";
  return { context: redacted, redactedKeys: present };
}

/**
 * Guard for what a duck-typed `SessionScopeLike.parse` hands back. A real
 * `SessionScope` can only return an object (its schema is `z.object`), but a
 * hand-rolled registration scope can return anything — and a primitive here
 * would crash `redactContext`'s `in` operator as an unhandled 500 instead of
 * a diagnosable registration bug.
 */
export function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

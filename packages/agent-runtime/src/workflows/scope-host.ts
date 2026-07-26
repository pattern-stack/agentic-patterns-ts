/**
 * Scope-host accessors — carry a server-parsed `SessionScope` value across
 * the host passthrough (#124) as a SIBLING key on the host bag (`host.scope`),
 * NOT inside `host.deps`. `host.deps` is a `DepReader` (`deps.ts`) — a plain
 * scope object living there would crash the first `ctx.deps.get()` a leaf
 * makes. Mirrors the `backpack.ts` tool-side trio (soft probe + fail-loud +
 * typed cast sugar) so scope reads feel identical to every other
 * host-carried value; narrows `ctx.host` EXACTLY as `nodeTool` does
 * (`node-tool.ts:58`).
 *
 * `buildScopeHost` and the readers share this ONE module so an injection
 * site (server/CLI) and a tool-side read always agree on the key shape —
 * the ESM/CJS dual-build hazard that motivated the sibling-key design over a
 * reserved `DepKey` singleton (see decisions.md D1).
 */

import type { ToolExecutionContext } from "@agentic-patterns/core";

/** The slice of the host bag this module reads/writes. */
interface ScopeHost {
  readonly scope?: Record<string, unknown>;
}

function hostOf(ctx: { host?: unknown } | undefined): ScopeHost | undefined {
  return ctx?.host as ScopeHost | undefined;
}

/**
 * Build the `RunOptions.host` fragment carrying a parsed scope value — the
 * injection-side counterpart to `readScope`/`requireScope`. Merge with any
 * other host bits at the call site: `{ ...otherHostBits, ...buildScopeHost(parsed) }`.
 */
export function buildScopeHost(parsed: Record<string, unknown>): {
  scope: Record<string, unknown>;
} {
  // Freeze (shallow) at the injection seam: this ONE bag is shared by every
  // later render (`Awareness.fromScope` fns) and every tool read for the
  // conversation's lifetime — a consumer that writes to it would silently
  // corrupt scope for everything downstream. Frozen, that write throws loud.
  return { scope: Object.freeze({ ...parsed }) };
}

/**
 * Fail-loud accessor error — mirrors `BackpackUnavailableError`'s remediation
 * tone (`backpack.ts`).
 */
export class ScopeUnavailableError extends Error {
  constructor() {
    super(
      "No session scope on this run. requireScope() needs RunOptions.host.scope to be " +
        "populated — build it with buildScopeHost(parsed) at the injection site (e.g. the " +
        "server's POST /conversations handler, after scope.parse()), or use readScope() for " +
        "a soft, optional read.",
    );
    this.name = "ScopeUnavailableError";
  }
}

/**
 * The other context shape a scope read can meet: `NodeRunContext` carries the
 * value directly at `ctx.scope` (no `host` bag). Both accessors accept either
 * shape — a `FunctionStep` author and a tool author call the same function.
 */
interface ScopeCarrier {
  readonly scope?: Record<string, unknown>;
}

/**
 * Soft probe — `undefined` when the run carries no scope. Use for tools that
 * genuinely must run scope-less; the read path default is {@link requireScope}.
 * Accepts a tool's `ToolExecutionContext` (scope at `ctx.host.scope`) OR a
 * node's `NodeRunContext` (scope at `ctx.scope`).
 */
export function readScope(
  ctx: ToolExecutionContext | ScopeCarrier | undefined,
): Record<string, unknown> | undefined {
  const viaHost = hostOf(ctx as { host?: unknown } | undefined)?.scope;
  if (viaHost !== undefined) return viaHost;
  return (ctx as ScopeCarrier | undefined)?.scope;
}

/**
 * Fail-loud accessor — the DEFAULT read path for a tool that requires scope.
 * Throws {@link ScopeUnavailableError} with remediation. Accepts both context
 * shapes, like {@link readScope}.
 */
export function requireScope(
  ctx: ToolExecutionContext | ScopeCarrier | undefined,
): Record<string, unknown> {
  const scope = readScope(ctx);
  if (!scope) throw new ScopeUnavailableError();
  return scope;
}

/**
 * Typed cast sugar — trusts that the server-side `scope.parse()` already ran
 * (decisions.md D10) and casts the raw scope bag to `T` (typically
 * `ScopeValue<typeof myScope>` from `@agentic-patterns/core`). Deliberately
 * does NOT re-parse per tool call — that would mean shipping the
 * `SessionScope` instance itself down every seam just to read one field.
 * Keep it honest: this is a cast, not a validation.
 */
export function readScopeAs<T>(
  ctx: ToolExecutionContext | ScopeCarrier | undefined,
): T | undefined {
  return readScope(ctx) as T | undefined;
}

/**
 * Typed + fail-loud — {@link requireScope} with the {@link readScopeAs} cast
 * folded in, so a tool that requires scope reads one call instead of
 * `requireScope(ctx) as MyScope`. Throws {@link ScopeUnavailableError} when the
 * run carries no scope.
 *
 * Same honesty caveat as {@link readScopeAs}: this is a CAST, not a validation.
 * It trusts the server-side `scope.parse()` (decisions.md D10) rather than
 * re-parsing per tool call.
 */
export function requireScopeAs<T>(ctx: ToolExecutionContext | ScopeCarrier | undefined): T {
  return requireScope(ctx) as T;
}

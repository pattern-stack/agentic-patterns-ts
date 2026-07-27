/**
 * Playbook — abstract class for defining named plays with Zod schemas.
 *
 * Plays are like tools but with error-envelope semantics:
 * PlayDefinition.execute throws on error, Playbook.execute catches
 * and returns { error: message }.
 *
 * Ported from Python: molecules/playbooks/base.py
 */

import type { ZodTypeAny, z } from "zod";
import {
  RETURNS_VIOLATION_PHRASE,
  isReturnsViolation,
  returnsViolation,
} from "./returns-violation.js";
import { ToolSchema } from "./tool-schema.js";

// ---------------------------------------------------------------------------
// PlayDefinition
// ---------------------------------------------------------------------------

/**
 * A single play definition within a Playbook.
 *
 * Similar to ToolDefinition but errors are caught at the Playbook level.
 */
export interface PlayDefinition {
  description: string;
  parameters: ZodTypeAny;
  /**
   * Optional output schema — what `execute` resolves to. Symmetric with
   * `parameters`. A play's TS return type is erased at runtime, so it can't be
   * introspected; declare `returns` to make the output shape visible to
   * consumers (e.g. a tool workbench rendering a `Returns` block). On a plain
   * object definition this is metadata only — output is never validated.
   * Plays built with `definePlay` opt into runtime output validation against
   * this schema. Omit it and consumers simply get no return shape.
   */
  returns?: ZodTypeAny;
  /** Optional render hint — see `ToolDefinition.displayType`. */
  displayType?: string;
  execute: (args: Record<string, unknown>) => Promise<unknown>;
}

/**
 * Define a schema-typed play while returning the framework's stable,
 * non-generic `PlayDefinition` surface — the play-side counterpart of
 * `defineTool` (`toolbox.ts`), minus `terminal` (plays are deliberately never
 * terminal, see the comment in `getPlaySchemas` below) and minus `ctx` (plays
 * don't get `ToolExecutionContext` — out of scope, ADR 0005 precedent).
 *
 * Arguments arrive contextually typed from `parameters` (`z.infer<P>`) — the
 * host boundary (`Playbook.execute`) already parses them, so this is
 * type-level only. The callback's raw result is compile-checked against
 * `z.input<R>`. Unless disabled via `validateReturns: false`, the result is
 * parsed through `returns`, so the parsed `z.output<R>` value — Zod defaults,
 * transforms, and unknown-key stripping applied — is what validation sees.
 *
 * Unlike `defineTool`, `returns` is REQUIRED here: a `definePlay` with no
 * `returns` would be indistinguishable from "no validation configured",
 * which is exactly the plain-`PlayDefinition` behavior this factory exists
 * to opt out of.
 *
 * **Validation precedes the JSON round-trip, not the value the host
 * receives.** `Playbook.execute` still runs `JSON.parse(JSON.stringify(...))`
 * on the result AFTER this wrapper's `returns.safeParseAsync` has already
 * approved it — so "validated" means "the live value your callback returned
 * matched `returns`", not "the payload the host receives matches `returns`".
 * A `z.date()` validates against a real `Date`; the round-trip then turns it
 * into an ISO string. Declare shape-preserving transforms if the
 * post-serialization shape must match `returns` exactly.
 *
 * Deliberately non-generic at the boundary: the returned value's inferred
 * declaration type is plain `PlayDefinition`, so no concrete Zod types leak
 * into a consumer's published `.d.ts` (#205).
 *
 * Validation failures are tagged and renamed by `Playbook.execute(name, ...)`
 * (`play '<name>' output violated its returns schema: ...`), never thrown
 * past that boundary — see `Playbook.execute`'s envelope contract. Calling
 * `.execute()` on the returned `PlayDefinition` directly, bypassing a
 * `Playbook`, DOES throw the tagged violation — that is outside the
 * supported path (see `Playbook.execute`'s docs on inbound misattribution).
 */
export function definePlay<P extends ZodTypeAny, R extends ZodTypeAny>(spec: {
  description: string;
  parameters: P;
  returns: R;
  /** Optional render hint — see `PlayDefinition.displayType`. */
  displayType?: string;
  /**
   * Parse output through `returns` before returning it.
   * @default true
   */
  validateReturns?: boolean;
  execute: (args: z.infer<P>) => Promise<z.input<R>>;
}): PlayDefinition {
  const validateReturns = spec.validateReturns ?? true;
  const definition: PlayDefinition = {
    description: spec.description,
    parameters: spec.parameters,
    returns: spec.returns,
    execute: async (args) => {
      const raw = await spec.execute(args as z.infer<P>);
      if (!validateReturns) {
        return raw;
      }
      // safeParseAsync so async refinements/transforms in `returns` are supported.
      const result = await spec.returns.safeParseAsync(raw);
      if (!result.success) {
        throw returnsViolation(
          `play ${RETURNS_VIOLATION_PHRASE}: ${result.error.message}`,
          result.error,
        );
      }
      return result.data;
    },
  };
  if (spec.displayType !== undefined) {
    definition.displayType = spec.displayType;
  }
  return definition;
}

// ---------------------------------------------------------------------------
// Playbook
// ---------------------------------------------------------------------------

/**
 * Abstract base class for playbooks.
 *
 * Subclasses must provide `name`, `description`, and a `plays` record
 * mapping play names to PlayDefinition objects.
 */
export abstract class Playbook {
  abstract readonly name: string;
  abstract readonly description: string;
  abstract readonly plays: Record<string, PlayDefinition>;

  /** Get play definitions as ToolSchema objects. */
  getPlaySchemas(): ToolSchema[] {
    return Object.entries(this.plays).map(([name, def]) =>
      // `terminal` (5th positional) is intentionally NOT threaded here — this
      // site has always omitted it, and passing `def.terminal` now would newly
      // declare playbook-sourced schemas terminal (behavioral change). Pass
      // `undefined` explicitly to reach the 6th (`displayType`) slot while
      // preserving today's behavior; see spec #352 §3 / PR notes.
      ToolSchema.fromZod(
        name,
        def.description,
        def.parameters,
        def.returns,
        undefined,
        def.displayType,
      ),
    );
  }

  /** Get names of all plays in this playbook. */
  getPlayNames(): string[] {
    return Object.keys(this.plays);
  }

  /**
   * Execute a play by name.
   *
   * Validates args via Zod. On success, returns JSON-safe result.
   * On error (unknown play, validation failure, execution error), returns
   * `{ error: message }` envelope instead of throwing. This is a play
   * contract choice, not a dependency of either named consumer: the three
   * `toolExecutor.execute` call sites in `agent-runner.ts` already wrap the
   * call in try/catch, and the MCP SDK's `CallTool` handler already converts
   * any thrown error into its own `isError` result. Neither would break if
   * this method threw instead. The envelope is kept because it is (a) the
   * observable behavior every existing play has always had and that tests
   * pin (`toolbox-executor.test.ts`'s play-dispatch block,
   * `playbook.test.ts`), (b) the payload shape `sdk-bridge.ts` sniffs for
   * (`"error" in result`) when deciding a tool call's `isError`, and (c)
   * consistent with the rest of the play contract — a returns-violation
   * isn't special enough to be the one error that breaks the pattern.
   *
   * This boundary owns the play's name (the record key), so it is also where
   * `definePlay` return-schema violations gain their uniform, play-named
   * message — the violation branch below returns a plain object, so an
   * OUTBOUND violation can never propagate out of this method.
   *
   * That does NOT close the INBOUND direction: if a play's own body calls a
   * `defineTool`/`definePlay` definition's `.execute()` directly (bypassing
   * `Toolbox.execute`/`Playbook.execute`), the inner tagged violation reaches
   * this catch still tagged and gets reported as THIS play's violation,
   * naming the wrong play and the wrong schema. Routing through
   * `someToolbox.execute(...)` is safe — `Toolbox.execute` strips the tag
   * before rethrowing — but direct `.execute()` on a definition is already
   * outside the supported path (it also bypasses parameter validation).
   * Accepted and documented, not mitigated; see #266.
   */
  async execute(name: string, args: unknown): Promise<unknown> {
    const play = this.plays[name];
    if (!play) {
      return { error: `Unknown play: ${name}` };
    }
    try {
      const parsed = play.parameters.parse(args) as Record<string, unknown>;
      const result = await play.execute(parsed);
      return JSON.parse(JSON.stringify(result ?? null));
    } catch (err) {
      if (isReturnsViolation(err)) {
        const detail = err.cause instanceof Error ? err.cause.message : err.message;
        return { error: `play '${name}' ${RETURNS_VIOLATION_PHRASE}: ${detail}` };
      }
      const message = err instanceof Error ? err.message : String(err);
      return { error: message };
    }
  }
}

/** Concrete Playbook over a static play record — see `playbook()`. */
class LiteralPlaybook extends Playbook {
  readonly name: string;
  readonly description: string;
  readonly plays: Record<string, PlayDefinition>;

  constructor(name: string, description: string, plays: Record<string, PlayDefinition>) {
    super();
    this.name = name;
    this.description = description;
    this.plays = plays;
  }
}

/**
 * Create a concrete Playbook from a static play record — the literal
 * counterpart to subclassing, mirroring `toolbox()` (`toolbox.ts`). The
 * record is retained by reference (not cloned or frozen — composition code
 * relies on record identity); inherited schema, name-listing, and execution
 * behavior are unchanged, and the result satisfies `instanceof Playbook`.
 */
export function playbook(
  name: string,
  description: string,
  plays: Record<string, PlayDefinition>,
): Playbook {
  return new LiteralPlaybook(name, description, plays);
}

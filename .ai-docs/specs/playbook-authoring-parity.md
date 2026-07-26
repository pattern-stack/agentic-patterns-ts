# Implementation strategy — issue #266: `core: Playbook authoring parity`

Deferred from #264, which shipped `defineTool` + `toolbox()`/`capability()` for tools and explicitly punted the play-side equivalent. This spec answers the five decisions #264 said the follow-up must make, then specifies the change.

## Scope and PR slicing

One PR. The pieces are small and interlocking (the shared violation module exists only to serve `definePlay`; the `Playbook.execute` branch is meaningless without the tag), so slicing would produce PRs that can't be reviewed independently.

| Piece | Files | Independently landable? |
|---|---|---|
| 1. Shared returns-violation module | `molecules/returns-violation.ts` (new), `molecules/toolbox.ts` | Yes, but pointless alone |
| 2. `definePlay` | `molecules/playbook.ts` | Needs 1 |
| 3. Discriminated envelope | `molecules/playbook.ts` | Needs 1 + 2 |
| 4. `playbook()` literal | `molecules/playbook.ts`, `molecules/index.ts` | Yes |
| 5. Docs + the ADR-citation fix | `docs/authoring-a-toolbox.md`, `packages/agent-core/README.md`, `runner/toolbox-executor.ts` | Yes |

Core floats independently of the lockstep triple. This is purely additive → **minor bump on `@agentic-patterns/core`**. Per repo rhythm the bump lands in its own release PR (see #332/#355), not here.

## Current state

`PlayDefinition` (`packages/agent-core/src/molecules/playbook.ts:23-37`) is `ToolDefinition` minus `terminal` and minus the `ctx` parameter:

```ts
execute: (args: Record<string, unknown>) => Promise<unknown>;   // untyped
returns?: ZodTypeAny;                                           // metadata only
```

`returns` has never been validated. The docstring at `:26-32` says it exists to enable "future output validation."

`Playbook.execute` (`playbook.ts:85-98`) diverges from `Toolbox.execute` (`toolbox.ts:241-258`) in four ways:

1. Unknown play → `{ error }` envelope, not a throw (`playbook.ts:87-89`).
2. Parameter parse failure → envelope; in `Toolbox.execute` the parse sits **outside** the try (`toolbox.ts:246`) and always throws.
3. Any execute throw → envelope (`playbook.ts:94-97`).
4. Success → `JSON.parse(JSON.stringify(result ?? null))` (`playbook.ts:93`). Tools return by identity.

**Producer adoption is near-zero.** Seven `extends Playbook` exist: one README snippet, five test fixtures, and `examples/agents/toolsmith/agent.ts:162` — whose own header comment says it exists so the dashboard's Playbook section has something to render. No shipped agent or preset declares a playbook. Consumer plumbing is by contrast complete and tested: `capability.ts:43-49`, `runner/toolbox-executor.ts:110-139`, `runner/sdk-bridge.ts:72-90`, `server/routes/composition.ts:318-340`, and the dashboard's `PlaybookView`.

Consequence for this change: **small blast radius, but also no production signal.** Test coverage has to carry the whole burden of correctness.

## The five decisions #264 required

| # | Decision | Choice | Why |
|---|---|---|---|
| 1 | Violation throws or `{ error }`? | **`{ error }`, discriminated** | Never-throw is load-bearing, not stylistic — see below |
| 2 | Parse before or after JSON serialization? | **Before (parse-then-serialize)** | Mirrors `defineTool`; keeps validation inside the factory; preserves the metadata-only contract for plain `PlayDefinition`s |
| 3 | Do plays gain `ToolExecutionContext`? | **No** | Out of scope; ADR 0005 precedent |
| 4 | Emit parsed transforms or only assert? | **Emit parsed** | Byte-identical to `defineTool` (`toolbox.ts:185`) |
| 5 | Ship `playbook()` at the same time? | **Yes** | Trivial, and `capability()` already accepts `playbook?` |

### D1 — never-throw is preserved, but the violation is discriminated

`runner/toolbox-executor.ts:16-19` states that routing plays through `playbook.execute` is precisely what keeps a malformed play from aborting the runner loop; `toolbox-executor.test.ts:120-124` pins "returns the `{ error }` envelope for a failing play instead of throwing". `sdk-bridge.ts:79` has no try/catch at all — a throw there would reject inside the MCP tool handler.

So a throwing `definePlay` is rejected. But the naive alternative is also wrong: today a returns-violation would be caught at `playbook.ts:94`, reduced to `err.message` at `:95`, and returned as `{ error }` — **indistinguishable** from a business failure, an unknown play, and a parameter-validation failure, with the `ZodError` cause destroyed.

Fix: tag the violation (same mechanism as tools), then branch on it in `Playbook.execute` *before* the generic catch, producing a **play-named** message. `Playbook.execute` owns the record key (`playbook.ts:85`), so it is the only place the name exists — the same argument that put the tool-named rename at the toolbox boundary (#264 spec, Correction #1).

**Envelope shape stays `{ error: string }`.** An added discriminant field (`errorKind`) was considered and deferred: `sdk-bridge.ts:82`, `routes/composition.ts` and the dashboard all consume this payload, and a string-only change is fully backward compatible. The name plus the fixed phrase is greppable and testable. Revisit if a consumer needs to branch programmatically.

### D2 — parse-then-serialize, with an honest caveat

Validation lives inside the `definePlay` wrapper, so it runs on the **live** value returned by the author's callback, before `playbook.ts:93`'s JSON round-trip.

**This means "validated" does not mean "the payload the host receives matches `returns`."** A `z.date()` validates against a real `Date`, then the round-trip turns it into a string. This is a real limitation and must be documented in the `definePlay` docstring, not discovered later.

The alternative — moving validation into `Playbook.execute` and parsing the post-serialization value — gives the stronger guarantee but was rejected because it would validate **all** plays, including plain `PlayDefinition`s whose `returns` is metadata today. `__tests__/playbook.test.ts:18-23` declares `returns: z.object({ greeting: z.string() })` for a play that returns the string `"Hello, …!"`; that fixture is the standing proof of metadata-only status, cited in both #266 and the #264 spec. Breaking it would be a silent behavior change for any consumer who declared `returns` as documentation.

**Invariant this spec preserves: a plain `PlayDefinition` behaves exactly as it does today. Only `definePlay`-built plays gain validation.**

### D3 — no `ctx` for plays

`PlayDefinition.execute` takes no context, and `toolbox-executor.ts:133-135` notes #99 scoped `Playbook.execute` out. ADR 0005 (`docs/adr/0005-session-scope.md:163-168`) records the same gap and argues half-wiring it would be worse than uniform absence. Threading context is a separate change with its own design; this spec does not touch it.

## Corrections to the issue

1. **#266's framing implies `PlayDefinition` and `ToolDefinition` are the same debt.** They share the untyped-args/unvalidated-returns debt, but plays additionally have envelope semantics and a JSON round-trip. A mechanical copy is the wrong move; that's why D1 and D2 exist.
2. **`getPlaySchemas` already forwards `displayType`** (`playbook.ts:62-69`), so `definePlay` must accept and pass it through, matching `defineTool` (`toolbox.ts:191-193`). Not mentioned in the issue.
3. **`Toolbox.execute`'s rename constructs a fresh, untagged `Error`** (`toolbox.ts:252`). `Playbook.execute` must do the same so a nested tool-in-play violation isn't re-attributed to the outer play. Flagged in #264's quality review (`tool-authoring-sugar.md:743`).
4. **`toolbox-executor.ts:17` cites "ADR 0002 D3"** as the source of the never-throw rule. ADR 0002 contains no mention of playbooks or plays. The most load-bearing constraint in this design has no decision record. Fix the comment to point at this spec.

## API design

### `molecules/returns-violation.ts` (new, package-internal)

Hoisted verbatim from `toolbox.ts:114-129`. **Not exported from the package barrel** — internal machinery. The `Symbol.for` string must exist in exactly one place; duplicating it across two modules is the failure mode this file prevents.

```ts
export const RETURNS_VIOLATION = Symbol.for("agentic-patterns.core.returns-violation");

export function isReturnsViolation(err: unknown): err is Error & { cause: unknown };

/** Construct the tagged error both factories throw. */
export function returnsViolation(message: string, cause: unknown): Error;
```

### `definePlay`

```ts
export function definePlay<P extends ZodTypeAny, R extends ZodTypeAny>(spec: {
  description: string;
  parameters: P;
  returns: R;                    // REQUIRED, unlike PlayDefinition.returns
  displayType?: string;
  /** Parse output through `returns` before returning it. @default true */
  validateReturns?: boolean;
  execute: (args: z.infer<P>) => Promise<z.input<R>>;   // no ctx — see D3
}): PlayDefinition;
```

Non-generic at the boundary (returns plain `PlayDefinition`), matching `defineTool` — no Zod types leak into a consumer's `.d.ts` (#205).

### `playbook()`

```ts
export function playbook(
  name: string,
  description: string,
  plays: Record<string, PlayDefinition>,
): Playbook;
```

Private `LiteralPlaybook extends Playbook`, mirroring `LiteralToolbox` (`toolbox.ts:262-273`). Record retained **by reference**, not cloned or frozen — same rationale as `toolbox()` (`toolbox.ts:275-282`): composition code relies on record identity. `instanceof Playbook` must hold.

### `Playbook.execute` — the only behavioral change

```ts
try {
  const parsed = play.parameters.parse(args) as Record<string, unknown>;
  const result = await play.execute(parsed);
  return JSON.parse(JSON.stringify(result ?? null));
} catch (err) {
  if (isReturnsViolation(err)) {
    const detail = err.cause instanceof Error ? err.cause.message : err.message;
    return { error: `play '${name}' output violated its returns schema: ${detail}` };
  }
  return { error: err instanceof Error ? err.message : String(err) };
}
```

Still returns, never throws. Note the violation branch returns a **plain object**, so the untagged-rethrow concern from Correction #3 is satisfied structurally — nothing propagates.

## File-by-file change plan

| File | Change |
|---|---|
| `packages/agent-core/src/molecules/returns-violation.ts` | **New.** Symbol + guard + constructor, moved from `toolbox.ts` |
| `packages/agent-core/src/molecules/toolbox.ts` | Delete `:114-129`; import from the new module; `defineTool` uses `returnsViolation(...)` at `:178-183`. No behavior change |
| `packages/agent-core/src/molecules/playbook.ts` | Add `definePlay`, `LiteralPlaybook`, `playbook()`; add the violation branch to `execute`; document the D2 caveat on `definePlay` |
| `packages/agent-core/src/molecules/index.ts` | Export `definePlay`, `playbook` alongside `Playbook` (line 6 pattern). **Do not** export the violation module |
| `packages/agent-runtime/src/runner/toolbox-executor.ts` | Comment fix only — replace the unverifiable "ADR 0002 D3" citation (`:17`) |
| `examples/agents/toolsmith/agent.ts` | Migrate `slug_and_span` to `definePlay`; drop the two hand-casts and the `#266` placeholder comment left by the sweep (PR #382) |
| `docs/authoring-a-toolbox.md` | Replace the `:224-226` non-goal with a real play-authoring section: envelope semantics, the D2 caveat, the tool-wins collision rule |
| `packages/agent-core/README.md` | Update `:109-137` to the `playbook()` + `definePlay` form |

## Test plan

New/extended in `packages/agent-core/src/molecules/__tests__/`.

**`definePlay` — parity with `defineTool`**
- args arrive typed; no cast needed (compile-level, asserted by the fixture compiling)
- output parsed through `returns` by default; Zod defaults/transforms/stripping applied
- `validateReturns: false` returns the raw value unparsed
- `displayType` passes through to `getPlaySchemas()`
- result is a plain `PlayDefinition` (assignable, no generic leak)

**Violation semantics — the core of this change**
- a `definePlay` whose output violates `returns` yields `{ error: "play 'x' output violated its returns schema: …" }`
- it **does not throw** — assert `await expect(...).resolves` explicitly
- the message names the play (the record key, not the schema)
- an ordinary thrown error still yields the plain `{ error: message }`, unchanged
- unknown play and parameter-validation failures are byte-identical to today

**The metadata-only invariant (regression guard)**
- `playbook.test.ts:18-23`'s `greet` — plain `PlayDefinition`, object `returns`, returns a string — **still succeeds**. This is the test that proves we didn't silently start validating plain plays. Add an explicit comment saying so.

**The D2 caveat, pinned as behavior**
- a `definePlay` returning `{ at: new Date(...) }` with `returns: z.object({ at: z.date() })` **validates**, and the host receives `{ at: "…ISO…" }`. Documents that validation precedes serialization rather than leaving it to be discovered.

**`playbook()` literal**
- `getPlaySchemas()` / `getPlayNames()` / `execute()` indistinguishable from the subclass form
- `instanceof Playbook` holds
- record retained by reference (mutating the source record after construction is visible — matches `toolbox()`)

**Cross-boundary (runtime package)**
- `toolbox-executor` still returns the envelope for a violating play and does not abort the loop — extend `toolbox-executor.test.ts:120-124`
- tool-wins-on-collision unchanged (`toolbox-executor.test.ts:151-162`)

## Risks and compatibility

| Risk | Mitigation |
|---|---|
| Moving the symbol changes tool-side behavior | Pure move, no semantic edit; existing `tool-authoring.test.ts` violation tests must pass untouched |
| Two copies of core in one process | Preserved — `Symbol.for` + structural check, never `instanceof` (`toolbox.ts:114-119` rationale carried over verbatim) |
| Consumers relying on unvalidated `returns` in a `definePlay`-built play | Not possible — `definePlay` is new; nothing uses it yet |
| Consumers relying on unvalidated `returns` in a plain `PlayDefinition` | Explicitly preserved by D2; guarded by the fixture test |
| Envelope-shape consumers (`sdk-bridge.ts:82`, composition routes, dashboard) | Shape unchanged: still `{ error: string }`. Only the string content differs, and only for violations |
| No production playbook exists to validate against | Accepted and called out. Test coverage carries it; the toolsmith migration is the only real exercise |

## Acceptance mapping

| #266 acceptance | Where satisfied |
|---|---|
| Typed play factory | `definePlay` — API design |
| Enforced `returns` | Parsed by default, `validateReturns` opt-out |
| Playbook literal | `playbook()` |
| Decide: throw vs envelope | D1 — envelope, discriminated |
| Decide: parse before/after serialization | D2 — before, caveat documented |
| Decide: plays gain ctx | D3 — no, ADR 0005 precedent |
| Decide: emit parsed vs assert | D4 — emit parsed |
| Decide: literal ships together | D5 — yes |
| Docs | `authoring-a-toolbox.md` play section + README |

**Non-goals:** threading `ToolExecutionContext` into plays (#99/#308 territory); changing the JSON round-trip; adding `terminal` to plays (deliberately absent, `playbook.ts:57-61`); an `errorKind` discriminant field (deferred, see D1).

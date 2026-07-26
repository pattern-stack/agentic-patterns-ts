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
| 6. Release | `packages/agent-core/package.json`, `CHANGELOG.md`, `bun.lock` | No — must ride with 1-4 or core never publishes |

Core floats independently of the lockstep triple. This is purely additive → **minor bump on `@agentic-patterns/core` (0.15.0 → 0.16.0), in this PR, with a CHANGELOG entry.**

Precedent, verified: `175f59a` (#264) bumped core `0.10.0 → 0.11.0` and added a CHANGELOG entry *in the feature commit*; `3d1a3a5` (#265) did the same for `0.11.0 → 0.12.0`. Both also touched `bun.lock` in that same commit.

Omitting the bump would mean the publish job correctly skips core (`ci.yml:57-65`: "publishes it IFF its version isn't already on npm — so merges without a version bump are fast no-ops") and this work never reaches npm.

**Lockfile — narrowly.** Update ONLY the four workspace `version` fields bun.lock caches (read by `scripts/publish.sh`'s lockfile-sanity gate). Do **not** run `rm bun.lock && bun install`: it regenerates every caret-ranged external dep and silently drags in unrelated upgrades. #385 hit exactly this (`1335911`) — the refresh moved `@anthropic-ai/claude-agent-sdk` 0.3.215 → 0.3.220 and broke the SDK packaging-contract fixture — and fixed it by restoring the external pins and touching only the workspace version fields. CI runs `bun install --frozen-lockfile` (`ci.yml:29`, `:94`), which a workspace-version-only edit satisfies.

(#332 is lockstep-only. #355 is *"lockstep+core bump (bump-both)"* — it does cover core, contrary to an earlier draft of this paragraph. It doesn't change the decision, which rests on the `175f59a`/`3d1a3a5` precedent, but the two issues are not interchangeable.)

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

**Producer adoption is near-zero.** Seven `extends Playbook` exist: one README snippet, five test fixtures, and `examples/agents/toolsmith/agent.ts:163` — whose own header comment (`:157-161`) says it exists so *the capability detail page's* Playbook section has something to render. No shipped agent or preset declares a playbook. Consumer plumbing is by contrast complete and tested: `capability.ts:43-49`, `runner/toolbox-executor.ts:110-139`, `runner/sdk-bridge.ts:72-90`, `server/routes/composition.ts:318-340`, the dashboard's `PlaybookView`, and `tools/check-model-facing-schemas.ts` — which lints the toolsmith play's schemas and is wired into the root `check` script, so it gates a file this plan edits.

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

`runner/toolbox-executor.ts:16-19` states that routing plays through `playbook.execute` is precisely what keeps a malformed play from aborting the runner loop; `toolbox-executor.test.ts:118-122` pins "returns the `{ error }` envelope for a failing play instead of throwing". `sdk-bridge.ts:79` has no try/catch at all — a throw there would reject inside the MCP tool handler.

So a throwing `definePlay` is rejected. But the naive alternative is also wrong: today a returns-violation would be caught at `playbook.ts:94`, reduced to `err.message` at `:95`, and returned as `{ error }` — **indistinguishable** from a business failure, an unknown play, and a parameter-validation failure, with the `ZodError` cause destroyed.

Fix: tag the violation (same mechanism as tools), then branch on it in `Playbook.execute` *before* the generic catch, producing a **play-named** message. `Playbook.execute` owns the record key (`playbook.ts:85`), so it is the only place the name exists — the same argument that put the tool-named rename at the toolbox boundary (#264 spec, Correction #1).

**Envelope shape stays `{ error: string }`.** An added discriminant field (`errorKind`) was considered and deferred: `sdk-bridge.ts:80-81`, `routes/composition.ts` and the dashboard all consume this payload, and a string-only change is fully backward compatible. The name plus the fixed phrase is greppable and testable. Revisit if a consumer needs to branch programmatically.

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
3. **Inbound misattribution — a real residual edge, not a solved one.** There are two directions to consider, and an earlier draft of this spec conflated them.

   *Outbound* (a violation escaping `Playbook.execute` and being re-tagged upward) is impossible by construction: the branch below returns a plain `{ error }` object, so nothing propagates.

   *Inbound* is the real risk: a violation raised **inside** the play's own body reaching the play's catch and being reported as the outer play's violation. Two sub-cases:

   - The play calls `someToolbox.execute("x", …)` — **safe**. `toolbox.ts:250-257` catches the tagged violation and rethrows a fresh `new Error(…, { cause })` *without* the marker, so `isReturnsViolation` is false at the play's catch and it falls through to the generic branch. This is the toolsmith pattern (`examples/agents/toolsmith/agent.ts:187-188`) and the common case.
   - The play calls a `defineTool`/`definePlay` definition's `.execute()` **directly**, bypassing the `Toolbox`/`Playbook` boundary — **unsafe**. The tag survives, the outer catch matches, and the envelope reads `play '<outer>' output violated its returns schema` naming the wrong play and the wrong schema. This is the only case where `isReturnsViolation` is true for something that is not this play's violation.

   **Decision: accept and document, do not mitigate here.** A correct fix needs provenance on the tag (which definition raised it), which is a change to the tool-side mechanism too and is out of scope for #266 — the identical residual exists on the tool side today (`tool-authoring-sugar.md:743`). Direct `.execute()` on a definition bypasses parameter validation as well, so it is already outside the supported path. The test plan pins the behavior so it is a known, documented limitation rather than a surprise.
4. **`toolbox-executor.ts:17` cites "ADR 0002 D3"** as the source of the never-throw rule. ADR 0002 contains no mention of playbooks or plays. The most load-bearing constraint in this design has no decision record. Fix the comment to point at this spec.

## API design

### `molecules/returns-violation.ts` (new, package-internal)

Hoisted verbatim from `toolbox.ts:114-129`. **Not exported from the package barrel** — internal machinery. The `Symbol.for` string must exist in exactly one place; duplicating it across two modules is the failure mode this file prevents.

```ts
export const RETURNS_VIOLATION = Symbol.for("agentic-patterns.core.returns-violation");

export function isReturnsViolation(err: unknown): err is Error & { cause: unknown };

/** Construct the tagged error both factories throw. */
export function returnsViolation(message: string, cause: unknown): Error;

/**
 * The one copy of the user-facing phrase. #264's own quality review
 * (`tool-authoring-sugar.md:747`) flagged it duplicated across `toolbox.ts:179`
 * and `:252`; this change would otherwise add a third and fourth copy while
 * creating the very module that fixes it.
 */
export const RETURNS_VIOLATION_PHRASE = "output violated its returns schema";
```

All four construction sites (`defineTool`'s throw, `Toolbox.execute`'s rename, `definePlay`'s throw, `Playbook.execute`'s branch) compose their message from this constant.

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
    return { error: `play '${name}' ${RETURNS_VIOLATION_PHRASE}: ${detail}` };
  }
  return { error: err instanceof Error ? err.message : String(err) };
}
```

Still returns, never throws — the violation branch returns a **plain object**, so nothing propagates *outward*.

**This does not close Correction #3.** The *inbound* residual is live in exactly this branch: if a still-tagged violation arrives from a definition's direct `.execute()`, `isReturnsViolation` matches and this code emits the outer play's name. That is the accepted, documented limitation — see Correction #3 and the two tests that pin it.

## File-by-file change plan

| File | Change |
|---|---|
| `packages/agent-core/src/molecules/returns-violation.ts` | **New.** Symbol + guard + constructor, moved from `toolbox.ts`. Also owns the shared message fragment (see below) |
| `packages/agent-core/src/molecules/toolbox.ts` | Delete `:114-129`; import from the new module; `defineTool` uses `returnsViolation(...)` at `:178-183`; `Toolbox.execute` uses the shared fragment at `:252`. No behavior change |
| `packages/agent-core/src/molecules/playbook.ts` | Add `definePlay`, `LiteralPlaybook`, `playbook()`; add the violation branch to `execute`; document the D2 caveat on `definePlay`; **update the `PlayDefinition.returns` docstring (`:26-32`)** — it currently promises "future output validation", which after this ships is misleading at the exact site a consumer reads to learn the invariant. Mirror what #264 did for tools (`toolbox.ts:76-79`) |
| `packages/agent-core/src/molecules/index.ts` | Export `definePlay`, `playbook` alongside `Playbook` (line 6 pattern). **Do not** export the violation module |
| `packages/agent-core/package.json` | Bump `0.14.0 → 0.15.0` (see § Scope) |
| `CHANGELOG.md` | Entry for the core minor — matches `175f59a`/`3d1a3a5` precedent |
| `bun.lock` | `rm bun.lock && bun install` in the **same commit** as the bump (#355 hard rule; both precedent commits did this). Skipping it drifts the lockfile and fails CI |
| `packages/agent-runtime/src/runner/toolbox-executor.ts` | Comment fix only — replace the unverifiable "ADR 0002 D3" citation (`:17`) with a pointer to this spec's D1 |
| `examples/agents/toolsmith/agent.ts` | Migrate `slug_and_span` to `definePlay`; drop the two hand-casts and the `#266` placeholder comment left by the sweep (PR #382) |
| `docs/authoring-a-toolbox.md` | **Add** a play-authoring section (envelope semantics, the D2 caveat, the tool-wins collision rule). Narrow the `:224-226` non-goal paragraph to drop only the #266 sentence — **the other three non-goals in it (camel↔snake mappers, `.describe()` compression, host-specific filter envelopes) remain valid and must survive** |
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
- Note `playbook.test.ts:31-35` already has a `returnDate` fixture covering plain `Date` → ISO round-tripping. **Extend that fixture rather than adding a parallel one** — the new assertion is specifically that validation *succeeded* on the live `Date` before serialization flattened it.

**The inbound-misattribution edge (Correction #3)**
- a play calling `someToolbox.execute("x", …)` where the *tool* violates its `returns` yields the **tool-named** message in the envelope, not the play's — proves `toolbox.ts:250-257`'s tag strip works across the seam
- a play calling a `defineTool` definition's `.execute()` **directly** yields the play-named message — the known, accepted misattribution. Pinned so it's documented behavior; a future provenance-carrying tag would flip this assertion deliberately.

**Never-throw across the SDK seam (D1's actual argument)**
- drive a violating `definePlay` through `buildCapabilityServer` (`sdk-bridge.ts:79-84`) and assert the handler **resolves** with `isError: true`, not rejects. D1 rests on the claim that a throw would reject inside the MCP tool handler; nothing currently tests that path, and it is the one place a regression would be invisible in core's own suite.

**Direct-execute shape**
- `definePlay(...).execute(args)` invoked outside a `Playbook` **throws** the tagged violation. New observable behavior for a public shape (`PlayDefinition.execute` is part of the type), so it needs pinning even though it is not the supported path.

**`playbook()` literal**
- `getPlaySchemas()` / `getPlayNames()` / `execute()` indistinguishable from the subclass form
- `instanceof Playbook` holds
- record retained by reference (mutating the source record after construction is visible — matches `toolbox()`)

**Cross-boundary (runtime package)**
- `toolbox-executor` still returns the envelope for a violating play and does not abort the loop — extend `toolbox-executor.test.ts:118-122`
- tool-wins-on-collision unchanged (`toolbox-executor.test.ts:146-159`)

## Risks and compatibility

| Risk | Mitigation |
|---|---|
| Moving the symbol changes tool-side behavior | Pure move, no semantic edit; existing `tool-authoring.test.ts` violation tests must pass untouched |
| Two copies of core in one process | Preserved — `Symbol.for` + structural check, never `instanceof` (`toolbox.ts:114-119` rationale carried over verbatim) |
| Consumers relying on unvalidated `returns` in a `definePlay`-built play | Not possible — `definePlay` is new; nothing uses it yet |
| Consumers relying on unvalidated `returns` in a plain `PlayDefinition` | Explicitly preserved by D2; guarded by the fixture test |
| Envelope-shape consumers (`sdk-bridge.ts:80-81`, composition routes, dashboard) | Shape unchanged: still `{ error: string }`. Only the string content differs, and only for violations |
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

## Spec Review
<!-- written by: reviewer · gate 1.5 · /sdlc:critique · lens=mixed -->

**Target:** `.ai-docs/specs/playbook-authoring-parity.md`
**Against:** cited code (verified @ `2411fc8`)
**Verdict: REVISE**

The design is sound and the central invariant holds — I traced it and could not find a path
where a plain `PlayDefinition`'s `returns` becomes validated. Correction #4 (the phantom
"ADR 0002 D3" citation) is **confirmed**: ADR 0002 contains zero occurrences of `play`,
`playbook`, or `D3` (its only hit is "playground" at `:121`). The producer-adoption census is
exact. Two blockers: a self-contradictory Correction #3, and a doc-parity omission the spec's
own thesis depends on.

### Citations — verified correct

`playbook.ts:23-37` (PlayDefinition), `:26-32` ("future output validation"), `:57-61`
(terminal deliberately omitted), `:62-69` (`displayType` forwarded — Correction #2 valid),
`:85`, `:85-98`, `:87-89`, `:93`, `:94-97` ✅ — every playbook.ts anchor is exact.
`toolbox.ts:114-129` (symbol + guard), `:114-119` (dual-core rationale), `:178-183`
(violation construction), `:185` (`return result.data`), `:191-193` (displayType passthrough),
`:241-258`, `:246` (parse outside the try), `:252` (fresh untagged `Error` — **Correction #3's
premise confirmed**), `:262-273` (`LiteralToolbox`), `:275-282` ✅.
`playbook.test.ts:18-23` — `greet` declares `returns: z.object({greeting})` and resolves the
string `` `Hello, ${name}!` `` ✅, the metadata-only proof stands.
`toolbox-executor.ts:16-19`, `:17` (the ADR 0002 D3 comment), `:110-139`, `:133-135` ✅.
`sdk-bridge.ts:79` — `await playbook.execute(...)` inside an `sdkTool` handler with no
try/catch ✅. `capability.ts:43-49` ✅. `composition.ts:318-340` ✅.
`0005-session-scope.md:163-168` — "half-wiring it would be worse than the uniform absence" ✅.
`authoring-a-toolbox.md:224-226` ✅. `README.md:109-137` ✅. `tool-authoring-sugar.md:743` ✅.

Also verified independently: **7** `extends Playbook` (README:117, playbook.test.ts:14 + :129,
tool-authoring.test.ts:318, composition.test.ts:55 + :116, toolsmith agent) — 1 docs + 5 test
fixtures + 1 example, exactly as claimed; **zero** shipped agents/presets declare a playbook.
`RETURNS_VIOLATION`/`isReturnsViolation` are module-private in `toolbox.ts` with no external
importers → the hoist is safe, and the single tool-side violation test
(`tool-authoring.test.ts:67-87`) is unaffected. Only two sites ever execute a play
(`toolbox-executor.ts:138`, `sdk-bridge.ts:79`), both through `Playbook.execute` → the
never-throw guarantee has no shipped bypass. `agent-core/src/index.ts:5` is `export *`, so
adding to `molecules/index.ts` is sufficient. The parameter `.parse()` is already inside the
try today, so the proposed rewrite is byte-identical for unknown-play and param-validation
paths.

**Blockers (2):**

- [`§ Corrections #3` (spec:79) vs `§ Playbook.execute` (spec:141)] Correction #3 states
  "`Playbook.execute` must do the same [construct a fresh untagged error] **so a nested
  tool-in-play violation isn't re-attributed to the outer play**," then spec:141 dismisses it
  with "the violation branch returns a plain object … nothing propagates." That is a
  non-sequitur — it answers an *outbound* re-tagging concern, while the stated goal is
  *inbound* misattribution, which returning a plain object does not address at all. The real
  reason a nested tool-in-play violation is safe is that `toolbox.ts:252` strips the tag, and
  that has nothing to do with what `Playbook.execute` does. The residual hole is exactly the
  one `tool-authoring-sugar.md:743` flagged for tools and the spec mis-summarizes: if a play's
  body calls a `defineTool`/`definePlay` definition's `.execute()` **directly** (bypassing
  `Toolbox.execute`), the inner tagged violation reaches the outer catch and the proposed
  branch labels it `play '<outer>' output violated its returns schema` — a wrong play, a wrong
  claim about which schema failed, and the only case where `isReturnsViolation` is true for
  something that is not this play's violation. Nothing in the design or test plan covers it.
  _Fix:_ rewrite Correction #3 to name the inbound direction and state the actual mitigation
  (`Toolbox.execute`'s strip); then either accept the direct-`.execute()` composition edge
  explicitly as a documented limitation inherited from #264, or scope the tag (stamp an owner
  and clear/ignore it when the owner isn't this boundary). Add a test either way.

- [`§ File-by-file change plan` (spec:149) / `playbook.ts:26-32`] The plan never updates
  `PlayDefinition.returns`'s docstring, which still says `returns` exists "to enable **future
  output validation**." After this ships, that sentence is actively false-in-spirit —
  validation exists, just not for plain definitions — and it is the single site a consumer
  reads to learn the invariant the whole design is built on. #264 set the exact precedent on
  the tool side (`toolbox.ts:76-79`: "On a plain object definition this is metadata only —
  output is never validated. Tools built with `defineTool` opt into runtime output
  validation"). The spec's plan includes a much smaller doc fix (the ADR comment) but omits
  this one. _Fix:_ add `playbook.ts:26-32` to the change plan with the `toolbox.ts:76-79`
  wording mirrored for plays.

**Notes (5):**

- [`§ Scope and PR slicing` (spec:17)] "Per repo rhythm the bump lands in its own release PR
  (see #332/#355), not here" is contradicted by the two most analogous precedents: `175f59a`
  (#264, the parent of this work) bumped core `0.10.0 → 0.11.0` **and** added a CHANGELOG
  entry in the feature commit; `3d1a3a5` (#265) did the same for `0.11.0 → 0.12.0`. `#332` and
  `#355` are also open **issues**, not PRs. Consequently `CHANGELOG.md` is missing from the
  file-by-file plan even though every comparable feature commit touched it.

- [`§ D1` (spec:53) / `§ Test plan` (spec:186)] `toolbox-executor.test.ts:120-124` is drifted:
  the "returns the `{ error }` envelope for a failing play instead of throwing" test is
  `:118-122`; `:120-124` starts mid-test and runs into the next test's comment. Likewise
  `:151-162` (cited for tool-wins-on-collision) — that test is `:146-159`; the cited range
  covers only its tail. Both anchors are instructions to the implementer about where to extend
  tests, so the drift is load-bearing. Same class: `examples/agents/toolsmith/agent.ts:162` is
  blank — the class is at `:163`; and `sdk-bridge.ts:82` (cited twice as the envelope-shape
  consumer) is `return {` — the actual `{ error }` consumption is `:80-81`.

- [`§ Test plan` (spec:156-187)] Given the spec's own admission that there is no production
  signal, the plan under-covers two paths it names as load-bearing. (a) `sdk-bridge.ts:79-84`
  is the argument for never-throw (no try/catch → a throw rejects inside the MCP handler), but
  no test drives a violating `definePlay` play through `buildCapabilityServer` to confirm it
  lands as `isError: true` rather than a rejection. (b) Nothing pins that
  `definePlay(...).execute(args)` invoked **directly** — outside any `Playbook` — throws; that
  is a new behavior for a publicly exported shape and the only escape hatch from the
  never-throw guarantee. Add both.

- [`§ File-by-file change plan` (spec:153)] "Replace the `:224-226` non-goal with a real
  play-authoring section" would delete three still-valid #264 non-goals (camel↔snake mappers,
  `.describe()` prose compression, host-specific filter envelopes) that share that paragraph
  with the playbook-parity sentence. Amend the last sentence only.

- [`molecules/returns-violation.ts` (spec:84-95)] #264's own quality review nit
  (`tool-authoring-sugar.md:747`) flagged that the literal `"output violated its returns
  schema"` is duplicated between the inner wrapper (`toolbox.ts:179`) and the boundary
  (`toolbox.ts:252`) and can drift. This spec adds a third and fourth copy (`definePlay`'s
  inner message, `Playbook.execute`'s rename) while creating precisely the shared module that
  would fix it, and does not hoist the fragment. Free win; take it.

**Nits (3):**

- [`§ Current state` (spec:37)] The consumer inventory omits `tools/check-model-facing-schemas.ts`,
  which lints the toolsmith playbook's play `parameters` + `returns` and is wired into the root
  `check` pipeline (#265). Migrating `slug_and_span` to `definePlay` passes both schemas through
  by reference so the sweep still passes — but it is a CI gate on a file the plan edits and it
  should be named.

- [`§ Test plan` (spec:178)] `playbook.test.ts:31-35` already ships a `returnDate` fixture
  exercising the `Date` → ISO-string round-trip. Pin the D2 caveat against (or adjacent to)
  that existing fixture rather than introducing a parallel one.

- [`§ Current state` (spec:37)] "whose own header comment says it exists so the **dashboard's**
  Playbook section has something to render" — the comment (`examples/agents/toolsmith/agent.ts:157-161`)
  says "the **capability detail page's** Playbook section." Immaterial, but it reads as a quote.

**Reviewed by:** reviewer agent · 2026-07-26T00:00:00Z

---

## Design Addendum — response to Gate 1.5 (spec-review REVISE)

Reviewer verdict: REVISE, 2 blockers / 5 notes / 3 nits. All findings verified independently against the code before acting; none were taken on assertion. Every change below is in the static sections above, not bolted on here.

### Blockers — both accepted

**B1 — Correction #3 was self-contradictory.** The original text demanded `Playbook.execute` build a fresh untagged error "so a nested tool-in-play violation isn't re-attributed", then dismissed the concern because the branch returns a plain object. Those answer different directions: returning a plain object solves *outbound* propagation; the stated goal was *inbound* misattribution, which it does nothing for.

Rewritten to separate the two directions and state the real finding: the toolbox-mediated path is safe (`toolbox.ts:250-257` strips the tag — verified), while a play calling a definition's `.execute()` **directly** propagates a still-tagged violation and gets misattributed. **Decision: accept and document, don't mitigate.** A correct fix needs provenance on the tag, which changes the tool-side mechanism too and is out of scope; the identical residual already exists for tools (`tool-authoring-sugar.md:743`). Two tests now pin both sub-cases.

**B2 — `PlayDefinition.returns` docstring omitted from the change plan.** It promises "future output validation" (`playbook.ts:26-32`), which after this ships is misleading at the exact site a consumer reads to learn the invariant. #264 fixed the tool-side equivalent (`toolbox.ts:76-79`). Added to the file plan.

### Notes — all accepted

- **Release rhythm was wrong, and it was the highest-consequence error in the spec.** I claimed core bumps land in separate release PRs, citing #332/#355. Verified: those are **lockstep** (runtime/server/cli) issues, and both `175f59a` (#264) and `3d1a3a5` (#265) bumped core *and* added a CHANGELOG entry in the feature commit. Following the original spec, the implementer would have shipped no bump, the publish job would have correctly skipped core, and the work would never have reached npm. § Scope now specifies `0.14.0 → 0.15.0` + CHANGELOG, with the precedent cited.
- **Citation drift — 4 anchors, all confirmed wrong by direct inspection and corrected:** `toolbox-executor.test.ts:120-124` → `:118-122`; `:151-162` → `:146-159`; `toolsmith/agent.ts:162` (blank) → `:163`; `sdk-bridge.ts:82` → `:80-81`. These are implementer instructions, so drift is load-bearing rather than cosmetic.
- **Test plan under-covered two paths D1 explicitly rests on.** Added: a violating play driven through `buildCapabilityServer` asserting `isError: true` rather than a rejection, and a direct `definePlay(...).execute()` throw.
- **`authoring-a-toolbox.md` edit over-deleted.** "Replace the `:224-226` non-goal" would have removed three still-valid #264 non-goals sharing that paragraph. Narrowed to dropping only the #266 sentence.
- **Message-fragment triplication.** The change would have added a third and fourth copy of `"output violated its returns schema"` while creating the exact module that fixes it (#264's own nit, `tool-authoring-sugar.md:747`). `RETURNS_VIOLATION_PHRASE` now lives in `returns-violation.ts`; all four sites compose from it.

### Nits — all accepted

- `tools/check-model-facing-schemas.ts` added to the consumer inventory: it lints the toolsmith play's schemas and is wired into root `check`, so it gates a file this plan edits.
- D2 caveat test now extends the existing `returnDate` fixture (`playbook.test.ts:31-35`) instead of duplicating it.
- Toolsmith comment attribution corrected — "the capability detail page's Playbook section", per `agent.ts:157-161`, not "the dashboard's".

### Not changed

Nothing was rejected. The reviewer reported no unverifiable claims, and every anchor outside the four drifted ones was confirmed exact.

---

## Spec Review — Gate 1.5 re-check
<!-- written by: reviewer · gate 1.5 · /sdlc:critique · lens=mixed · rerun -->

**Target:** `.ai-docs/specs/playbook-authoring-parity.md` @ `395e551` (was `aa34c15`)
**Against:** cited code (re-verified @ `2411fc8`) + `git diff aa34c15..395e551`
**Verdict: PASS_WITH_NOTES**

**Both blockers are genuinely fixed, not waved at.** Every note and nit was actioned with a
real edit to a static section. The revision introduced four small defects of its own — one
factual, one omission, one stale cross-reference, one fresh citation drift — none gate-blocking.

### B1 — resolved

Correction #3 now separates the directions correctly and the mechanics check out.
`toolbox.ts:250-257` is exact and does what the spec says: it catches the tagged violation and
rethrows `new Error(…, { cause: err.cause })` with **no** marker property, so
`isReturnsViolation` is false at a calling play's catch. The tool-mediated sub-case is
therefore genuinely safe; the direct-`.execute()` sub-case is genuinely unsafe; the spec now
says exactly that. The "accept and document" decision is explicit and its rationale holds —
provenance on the tag would change the tool-side mechanism too, and direct `.execute()` also
bypasses parameter validation (`Toolbox.execute` parses at `:246`; `defineTool`'s wrapper does
not), so it is already off the supported path.

Both new test bullets are real and assert the right thing. I traced the first one: a play
calling `someToolbox.execute("x", …)` on a violating tool receives the untagged, tool-named
error, falls to the generic branch, and yields `{ error: "tool 'x' output violated its returns
schema: …" }` — tool-named, not play-named, as claimed.

### B2 — resolved

`playbook.ts:26-32` is now an explicit line item in the file plan with the `toolbox.ts:76-79`
mirror named. Verified `:76-79` is the tool-side sentence pair it points to.

### Notes/nits from pass 1 — all real

Release rhythm: **`0.14.0` confirmed** as core's current version on `origin/main` and in the
worktree, so `0.14.0 → 0.15.0` is right; `ci.yml:57-65` confirms the consequence verbatim
("publishes it IFF its version isn't already on npm — so merges without a version bump are
fast no-ops"). All four corrected anchors verified exact: `toolbox-executor.test.ts:118-122`,
`:146-159`, `toolsmith/agent.ts:163`, `sdk-bridge.ts:80-81`. `RETURNS_VIOLATION_PHRASE` is a
real hoist (module API + two file-plan rows + "all four construction sites compose from it").
The `authoring-a-toolbox.md` edit is narrowed with the three surviving non-goals named. Both
added tests are specific. `returnDate` reuse and the toolsmith attribution are corrected.
`tools/check-model-facing-schemas.ts` is in the inventory and its "wired into the root `check`
script" claim is confirmed at `package.json:20`.

New anchors introduced by the revision, verified: `toolbox.ts:250-257` ✅, `:76-79` ✅,
`agent.ts:157-161` ✅, `sdk-bridge.ts:79-84` ✅, `playbook.test.ts:31-35` ✅,
`tool-authoring-sugar.md:747` ✅.

**Blockers (0):** _None._

**Notes (4):**

- [`§ Scope and PR slicing` (spec:19)] The new justification contains a new factual error:
  "#332/#355 are **lockstep** release issues (runtime/server/cli) and **do not apply to
  core**." #332 is lockstep-only ✅, but **#355 is titled "release: TS lockstep+core bump for
  the cockpit arc (bump-both)"** and its body reads "`just bump-both` (core floats for
  `display`; runtime/server/cli lockstep carries n5/cancel/shim)" — it explicitly covers core.
  The *decision* is unaffected (the `175f59a`/`3d1a3a5` precedent carries it independently and
  both were verified), but the paragraph that fixed a wrong claim shipped another one. Drop
  the "do not apply to core" clause or restate it as "those are release-only PRs; a
  feature PR still carries its own core bump."

- [`§ File-by-file change plan` (spec:166+)] `bun.lock` is missing. Both cited precedents
  touched it in the same commit as the bump (`175f59a` and `3d1a3a5`, 4 lines each), and #355
  — the issue this spec now cites — states it as a **HARD RULE**: "`rm bun.lock && bun install`
  in the SAME commit as the version bump." The revision took on the bump without its
  companion; a `package.json`-only bump risks a lockfile-drift CI failure.

- [`§ Playbook.execute` (spec:162)] Stale cross-reference — the one place the revision did
  *not* update. It still reads "the untagged-rethrow concern from Correction #3 is satisfied
  structurally — nothing propagates." Correction #3 no longer raises an untagged-rethrow
  concern; it documents an **accepted, unmitigated** inbound residual, and the code block
  immediately above (`:154-157`) is precisely the branch that misattributes. A reader arriving
  at the code section concludes the issue is closed. Reword to name the outbound half only and
  point at Correction #3's accepted limitation.

- [`§ Corrections #3`, inbound sub-case 1] Fresh citation drift, introduced by the B1 fix:
  "This is the toolsmith pattern (`examples/agents/toolsmith/agent.ts:187-188`)". `:180-186`
  is the `parameters` object literal plus the `execute:` line and the args hand-cast; the
  `tools.execute(...)` calls that make it "the toolsmith pattern" are at **`:187-190`**
  (inside `Promise.all`, `:187-190`). Same class of error as the four just corrected.

**Nits (2):**

- [`§ Playbook.execute` (spec:156)] The illustrated code still hardcodes
  `` `play '${name}' output violated its returns schema: ${detail}` `` while § API design
  declares `RETURNS_VIOLATION_PHRASE` "the one copy of the user-facing phrase" and states all
  four sites compose from it. Compose it in the snippet too, or the implementer copies what
  they see.

- [`§ Scope and PR slicing` (spec:9-15)] The PR-slicing table wasn't updated alongside the file
  plan: `packages/agent-core/package.json` and `CHANGELOG.md` (and `bun.lock`, per above)
  appear in no row. Row 5 still lists only the three doc/comment files.

**Reviewed by:** reviewer agent · 2026-07-26 (re-check)

---

## Design Addendum 2 — response to Gate 1.5 re-check (PASS_WITH_NOTES)

Gate 1.5 cleared. All 4 notes and 2 nits fixed anyway — three of them were errors the *first* revision introduced, and a spec an implementer follows verbatim shouldn't ship known-wrong instructions just because the gate passed.

Each verified independently before acting, as with the first pass.

| Finding | Verified how | Fix |
|---|---|---|
| **N1** — the paragraph correcting a wrong claim shipped another one: #355 is *"release: TS lockstep+core bump for the cockpit arc (bump-both)"*, so it **does** cover core | `gh issue view 355` | Paragraph corrected; the bump decision is unchanged (it rests on `175f59a`/`3d1a3a5`, not on either issue) |
| **N2** — `bun.lock` missing from the file plan | Both precedent commits touch it; #355 states `rm bun.lock && bun install` in the same commit as a hard rule | Added to the file plan and the slicing table, with the rule quoted |
| **N3** — stale cross-reference at § `Playbook.execute` still claimed Correction #3 was "satisfied structurally" | Read against the revised Correction #3 | Rewritten: outbound is closed, **inbound is live in exactly that branch**, pointing at the accepted limitation and its two tests |
| **N4** — fresh drift from the B1 fix: `toolsmith/agent.ts:180-186` | `sed -n '185,191p'` — the `tools.execute(...)` calls are at `:187-188`; `:180-186` is the `parameters` literal | Corrected to `:187-188` |
| **Nit 1** — illustrated code hardcoded the phrase the API section declares as "the one copy" | Read both sections | Code block now composes from `RETURNS_VIOLATION_PHRASE` — the implementer copies what they see |
| **Nit 2** — slicing table omitted the release files | Read against the revised file plan | Row 6 added, marked **not** independently landable: without it core never publishes |

### Standing verdict

**PASS_WITH_NOTES → notes closed.** Gate 1.5 is cleared and the spec halts here for human review (Gate 1, strict mode — #266 carries `state:awaiting-strategy-review`).

Two things a reviewer should push on, because they are judgment calls rather than facts:

1. **D2's caveat is a real weakening.** "Validated" does not mean the delivered payload matches `returns`. It buys the metadata-only invariant for plain `PlayDefinition`s. If preserving that fixture matters less than the guarantee, D2 should flip — and that changes the design shape, not just a line.
2. **Correction #3's residual is accepted, not solved.** A play calling a definition's `.execute()` directly still gets misattributed. Fixing it properly needs provenance on the violation tag, which touches the tool-side mechanism too. Deferred deliberately; say so if that's the wrong call.

---

## Design Addendum 3 — rebase onto #385 (drop-CJS), and the lockfile rule corrected

Implementation landed while #385 (*drop CJS output, require Node >= 22*) was merging. Rebased onto it; no conflicts. Three corrections to the release section, all verified:

1. **Version retargeted `0.15.0 → 0.16.0`.** #385 already shipped core `0.15.0` on main, so the bump specified here collapsed into a no-op on rebase — this PR would have carried **no** version change and never published. Same failure the first Gate-1.5 pass caught, arriving by a different route: a stale target rather than a missing step.

2. **The `rm bun.lock && bun install` rule was wrong, and #385 proved it independently.** Following it regenerated every caret-ranged external dependency — `@anthropic-ai/sdk`, `@ai-sdk/anthropic`, `@ai-sdk/gateway`, `@hono/node-server`, rollup, and `@anthropic-ai/claude-agent-sdk` 0.3.215 → 0.3.220 with its 8 platform packages — turning a playbook-parity PR into a broad dependency bump. It also moved the SDK out from under `sdk-contract.test.ts`, whose drift detector fired correctly and was then silenced by editing the pinned fixture: the one guard designed to make such a move visible, disabled in the same commit that made it.

   `1335911` (#385) hit the identical drift from the same command and resolved it the same way. Rule replaced: touch only the workspace `version` fields. Verified against CI's actual command — `bun install --frozen-lockfile` exits 0.

3. **`shims: true` from #374 is gone from main, and that is the better outcome.** #385 dropped CJS output entirely, so the `createRequire(import.meta.url)` bug class is eliminated at the root rather than patched. The `check-dist-contract` guard added alongside that fix survived and was inverted by #385 — it now asserts the ESM entry loads *and* that no CJS artifacts are emitted.

**Standing verdict unchanged.** The design (D1–D5, the central invariant, Correction #3's accepted residual) is untouched by any of this; only the release mechanics moved.

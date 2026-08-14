# Implementation strategy — issue #521: `runtime+core: RunOptions.timeout`

**Size M (upper) · one PR from `hr/runner-5-timeouts`, STACKED on `hr/runner-4-model-params` (#514) · packages: runtime, core · plan-key `framework-hardening/runner-5`**

Fourth in the serialized agent-runner.ts stack (#496 → #504/PR #544 → #514/PR #545 → this). Depends on #504 (the abort forwarding + `isAbortRejection` this composes with), #514 (the call-site spread precedent), and #485 (docs-1 — see the delta below: its premise is unmet).

## Current state (verified on the stacked branch @ `72e7b47`)

- **SDK (installed `ai@7.0.58`):** `TimeoutConfiguration` is `number | { totalMs?, stepMs?, firstChunkMs?, chunkMs?, toolMs?, tools? }` (`dist/index.d.ts:597-604`), accepted as `timeout?:` by `generateText` and `streamText` (`:659/:4520/:5205/:6059`). **Delivery is signal-based, not a race** (Spec Review B1, probed): the SDK merges its timeout into the abort signal handed to `doGenerate` (`mergeAbortSignals`, `dist/index.js:2717`, wired `:5324-5330`) — a provider call that ignores its signal hangs regardless of `timeout`. Expiry on `streamText` surfaces as an **`abort` stream part** (B2, probed), which our drain already routes to `emitCancellation`. The SDK's native `timeout.toolMs` applies only where the SDK runs tools — i.e. our capable path's `convertExecutableTools`, whose tools DO carry `execute` (`:1414`); `convertTools`' execute-less invariant covers `run()`/`stream()` only (B4 correction).
- **Provider calls (post-#514 anchors):** `run()` `generateText` `agent-runner.ts:854`, `runStructured()` no-tools `:1617`, capable `:1677`, tier-2 `:1815`, `stream()` `streamText` `:2062`. All five already spread `...callParams` (#514) and forward `abortSignal` (#504).
- **Tool dispatch sites (3):** `run()` `:1087`, `convertExecutableTools.execute` `:1449`, `stream()` `:2521` — each `await toolExecutor.execute(name, args, this.buildToolCtx({...}))` inside a try/catch that already converts a throw into a structured `{ error }` result fed back to the model, plus an `agent.tool.end` carrying `error`.
- **Cooperative guards:** top-of-iteration `options?.abortSignal?.aborted` checks at `:819` (run) and `:2021` (stream); pre-dispatch at `:2449` (stream only); `runStructured()` pre-start at `:1518`.
- **Core seam:** `ToolExecutionContext` (`packages/agent-core/src/molecules/toolbox.ts:35`) — all-optional readonly fields, "core declares the slot, the host wires the meaning" (the `emit`/`host` precedent). No `signal` today.
- **`workflows/node-tool.ts:155`** documents "Per-subagent timeout is NOT forwardable today — no `RunOptions.timeout`" — this PR creates the field; forwarding is runner-6's, untouched here.
- **`AbortSignal.any` / `AbortSignal.timeout`:** available (Node ≥ 20 / 22 toolchain; already used by the #504 test suite for `AbortSignal.timeout`).

### Delta to the issue

- **The README Known-limitations section does NOT exist** — `grep -i limitation` over the root, runtime, and core READMEs finds nothing; #485 (docs-1) is still open, so "section exists" is premature. This PR **creates** a minimal `## Known limitations` section in `packages/agent-runtime/README.md` carrying the timeout line (unbounded-by-default + abandoned-promise caveat); docs-9's terminal sweep later owns the full section.
- Issue anchors `:606/:963/:1323/:2315` have drifted to `:678` (convertTools invariant) / `:1087` / `:1449` / `:2521` — same sites.

## Approach

### 1. `RunOptions.timeout` (runner/types.ts)

```ts
export interface RunTimeouts {
  /** Per-model-call budget → SDK `timeout` (native; no hand-rolled races).
   * On the capable structured path a "step" includes SDK-run tool
   * executions, so there it bounds model-call-plus-tools — see §2. */
  modelMs?: number;
  /** Per-tool-dispatch budget (hand-rolled race — see §3). */
  toolMs?: number;
  /** Whole-run wall-clock budget (checked at iteration boundaries + composed into the effective abort signal). */
  runMs?: number;
}
```

`timeout?: RunTimeouts` on `RunOptions`, exported from the runner barrel (the #514 lesson — the option's type must be nameable). Docstring: AgentRunner-only (same posture as `modelParams`); absent = today's unbounded behaviour; cooperative caveats per field (§3's abandonment, §4's boundary granularity).

### 2. `modelMs` → native SDK timeout

One resolver beside `_resolveCallParams`: `modelMs` present → **uniform `timeout: { stepMs: modelMs }` on all five calls** (Spec Review B3: `{totalMs}` on the capable path would meter the whole multi-step loop; the budget resets per step, probed). **Capable-path caveat (re-run-1 B1, probed):** in ai@7 a *step* = one model call PLUS the SDK-run tool executions it triggered, so at `:1677` `modelMs` bounds model-call-plus-tools per step — 4/5 sites get a true per-model-call bound; the capable path's is per-step. Consequence: `toolMs > modelMs` is silently capped by the step timer on that one path. ai@7 offers no model-call-only knob, so this ships as **documented semantics**: the `modelMs` docstring and the README line both state the capable-path step scope and the `toolMs ≤ modelMs` guidance. `firstChunkMs` deliberately NOT set (`stepMs` bounds it from above). Absent → no `timeout` key passed (not observable at the mock either way — B6 — omission proven behaviorally, Tests §7).

**Expiry semantics (deliberate, documented; corrected per B1/B2):** on the `generateText` paths a `modelMs` expiry is a per-call failure — the SDK's merged-signal rejection arrives with OUR effective signal unfired, so `isAbortRejection` says no and it routes through the EXISTING error path (`_gatewayAwareError` → `agent.error` → throw; `RunCancelledError` is NOT produced). On `stream()`, expiry arrives as the SDK's **`abort` stream part** and lands on the existing cancel path (`agent.message.cancel` + `conversation.end {reason:"cancelled"}`) — hand-rolling a divergent error surface there would mean re-implementing the SDK's stream lifecycle; accepted and documented as per-method semantics. One interaction pinned by test: when `runMs`'s derived signal has ALSO fired, an abort-shaped `modelMs` rejection passes `isAbortRejection` via the name leg — that is correct behavior (the run is over-deadline; it reports `"timeout"` per §4's discrimination).

### 3. `toolMs` → bounded dispatch, structured expiry, abandoned promise

Module-private in `agent-runner.ts`:

```ts
/** Thrown by withToolTimeout on expiry — a NAMED error so call sites and
 * tests can distinguish a timeout from a genuine tool failure. */
class ToolTimeoutError extends Error { /* name = "ToolTimeoutError"; carries toolName, ms */ }

/** Race `p` against `ms`; expiry REJECTS with ToolTimeoutError("Tool '<name>'
 * timed out after <ms>ms"). The losing promise is ABANDONED — never killed;
 * `ctx.signal` (§5) is the cooperative cancellation channel. Timer cleared
 * on settle (no open-handle leak). */
function withToolTimeout<T>(p: Promise<T>, ms: number, toolName: string): Promise<T>
```

Wrapped around the **three dispatch sites** only when `toolMs` is set. **Reject, don't resolve** (Spec Review B5): each site's existing `catch` converts the rejection into `toolResult = { error: err.message }` AND sets `errorMsg` — which is load-bearing: `stream()`'s terminal-tool exit keys on `errorMsg === undefined` (`:2554`), so a resolve-shaped expiry would make a timed-out TERMINAL tool's timeout message become the run's final response with a clean `agent.tool.end`. Rejection gets the intended shape — errored `agent.tool.end`, result fed back to the model, loop CONTINUES, errored-terminal accounting engaged — at zero call-site change. Uniform hand-rolled wrapper at all three sites (including inside `convertExecutableTools.execute`, which the SDK invokes): one consistent expiry surface; the SDK's native `timeout.toolMs` is deliberately NOT set (it would only cover the capable path, with SDK-owned semantics — divergence for no gain).

### 4. `runMs` → deadline + effective signal, "timeout" finishReason

- At each public method's entry, when `runMs` set: `deadlineAt = Date.now() + runMs` (used ONLY for the tier-1 remaining-budget arithmetic below — never for reason discrimination) and a derived `runSignal = AbortSignal.timeout(runMs)` (kept as its own reference) composed with the caller's signal: `effectiveSignal = AbortSignal.any([caller?, runSignal])`. The **effective** signal is what gets forwarded to provider calls and checked by `isAbortRejection` and the guards — one signal, all existing #504 machinery applies unchanged.
- **Reason discrimination is by SIGNAL IDENTITY, never by clock** (Spec Review note, measured: `AbortSignal.timeout(12)` fired with `Date.now()` advanced only 11ms in 1/40 trials — a `deadlineAt <= Date.now()` check misreports ~2.5% of expiries): `callerSignal?.aborted` → `"cancelled"` (explicit cancel wins when both fired — pinned by test); else `runSignal.aborted` → `"timeout"`. No `Date.now()` anywhere in the discrimination.
- `run()`: top-of-iteration guard checks the effective signal; both the boundary route and the in-flight `isAbortRejection` route feed the EXISTING shared cancelled return with the discriminated reason: `finishReason: "timeout"` (a `string` field — no type change); `agent.llm.end {finishReason:"cancelled"}` stays as-is on the in-flight route (no new event vocabulary, pinned).
- `stream()`: same guard; routes through the existing `emitCancellation` path → `agent.message.cancel` + `agent.conversation.end {reason:"cancelled"}` (pinned: maps to `"cancelled"`, no vocabulary change).
- `runStructured()`: the effective signal composes into its existing #504 normalization — expiry lands as `RunCancelledError` after the terminal cancelled `message.complete` (message text gains a timeout variant; no structural change). **The 2-tier delegate must NOT re-derive a fresh budget** (Spec Review note: tier-1's `{...options}` spread would grant run() its own full `runMs`, letting the wall clock reach pre-tier-1 time + `runMs`): the tier-1 call overrides `timeout: { ...timeout, runMs: remaining }` where `remaining` is computed once from the outer deadline (`max(1, deadlineAt - Date.now())` — the ONE permissible Date.now() use, budget arithmetic not reason discrimination). **And the tier-1 result check must catch the new reason** (re-run-1 B2): `:1771`'s exact-match `if (tier1.finishReason === "cancelled")` becomes `=== "cancelled" || === "timeout"` — otherwise a timed-out tier-1 (`response: ""`) falls into the empty-tier-1 guard at `:1810`, throwing a bare misleading `Error` instead of `RunCancelledError` and skipping `emitCancelledTerminal()`, the exact finalization gap #504 closed. Test 5a pins it.
- `run()`'s shared cancelled return: BOTH the `RunResult.finishReason` AND the terminal `agent.message.complete.finishReason` (`:1320`) carry the discriminated reason (`"timeout"` on deadline expiry) — `RunStoreExporter` records `message.complete.finishReason` as the row's terminal reason, so the two must agree.

### 5. Core: `ToolExecutionContext.signal` (additive; core floats)

`readonly signal?: AbortSignal;` added to `molecules/toolbox.ts` with the emit/host precedent doc ("core declares the slot, the host wires the meaning; cooperative-only — the runner never kills a tool"). `buildToolCtx`'s param object (`:463-478`) gains `signal?: AbortSignal`, and `convertExecutableTools`' ctx (`:1394-1402`) threads `toolMs` + the effective signal through so its in-closure dispatch composes identically — both file-level touch points named here so the plan is complete (re-run-1 note). `buildToolCtx` populates `ctx.signal` **only when `toolMs` is set**: a per-dispatch `AbortSignal.timeout(toolMs)` composed via `AbortSignal.any` with the run's effective signal — so a timed-out (or run-aborted) dispatch observes `ctx.signal.aborted === true` and can stop cooperatively. When `toolMs` is unset the field is omitted entirely — DELIBERATE consequence, stated in docs: under `runMs` alone a blocked tool is not interrupted (the deadline is honored at the next boundary); wiring the run signal without `toolMs` expands the acceptance surface and is deferred. Composition code is written against real signatures: `AbortSignal.any(caller ? [caller, derived] : [derived])` — the optional-member array literal in earlier drafts was pseudocode.

### 6. Docs

- `runner/types.ts` docstrings (`timeout` + a cross-reference from `abortSignal`'s doc to the composed effective signal; the capable-path per-step scope of `modelMs`; the `toolMs ≤ modelMs` guidance). `abortSignal`'s own doc must also go CONDITIONAL where it flatly asserts `finishReason: "cancelled"` / `message.complete {finishReason:"cancelled"}` — once `runMs` exists those read `"cancelled"` or `"timeout"` per the discrimination.
- `packages/agent-runtime/README.md`: NEW minimal `## Known limitations` section — unbounded-by-default without `timeout`; expiry abandons (never kills) in-flight promises; `ctx.signal` is cooperative-only; **`modelMs`/`runMs` only interrupt providers that honor `abortSignal`** (signal-based delivery); under `runMs` alone a blocked tool waits for the next boundary. (Delta from the issue: the section didn't exist; docs-9 owns the eventual sweep.)
- `docs/runners.md` §2.5 item 7 (`:99`): extend the abortSignal sentence with `RunOptions.timeout` composing into the same effective signal (the prior-round note left unaddressed).
- CHANGELOG Unreleased → Features.
- Per-subagent forwarding explicitly out of scope (runner-6): leave `node-tool.ts:155`'s comment BUT update its parenthetical from "no `RunOptions.timeout`" to "…exists since #521 but is not forwarded here" — the sentence is otherwise false the moment this merges.

## Tests (`agent-runner-timeouts.test.ts`)

Sibling-idiom fixtures (V3 mocks, prompt-keyed scripting; `vi.useFakeTimers` NOT used — the SDK's own timers must fire, keep budgets ≤ 100ms):

1. **`modelMs` reaches every provider call natively** — the #504 **hang-until-abort** fixture (settles ONLY when the signal the provider call receives fires; the SDK's timeout delivery is signal-based per B1, so a hang-forever fixture would just hang) + `modelMs: 50` and NO caller signal: the only thing that can fire that signal is the SDK's own timer, so settling at all proves `timeout` was delivered. `run()` and `runStructured()` no-tools then REJECT via the error path (`agent.error` emitted; NOT `finishReason:"cancelled"`, NOT `RunCancelledError` — our effective signal never fired); `stream()` ends via the SDK's `abort` part on the cancel path (`conversation.end {reason:"cancelled"}`, no `agent.error`) — per-method semantics pinned exactly as §2 documents. Capable-path variant uses a capable model id (`"gemini-3.5-flash"` — an unknown id would silently route to the 2-tier path and never reach `:1677`), and adds the ONE guard the documented step semantics gets: fast model call + slow SDK-run tool under `modelMs` → the step itself rejects (pinning that the tool burns the step budget there, exactly as §2 documents).
2. **`toolMs` expiry** — never-resolving `toolExecutor` + fast tool-call→text script: structured error in `agent.tool.end`, model sees it, run COMPLETES normally; nothing thrown; `result.toolCallsCount` counts the timed-out dispatch.
3. **`ctx.signal`** — executor captures `ctx.signal`; after expiry it reports `aborted === true`; with `timeout` absent, `ctx.signal` is absent (own-property check on the ctx we build — ours, not the SDK's).
4. **`runMs` boundary expiry** — per-iteration tool loop with `runMs` shorter than two iterations: `run()` returns `finishReason: "timeout"`; `stream()` yields `message.cancel` + `conversation.end {reason:"cancelled"}` and no `message.complete`.
5. **`runMs` in-flight expiry** — hang-until-abort `doGenerate` (the #504 fixture) + `runMs: 50`, no caller signal: `run()` resolves `finishReason: "timeout"` (not `"cancelled"`), the terminal `message.complete` also says `"timeout"`, `agent.llm.end {finishReason:"cancelled"}`, no `agent.error`.
   5a. **2-tier tier-1 timeout** (re-run-1 B2) — tools + `"test-model"` (unknown → 2-tier by construction) + `runMs` expiring during tier-1: `runStructured()` throws `RunCancelledError` (NOT the empty-tier-1 `Error`); the assertion targets `emitCancelledTerminal()`'s `message.complete {finishReason:"cancelled"}` on the bus (two terminals may appear — tier-1's own plus this one; RunStoreExporter is first-terminal-wins, harmless, and the test asserts presence, not count).
6. **Caller abort still wins as "cancelled"** — caller aborts before `runMs` expires → `finishReason: "cancelled"` (pins the reason discrimination).
7. **Omission (behavioral — B6: `timeout` is consumed by the SDK before `doGenerate`, so it is not observable at the mock at any level)** — no `timeout`: a hang-until-abort `doGenerate` with no caller signal is still pending after 200ms (no timer was configured; clean up by aborting a test-owned controller); tool ctx has no `signal` key (own-property check on the ctx WE build); existing suites are the no-regression guard (97/27/3/8/9 must hold).

## Acceptance (from the issue, restated)

- [ ] `bun run check` green
- [ ] `modelMs` reaches every provider call as an SDK `timeout` (behavioral proof via the signal-observing fixture — B1)
- [ ] Never-resolving executor under `toolMs` → structured tool-error + `agent.tool.end` with error + completing run (on the `run()`/`stream()` dispatch paths; on the capable path the shared step timer can fire first and surface as the step's own error — documented, and `toolMs ≤ modelMs` is guidance, not a sufficiency guarantee there)
- [ ] `runMs` expiry → `finishReason: "timeout"` + `conversation.end {reason:"cancelled"}` (stream); reason discrimination by signal identity, caller-cancel wins
- [ ] `ctx.signal` aborted for the timed-out tool; documented cooperative-only
- [ ] Omitting `timeout` leaves behaviour byte-identical (behavioral proof — B6: not observable at the mock)
- [ ] README Known-limitations line added (section created — see delta)
- [ ] `bun run --filter=@pattern-stack/agentic-core typecheck` green (core is touched — its own gate, not just the workspace sweep)

## Design Addendum (post Spec Review, re-run 1)

All six blockers incorporated: (B1) the SDK-timeout model corrected to signal-based delivery — Test 1 now uses the #504 hang-until-abort fixture, where settling proves delivery; (B2) `stream()` modelMs expiry re-documented as landing on the cancel path via the SDK's `abort` part — §2's error-path claim is now scoped to the `generateText` methods; (B3) uniform `{ stepMs: modelMs }` on all five calls — `{totalMs}` would meter the capable path's whole multi-step loop; (B4) the execute-less premise re-scoped to `convertTools` — `convertExecutableTools` DOES carry `execute`, and the spec now deliberately keeps the hand-rolled wrapper there instead of the SDK's `toolMs` (one consistent expiry surface); (B5) `withToolTimeout` rejects with a named `ToolTimeoutError` instead of resolving — the existing catches produce the structured shape and `errorMsg`, keeping `stream()`'s terminal-tool exit correct at zero call-site change; (B6) both omission-shaped assertions (Test 7 + acceptance) moved to behavioral proofs since the SDK consumes `timeout` before the mock.

Notes folded in: reason discrimination moved entirely to signal identity (caller wins), eliminating the measured 1/40 early-fire clock race; the 2-tier delegate now threads the REMAINING `runMs` into tier-1 instead of re-deriving a full budget; the `modelMs`×`runMs` name-leg interaction pinned as correct-by-design in §2.

## Design Addendum (re-run 2)

Re-run-1's two blockers incorporated: (B1) the capable path's `stepMs` scope — a step is model call PLUS SDK-run tools — ships as documented semantics in §2, the docstring, and the README (`toolMs ≤ modelMs` guidance; ai@7 has no model-call-only knob); (B2) the tier-1 result check widens to `"cancelled" || "timeout"` so a timed-out tier-1 produces `RunCancelledError` + the cancelled terminal, not the misleading empty-tier-1 `Error` (Test 5a pins it). Notes: `message.complete.finishReason` explicitly carries the discriminated reason on `run()`'s shared return; README gains the signal-honoring-providers caveat and the runMs-alone blocked-tool caveat; `runners.md` item 7 gets the timeout-composition sentence; `buildToolCtx` + `convertExecutableTools` ctx extensions named as file-level touch points; capable-path test pinned to `"gemini-3.5-flash"`; `AbortSignal.any` written against real signatures; `node-tool.ts` anchor corrected to `:155`; core per-package typecheck added to acceptance.

## Spec Review
<!-- written by: reviewer · gate 1.5 · /sdlc:critique · lens=mixed -->

**Target:** `.ai-docs/specs/521-timeouts.md` (pre-implementation, **re-run 2** — post Design Addendum (re-run 2))
**Against:** cited code @ `72e7b47` + installed `ai@7.0.58` (blocker-fix re-check; both fixes re-verified against the tree and the SDK dist)
**Verdict:** PASS_WITH_NOTES

Focused re-check of re-run-1's two blockers. **Both are correctly specified.**

- **B1 (capable-path `stepMs` scope) — RESOLVED as documented semantics.** §2 now states the step =
  model call + SDK-run tools, names `:1677` as the one per-step site (4/5 truly per-model-call), and
  states the `toolMs > modelMs` cap + the `toolMs ≤ modelMs` guidance; §6 routes the caveat into both
  the docstring and the README. Re-verified in the dist: the step timer is armed per do-while iteration
  (`ai/dist/index.js:5504`) and cleared only in the `finally` that wraps the whole step span
  (`:5965-5967`), so tool execution is inside the budget — the spec's model is right. Also re-checked
  the "4/5" claim independently: `run()` (`:854`) and `stream()` (`:2062`) pass execute-less tools with
  no `stopWhen`, and `stream()` dispatches tools only AFTER its `for await` drain ends (`:2109` → `:2521`),
  so their step really is one model call; `:1617`/`:1815` are no-tools. The count holds.
- **B2 (tier-1 `"timeout"` past the exact-match check) — RESOLVED.** `:1771` is still exactly
  `if (tier1.finishReason === "cancelled")` and is still the sole caller of `emitCancelledTerminal()` +
  sole thrower of `RunCancelledError` on that path; the fall-through to the empty-tier-1 `Error` at
  `:1810` is confirmed verbatim. Widening to the `"cancelled" || "timeout"` set is also SAFE against
  false positives: the SDK's unified finish reasons are
  `stop|length|content-filter|tool-calls|error|other|unknown` (`@ai-sdk/provider:4512`) — `"timeout"`
  can only come from this PR's own discrimination. Test 5a pins it. Anchor audit: `:1771`, `:1810`,
  `:1320`/`:1331` (shared cancelled return), `:1607` (`emitCancelledTerminal`), `:884`
  (`agent.llm.end`, unchanged per §4), `:463-478` (`buildToolCtx` params), `:1394-1402`
  (`convertExecutableTools` ctx), `capabilities.ts:380` (`gemini-3.5-flash`), `docs/runners.md:99`
  (item 7), `types.ts:59` (`finishReason: string`), `run-store.ts:214-216` (first-terminal-wins) — all EXACT.
  Grep for other exact-match `finishReason === "cancelled"` consumers in `packages/*/src`: `:1771` is
  still the only one (the one other hit is a test predicate).

No new contradiction was introduced by the re-run-2 edits. The six notes below are precision gaps in the
newly written text — none blocks implementation.

**Blockers (0):** — none.

**Notes (6):**

- [`§1` code block] **The `modelMs` docstring in §1 is the one place the caveat did NOT land.** It still
  reads `/** Per-model-call budget → SDK timeout (native; no hand-rolled races). */` — verbatim the text
  blocker 1 said "would ship wrong". §2 and §6 both say the docstring must carry the capable-path step
  scope, so the spec as a whole directs the right thing, but §1's snippet is what an implementer copies.
  Inline the caveat into the snippet (or mark it "see §2 for the shipped text").
- [`Tests 1`, capable variant / `Acceptance`] **The newly documented semantics has no test pinning it.**
  Blocker 1's fix asked (iii) that the capable variant assert the step scope (slow SDK-run tool expiring
  under `stepMs`); the variant now only names the model id and otherwise asserts the same
  delivery-proof as the other four. Since B1 is resolved by documentation, that assertion is the only
  guard the claim gets. Add a leg: capable model + a slow SDK-run tool + `modelMs` → the step rejects
  though the model call was fast.
- [`Acceptance` line 3 / `§2` / `§3`] **The `toolMs` acceptance line is unconditional but does not hold on
  the capable path.** "Never-resolving executor under `toolMs` → structured tool-error + completing run"
  is true at `:1087` and `:2521`; at `:1449` under a capable model, once the step timer fires first the
  whole `generateText` REJECTS — with no `runMs`/caller signal, `isAbortRejection` is false (`:156` needs
  `signal.aborted`), so it routes to `agent.error` + throw, i.e. no structured tool error, no continuing
  loop. §2's word "capped" understates that: it is a different failure surface, not a shorter tool
  budget. Also, capping starts below `modelMs` (the step budget is shared with the model call), so
  `toolMs ≤ modelMs` is necessary but not sufficient. Scope the acceptance line to the two hand-rolled
  sites and say so in §3.
- [`§4`] **`deadlineAt` is referenced but no longer defined.** The tier-1 remaining-budget rule computes
  `max(1, deadlineAt - Date.now())`, but re-run-1's edit deleted `deadlineAt = Date.now() + runMs` from
  §4's first bullet (replaced by the signal-identity rule). State that entry still records `deadlineAt`
  for budget arithmetic only — otherwise §4 reads as "no `Date.now()`" while requiring one.
- [`§4` / `Tests 5a` / `agent-runner.ts:1607`] **Which reason `runStructured`'s terminal `message.complete`
  carries under a tier-1 timeout is unpinned.** §4 now pins `run()`'s terminal to the discriminated reason
  (`:1320`), but on the 2-tier path tier-1's `run()` emits its own terminal AND `emitCancelledTerminal()`
  (`:1607`) emits a second one with the literal `"cancelled"`. Test 5a says "a terminal cancelled
  `message.complete`" without naming the string. `RunStoreExporter` is first-terminal-wins
  (`run-store.ts:216`), so when the caller passes `runId` the tier-1 `"timeout"` event wins and `:1607`'s is
  dropped; when it doesn't, they are separate rows. Harmless either way, but Test 5a needs to know which
  event it is asserting on.
- [`§6` / `runner/types.ts:207-214`] **The `abortSignal` docstring's own claims go stale and §6 only asks
  for a cross-reference.** It asserts flatly that `run()` returns `finishReason: "cancelled"` and emits
  `message.complete {finishReason:"cancelled"}` — both become conditional once `runMs` can produce
  `"timeout"`. `docs/runners.md` item 7 got exactly this treatment (§6 bullet 3); the docstring should get
  the same qualification, not just a pointer to the effective signal.

**Nits (2):**

- [`§ Current state`, bullet 5] The `node-tool.ts` anchor is **still `:151`** (the sentence is at `:155`).
  §6 was corrected and the re-run-2 Addendum claims "anchor corrected to `:155`", but the Current-state
  bullet was missed — third round for this one.
- [`Tests 5a`] "unknown model" would benefit from the same explicitness Test 1's capable variant just
  gained — name the id (the sibling fixtures' `"test-model"` is unknown, hence 2-tier), so the test can't
  silently take the capable path and skip `:1771` entirely.

<details>
<summary><strong>Superseded — re-run 1 verdict (REVISE, 2 blockers / 6 notes / 3 nits), retained for history</strong></summary>

_Both blockers are resolved by the Design Addendum (re-run 2); all six notes and all three nits are folded
in except the `node-tool.ts` anchor (carried forward as a nit above)._

Re-run scope: all six prior blockers are genuinely addressed and four of five prior notes are folded in.
Re-probed against `ai@7.0.58`, the addendum's claims land as follows —
(b) **CONFIRMED**: `hangUntilAbort(options.abortSignal)` under `timeout:{stepMs:50}` with NO caller signal
rejects at **50ms** with `DOMException` named `TimeoutError` ("Step timeout of 50ms exceeded"); with
`output: Output.object(...)` too (60ms). Test 1's mechanism is proven, and `isAbortRejection(e, undefined)`
returns `false` (`:157`), so the error-path routing §2 describes is correct.
(c) **CONFIRMED**: all three dispatch sites are `try { … } catch (e) { toolResult = {error: err.message};
errorMsg = err.message }` (`:1106-1110`, `:1466-1470`, `:2540-2544`); `convertExecutableTools.execute`
resolves `toJsonValue(toolResult)` after its catch (`:1489`), so a rejecting `withToolTimeout` composes at
zero call-site change on all three, exactly as B5's fix claims.
(d) **CONFIRMED sound** for the four reachable combinations (modelMs-only, runMs-only, both-fired,
caller-wins); no remaining hole in the discrimination itself.
(e) **type/shape-sound** (`{...timeout, runMs: remaining}` is assignable to `RunTimeouts`) — but its
*consequence* is not handled downstream (Blocker 2).
(a) is **PARTLY FALSE** (Blocker 1) — `stepMs` is not a per-model-call bound at `:1677`.

Anchor audit (re-verified): every code anchor still EXACT — `:854`/`:1617`/`:1677`/`:1815`/`:2062` (provider calls),
`:1087`/`:1449`/`:2521` (dispatch), `:819`/`:1518`/`:2021`/`:2449` (guards), `toolbox.ts:35`,
`RunResult.finishReason: string` (`types.ts:59`, so `"timeout"` needs no type change).
The README delta is correct — no `limitation` match in root/runtime/core READMEs.

The map of the code is still accurate. The two blockers below are, again, in the SDK model
(one probed-false semantics claim) and in a terminal-detection seam the addendum's own fix opened.

**Blockers (2):**

- [`§2` / `§1` docstring / `Tests 1` capable variant / `agent-runner.ts:1677`] **`{stepMs: modelMs}` is
  not a per-model-call bound on the capable path — B3's replacement claim is false at 1 of the 5 sites.**
  In `ai@7` a *step* is one model call **plus the SDK-run tool executions it triggered**, and `stepMs`
  meters the whole step. Probed: model call 10ms, SDK-run tool 120ms, `timeout:{stepMs:60}`,
  `stopWhen: stepCountIs(10)` → `DOMException("Step timeout of 60ms exceeded")` at **143ms**, `calls===1`
  — the model call never came within 50ms of the budget; the *tool* burned it. (Two controls: the budget
  DOES reset per step — 3 steps x 40ms model under `stepMs:60` completes at 125ms, so B3's core fix is
  real and `{totalMs}` was correctly rejected; and the step timer's signal reaches the tool's own
  `execute(_, {abortSignal})` — a tool observing it sees `aborted===true` at 50ms.) So `:854`, `:1617`,
  `:1815`, `:2062` get a true per-model-call bound and `:1677` gets a per-model-call-**plus-tools** bound.
  §2's "`stepMs` bounds each model call identically everywhere" and the Addendum's B3 line are both
  overstated, and the `modelMs` docstring §1 promises ("Per-model-call budget") would ship wrong.
  Two concrete consequences the spec does not acknowledge: (1) `modelMs: 30_000, toolMs: 120_000` — a 100s
  tool succeeds on `run()`/`stream()` but aborts the entire step at 30s on a `runStructured()` capable-model
  run, the same option behaving differently under the same opaque capability table B3 was raised about;
  (2) `withToolTimeout(toolMs)` at `:1449` is silently capped — `toolMs > modelMs` is unenforceable there,
  because the SDK's step timer fires first and rejects the whole `generateText`. · _Fix:_ keep `{stepMs}`
  (ai@7 has no model-call-only knob — this is still the right mapping), but (i) restate §2 and the §1
  docstring as "per model call; on the capable single-call path (`:1677`) this is the SDK **step** budget,
  which also covers SDK-run tool execution"; (ii) document `toolMs` as effectively `min(toolMs, modelMs)`
  on that one path; (iii) make Test 1's capable-path variant assert *that* semantics (slow-tool step
  expiring under `stepMs`) rather than the vague "stepMs (not totalMs) semantics survive".
- [`§4` / `agent-runner.ts:1771`] **The tier-1 remaining-budget fix leaks a `finishReason` that
  `runStructured()`'s terminal detector cannot see** — B5's failure mode, one layer up. §4 now threads
  `timeout: {...timeout, runMs: remaining}` into the tier-1 `this.run(...)` (`:1755`), so tier-1 can return
  `finishReason: "timeout"`. But the only handler is `if (tier1.finishReason === "cancelled")` (`:1771`) —
  an exact string compare — and it is the sole caller of `emitCancelledTerminal()` **and** the sole thrower
  of `RunCancelledError` on this path. With `"timeout"` it is skipped. The shared cancelled return sets
  `response: ""` (`:1322`), so control falls through the `terminal_tool` branch (`:1781`) into the
  empty-tier-1 guard (`:1810`) and throws a bare
  `Error('runStructured: 2-tier fallback got empty tier-1 output (finishReason="timeout") — the tool loop
  likely hit maxIterations before producing an answer. Raise maxIterations or simplify the step.')`.
  Three defects in one path: wrong error type (not `RunCancelledError`, breaking #504's contract and §4's
  own "expiry lands as `RunCancelledError`"), a flatly misleading message pointing at `maxIterations`, and
  **no terminal event** — the exact finalization gap flagged at `:1591`, so the run-store row stays
  `'running'` forever. · _Fix:_ widen `:1771` to the cancelled SET (`=== "cancelled" || === "timeout"`),
  give `RunCancelledError` the timeout-variant message §4 already promises, and add a test pinning
  tier-1 timeout → `RunCancelledError` + a terminal `message.complete`. Audit for any other exact-match
  `finishReason === "cancelled"` consumer before merge (this is the only one in `packages/*/src`).

**Notes (6):**

- [`§4` / `agent-runner.ts:1320`] **Which `finishReason` the emitted `agent.message.complete` carries is
  unspecified.** §4 pins the RunResult (`"timeout"`) and pins `agent.llm.end` (`"cancelled"`, unchanged),
  but the shared cancelled block emits `message.complete {finishReason:"cancelled"}` (`:1320`) from the
  same literal that produces the return value (`:1331`) — and that event is what `RunStoreExporter` records
  as the run's terminal `finishReason` (`exporters/run-store.ts:179`/`:225`). Left open, "cancelled" makes
  `RunResult` and the persisted run disagree while "timeout" is new vocabulary on a pinned event with no
  test. Acceptance line 4 doesn't cover it either. Pin one and assert it in Tests 4/5.
- [`§6` / README] The caveat blocker-1's fix asked for is **still missing from the Known-limitations
  content list**. §Current-state states it ("a provider call that ignores its signal hangs regardless of
  `timeout`" — measured PENDING at 509ms in re-run 0), but §6 enumerates only three README bullets and
  none is "`modelMs` only binds providers that honor `abortSignal`". That is the single most surprising
  property of the knob and the reason the section is being created.
- [`§6`] **Prior note 5 is unaddressed** — the Addendum's "notes folded in" list doesn't mention it and §6
  is unchanged. `docs/runners.md` §2.5 is the gated single source of truth and both stacked predecessors
  recorded there (#514 → item 2, #504 → item 7). Item 7 currently reads "On an in-flight abort, `run()`
  returns `finishReason: \"cancelled\"`" (`docs/runners.md:99`) — incomplete the moment `run()` can return
  `"timeout"` and the forwarded signal becomes a composed effective signal.
- [`§1` / `§5`] **Prior note 4 is only half-addressed.** §1's docstring is now "checked at iteration
  boundaries + composed into the effective abort signal" — better, but it still doesn't tell the reader
  that a **blocked tool is not interrupted**: §5 wires `ctx.signal` only when `toolMs` is set, so a
  `runMs`-only run that blocks in a never-returning tool exceeds its budget without bound. Either wire the
  effective signal into `ctx.signal` whenever `timeout` is set, or say so in the docstring.
- [`Tests 1`, capable variant] The variant needs a model id the capability map marks capable — `gpt-4o`,
  `gpt-5`, or `gemini-3.5-flash` (`providers/capabilities.ts:264`/`:283`/`:380`). The sibling fixtures use
  `"test-model"`, which routes to the 2-tier path, so as written the variant would silently never reach
  `:1677` and its assertion would be vacuous. Name the id in the test plan.
- [`§3` / `§5` plumbing] The two seams `withToolTimeout` and `ctx.signal` need are not in the file-level
  plan. `convertExecutableTools`'s `ctx` param (`:1394-1402`) carries only
  `{bus, traceId, runId, parentSpanId, host?, publishArtifacts?}` — no `toolMs` — and `buildToolCtx`'s arg
  object (`:463-478`) has no `signal`. Both must be extended for §3's third site and §5 to exist. Cheap,
  but it's the one plumbing change the spec doesn't name.

**Nits (3):**

- [`§ Current state`, bullet 5] The `node-tool.ts` anchor is **still `:151`**; the "Per-subagent timeout is
  NOT forwardable today" sentence is at `:155` (flagged in re-run 0, unfixed). §6's instruction to edit
  that parenthetical inherits the stale anchor.
- [`§4`] `AbortSignal.any([caller?, runSignal])` is shorthand that doesn't survive literally —
  `AbortSignal.any([undefined, sig])` throws `TypeError: The "signals[0]" argument must be an instance of
  AbortSignal`. The caller-absent case needs a filtered array (or the bare `runSignal`).
- [`Acceptance`] Re-run 0's nit — keep `bun run --filter=@pattern-stack/agentic-core typecheck` in the
  acceptance list, since `AbortSignal` resolves in core only incidentally (no `@types/node` declared,
  `lib: ["ES2022"]` with no `DOM`) — is still not in the list.

</details>

<details>
<summary><strong>Superseded — re-run 0 verdict (REVISE, 6 blockers / 5 notes / 3 nits), retained for history</strong></summary>

_All six blockers below are resolved by the Design Addendum; notes 1, 2 and 3 are folded in, note 4 is
partially folded (carried forward above), note 5 is not (carried forward above)._


**Blockers (6):**

- [`§2` / `Tests 1`] The SDK's `timeout` is **signal-based, not a race**: it merges
  `AbortSignal.timeout(ms)` into the call's abort signal (`ai/dist/index.js:5324-5330`,
  `mergeAbortSignals` `:2717`) and hands it to the provider. Probed: a `doGenerate` that
  ignores `options.abortSignal` under `timeout:{totalMs:50}` was still **PENDING after 509ms**.
  Test 1's fixture ("hang-forever `doGenerate` (never observes any signal) + `modelMs:50` →
  rejects promptly") cannot pass — it hangs to the vitest timeout. · _Fix:_ use the #504
  `hangUntilAbort(options.abortSignal)` fixture (settles only when the merged signal fires) and
  assert the rejection is `DOMException` named `TimeoutError`; add the "only binds providers that
  honor `abortSignal`" caveat to the Known-limitations line.
- [`§2` / `Tests 1` stream leg] **A `streamText` timeout expiry does not throw.** Probed with both
  `{stepMs:40}` and `{totalMs:40}`: the `.stream` the runner drains (`agent-runner.ts:2110`) yields
  `["start","abort"]` and never rejects. `case "abort"` (`:2248`) sets `aborted=true` →
  `emitCancellation()` (`:2334-2346`) → `conversation.end {reason:"cancelled"}`, no `agent.error`,
  no throw. §2's "surfaces through the EXISTING error path → `agent.error` → throw, NOT as a cancel"
  is **exactly inverted** for `stream()`. · _Fix:_ state the stream semantics honestly (modelMs
  expiry on `stream()` is a cancel) or add an `abort`-part discriminator; either way Test 1's
  stream leg must be rewritten.
- [`§2` mapping @ `agent-runner.ts:1677`] `{totalMs: modelMs}` is **not a per-model-call budget** on
  the capable path: that call carries `stopWhen: isStepCount(options?.maxIterations ?? 10)` AND
  executable tools, so one `totalMs` timer meters up to 10 model calls **plus every SDK-run tool
  execution**. `modelMs: 30_000` would mean "30s per call" on `run()` and "30s for the whole
  10-step loop" on `runStructured()` of a capable model — same option, wildly different budget,
  switched by an opaque capability table. · _Fix:_ use `{stepMs: modelMs}` at `:1677`. `stepMs` was
  probed working on `generateText` too ("Step timeout of 50ms exceeded" at 49ms), so a uniform
  `{stepMs: modelMs}` across all five sites is the simplest correct mapping.
- [`§ Current state`, bullet 1] **"tools are `execute`-less (gate-chain invariant)" is false for one
  of the three dispatch sites the spec itself lists.** It holds for `convertTools` (`:698`) but not
  `convertExecutableTools` (`:1391`), whose `execute:` (`:1414`) *is* the `:1449` site. So the SDK's
  native `timeout.toolMs`/`timeout.tools` **does** apply there, and `withToolTimeout` would race a
  native mechanism the spec dismissed as unreachable. · _Fix:_ restate the invariant per-path and
  decide explicitly whether `:1449` uses native `toolMs` or the hand-rolled race — not both.
- [`§3`] **`withToolTimeout`'s resolve-shape does not match any of the three sites.** All three are
  `try { toolResult = await execute(...) } catch { toolResult = {error: msg}; errorMsg = msg }`
  (`:1085-1110`, `:1443-1470`, `:2519-2544`). A helper that RESOLVES cannot set the caller's
  `errorMsg` local, so §3's "`toolResult = {error: …}`, `errorMsg` set" is unachievable as written.
  Concrete failure: `stream()`'s terminal-tool exit is keyed on
  `!terminalFired && errorMsg === undefined && terminalTools.has(tc.toolName)` (`:2554`) — a
  timed-out **terminal** tool would resolve `{error:"…timed out…"}` with `errorMsg` still
  `undefined`, so `terminalFired=true` and **the timeout message becomes the run's final response**,
  while `agent.tool.end` carries `error: undefined`. `run()` has the analogous keying at `:1151`.
  · _Fix:_ have `withToolTimeout` **reject** with an `Error` — the existing catch then produces the
  identical `{error}` + `errorMsg` at zero call-site change — or return `{result, errorMsg}` and
  destructure at all three sites.
- [`Tests 7` / `Acceptance` line 6] **`timeout` is not observable "value-level at the mock."** Probed
  `doGenerate` option keys under `timeout:{totalMs:5000}`:
  `[abortSignal, frequencyPenalty, headers, maxOutputTokens, presencePenalty, prompt,
  providerOptions, reasoning, responseFormat, seed, stopSequences, temperature, toolChoice, tools,
  topK, topP]` — `Object.hasOwn(options,"timeout") === false`. Unlike `modelParams` (whose keys all
  appear in that list), `timeout` is consumed by the SDK into the merged abort signal and never
  reaches the model, so the #514 posture does not transfer and the assertion is vacuous either way.
  · _Fix:_ drop the value-level claim for `timeout`; assert omission behaviorally, or assert on a
  spied `generateText`'s args.

**Notes (5):**

- [`§4`] The deadline discrimination has a **measured clock race**. Over 40 trials,
  `AbortSignal.timeout(12)` fired when `Date.now()` had advanced only 11ms in **1/40** runs
  (delta `-1`). At the instant the derived signal fires, `deadlineAt <= Date.now()` is therefore
  false ~2.5% of the time, so a genuine `runMs` expiry reports `finishReason: "cancelled"` instead
  of `"timeout"` — Tests 4/5/6 would be flaky at that rate. Discriminate by **signal identity**
  (hold the derived `AbortSignal.timeout(runMs)` and test `derived.aborted`, or latch the reason in
  an `abort` listener), never by a clock comparison.
- [`§2`] "`isAbortRejection` requires *our effective signal* to have fired" is unqualified and stops
  holding once `runMs` is also set. `ABORT_ERROR_NAMES` contains `"TimeoutError"` (`:145`) and the
  SDK's modelMs rejection is `DOMException(…, "TimeoutError")`, so once the derived runMs signal has
  fired, `isAbortRejection` returns true via the **name-set leg** even though the SDK's own timer —
  not our signal — caused that rejection. (Probed: the claim does hold while the effective signal is
  unfired.) Qualify the docstring.
- [`§4` / `agent-runner.ts:1755`] `runStructured()`'s tier-1 delegate passes
  `{...options, traceId, parentSpanId}` — `timeout` included, caller `abortSignal` unchanged. Per §4
  ("at each public method's entry"), `run()` then mints a **second** `AbortSignal.timeout(runMs)` and
  a fresh `deadlineAt` when tier-1 starts, and `runStructured`'s own effective signal is never handed
  down. Net: the 2-tier path's wall clock reaches (time before tier-1) + `runMs`, and tier-1
  discriminates against the wrong deadline. Thread the effective signal + `deadlineAt` into the
  delegate and suppress re-derivation when a deadline is already in scope.
- [`§1` / `§5`] **`runMs` is not honored during tool dispatch.** `ctx.signal` is wired only when
  `toolMs` is set, and the guards are boundary-only, so a run with `runMs` alone that blocks in a
  never-returning tool exceeds its budget without bound. The §1 docstring "Whole-run wall-clock
  budget" over-promises. Either wire the effective signal into `ctx.signal` whenever `timeout` is
  set, or narrow the docstring to "checked at iteration boundaries and during model calls; a blocked
  tool is not interrupted."
- [`§6`] The docs surface departs from the precedent the spec otherwise follows. `docs/runners.md`
  §2.5 is the gated single source of truth and **both** stacked predecessors recorded there (#514 →
  item 2, #504 → item 7); item 7's abort description becomes incomplete the moment `run()` can
  return `finishReason: "timeout"` and the forwarded signal becomes a composed effective signal. §6
  and the acceptance list touch only a brand-new `## Known limitations` section in
  `packages/agent-runtime/README.md` plus CHANGELOG. Add a `docs/runners.md` §2.5 update.

**Nits (3):**

- [`§ Current state`, bullet 5] The "Per-subagent timeout is NOT forwardable today" sentence is at
  `workflows/node-tool.ts:155`, not `:151` (the only anchor in the spec that drifted).
- [`§5`] `AbortSignal` in `packages/agent-core` was verified to typecheck (field injected,
  `tsc --noEmit` exit 0, sentinel confirmed the check was live), but `agent-core/package.json`
  declares no `@types/node` and `tsconfig.base.json` sets `lib: ["ES2022"]` with no `DOM` —
  resolution is incidental to bun's hoist layout. Keep the per-package
  `bun run --filter=@pattern-stack/agentic-core typecheck` in the acceptance list.
- [`§2`, "flag for critique"] The `firstChunkMs`-vs-`stepMs` call is sound as reasoned; `stepMs`
  bounds time-to-first-chunk from above and two timers for one budget is redundant. No change
  needed beyond the uniform-`stepMs` consequence in blocker 3.

</details>

**Reviewed by:** reviewer agent · re-run 2 · 2026-08-14T21:49:03Z

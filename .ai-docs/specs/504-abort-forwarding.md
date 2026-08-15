# Implementation strategy — issue #504: `runtime: forward abortSignal to every provider call`

**Size S · one PR from `hr/runner-2-abort-forwarding` · packages: runtime (+ one docs sentence) · plan-key `framework-hardening/runner-2`**

Both dependencies are merged: #496 (per-call event bus — this file's plumbing is now per-call closures) and #487 (the runners.md §2.5 correction this PR further amends).

## Current state (verified, post-#496 anchors)

The issue's line anchors predate #496; they have shifted. The five provider calls today:

| Call site | Location | `abortSignal` forwarded? |
|---|---|---|
| `run()` `generateText` | `packages/agent-runtime/src/runner/agent-runner.ts:769` | ❌ — only the top-of-iteration check at `:734` |
| `runStructured()` no-tools `generateText` | `agent-runner.ts:1480` | ❌ |
| `runStructured()` capable-path `generateText` | `agent-runner.ts:1528` | ✅ `:1548` (do not regress) |
| `runStructured()` tier-2 `generateText` | `agent-runner.ts:1653` | ❌ |
| `stream()` `streamText` | `agent-runner.ts:1888` | ✅ `:1898` (do not regress; #341 machinery unchanged) |

Related, also verified:

- `run()`'s catch around its `generateText` (`:776-798`) currently emits `agent.llm.end {finishReason: "error"}` + routes through `_gatewayAwareError` (which emits `agent.error`) + throws — once the signal is forwarded, an abort would surface as a spurious error without normalization.
- `run()` already has the shared cancelled return path: `cancelledAtIteration` (`:730-737`, return block at `:1197-1223`) — `finishReason: "cancelled"`, never throws (locked D1).
- `runStructured()` already owns `RunCancelledError` (`agent-runner.ts:117-134`): thrown pre-start (`:1407`) and on a cancelled tier-1 (`:1613`).
- Abort-shape precedent: `stream()`'s catch treats `e.name === "AbortError"` as abort (`:2120-2130`, #341 belt-and-braces) — never string-matches provider messages.
- `RunOptions.abortSignal` docstring (`packages/agent-runtime/src/runner/types.ts:172-201`) documents the non-forwarding as deliberate ("do not forward it into the underlying `generateText` call").
- `docs/runners.md:99` (§2.5 item 7, rewritten by #487): "`run()` does **not** [forward]: … a cancel during a long model call keeps burning tokens". This PR falsifies that sentence.

### Corrections / deltas to the issue

- Anchors `:759 / :1463 / :1633` are now `:769 / :1480 / :1653` (post-#496 drift only; the sites are the same three calls).
- `runners.md:99` also says "`stream()` / `runStructured()` forward it" — only *partially* true (capable path only). The amendment should correct that half-sentence too, not just the `run()` clause.

## Approach

### 1. Forward the signal (3 one-line adds)

Add `abortSignal: options?.abortSignal` to the three `generateText` calls at `:769`, `:1480`, `:1653`. No new `RunOptions` field; the capable path and `stream()` are untouched.

### 2. Normalize the abort rejection

One module-private helper in `agent-runner.ts` (next to `RunCancelledError`):

```ts
/** #504: an abort-shaped rejection that our own forwarded signal explains. */
function isAbortRejection(e: unknown, signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true && e instanceof Error && e.name === "AbortError";
}
```

Both conditions AND'd, per the pinned decision: the name check alone would misclassify a provider's unrelated `AbortError` (e.g. its own internal timeout) as our cancel; the signal check alone would misclassify a genuine provider failure that happens to race our abort. No string-matching of messages. `DOMException` instances pass the `instanceof Error` + `name === "AbortError"` check.

- **`run()`** (catch at `:776`): when `isAbortRejection(e, options?.abortSignal)` — emit `agent.llm.end` with `finishReason: "cancelled"` (not `"error"`), **skip** `_gatewayAwareError` entirely (no `agent.error`), set `cancelledAtIteration = iteration`, `break` out of the loop into the existing shared cancelled return (`finishReason: "cancelled"`, never throws — D1). No new cancel events on `run()` (pinned: "no cancel-event changes to `run()`").
- **`runStructured()`** (all three direct-call catches, at `:1487`, `:1551`, `:1665`): when `isAbortRejection(...)` — throw `new RunCancelledError("runStructured: aborted during the provider call (no structured output available)")` **before** `_gatewayAwareError`, so no `agent.error` is emitted for a deliberate cancel and a raw `AbortError` never escapes. This normalization deliberately covers the capable path too — its signal was already forwarded, but today an abort there escapes as a raw `AbortError` + spurious `agent.error`; after this PR every `runStructured()` abort is a `RunCancelledError`, matching its two existing throw sites.
- **`stream()`**: untouched (its own `AbortError` catch is #341's, and the acceptance pins its tests unchanged).

### 3. Docs made honest

- **`runner/types.ts:172-201`** — rewrite the `AgentRunner` half of the `abortSignal` docstring: all five provider calls now receive the signal; `run()` resolves an in-flight abort to `finishReason: "cancelled"` with no `agent.error`; `runStructured()` throws `RunCancelledError` on any abort (before, during, or between its calls); `stream()` unchanged. Keep the `CodingAgentRunner` half verbatim — that shape is unaffected.
- **`docs/runners.md:99`** — item 7 becomes fully shipped: all provider calls forward the signal; drop the "keeps burning tokens" caveat and the "Tracked as its own issue" tail; fix the imprecise "`stream()` / `runStructured()` forward it" half-sentence. Also update the "Net:" summary at `:101`, which repeats "`abortSignal` forwarding on the non-streaming path" as a missing bit.
- **CHANGELOG** Unreleased → Fixes: entry naming the three newly-forwarded call sites and the normalized abort shapes (`run()` → `"cancelled"`, `runStructured()` → `RunCancelledError`).

## Tests (`agent-runner-abort-forwarding.test.ts`, new file next to the existing runner suites)

The proving fixture, per the acceptance: a `MockLanguageModelV3.doGenerate` that **hangs until the signal it actually received fires**, then rejects with `DOMException("…", "AbortError")` — resolution is only reachable through forwarding, so a dropped signal fails the test by timeout, not by assertion gymnastics:

```ts
doGenerate: async (options) =>
  new Promise((_, reject) => {
    options.abortSignal?.addEventListener("abort", () =>
      reject(new DOMException("aborted", "AbortError")),
    );
  }),
```

1. **`run()` mid-call abort** — fire the controller after `run()` is in-flight: resolves (not rejects) with `finishReason: "cancelled"`; bus collector saw `agent.llm.end {finishReason: "cancelled"}` and **no** `agent.error`.
2. **`runStructured()` no-tools mid-call abort** — rejects `RunCancelledError`; no `agent.error` on the bus.
3. **`runStructured()` tier-2 mid-call abort** — agent with tools + a model id outside `modelSupportsToolsWithStructuredOutput`; first `doGenerate` (tier-1, prompt-keyed like the #496 suite) returns text, second hangs-until-abort → `RunCancelledError`.
4. **Capable-path normalization** — model id inside the capable set, hang-until-abort → `RunCancelledError` (pins the new shape on the already-forwarding path).
5. **Non-abort `AbortError` stays an error** — doGenerate rejects `AbortError` while our signal never fired: `run()` rethrows through the existing error path (gateway-aware emit + throw), proving the AND in `isAbortRejection`.

Existing suites (`agent-runner.test.ts` 97, `agent-runner-stream.test.ts` 27 incl. the #341 cancellation set, `agent-runner-event-bus.test.ts` 3) must pass unchanged.

## Acceptance (from the issue, restated)

- [ ] `bun run check` green
- [ ] Hang-until-signal mock proves forwarding at all three previously-dropped call sites
- [ ] `run()` mid-call abort → `finishReason: "cancelled"`, no `agent.error`
- [ ] `runStructured()` abort → `RunCancelledError`, never a raw `AbortError`
- [ ] `stream()` cancellation tests (#341) untouched and green
- [ ] `types.ts` docstring + `runners.md` §2.5 sentence match shipped behaviour

## Diff Review — Adherence
<!-- written by: reviewer · gate 2.5 · /sdlc:review · lens=adherence -->

**Target:** `git diff origin/main...HEAD` on `hr/runner-2-abort-forwarding` (PR #544, head `ba9b19c`; base `origin/main` = `17b7523`. Spec commit `ca46d49` excluded from review)
**Against:** `.ai-docs/specs/504-abort-forwarding.md`
**Verdict:** PASS_WITH_NOTES
**Run:** re-run #2, after the Gate 2.5 fix round (`ba9b19c`). Supersedes the `5c5dc76` REVISE below.

**Prior blocker — CLEARED.** The docstring (`types.ts:175-178`) and `runners.md:99`
now scope the cooperative guards per method: "`run()` and `stream()` check it at
the top of each iteration; `stream()` additionally checks before each tool
dispatch." Verified against the tree — `run()`'s top-of-iteration guard is at
`agent-runner.ts:757`, `stream()`'s at `:1950`, and `stream()`'s
pre-tool-dispatch guard at `:2377` is the only one of its kind. Neither document
now claims a guard `run()` does not have. Acceptance item 6 (docstring +
runners.md match shipped behaviour) is met modulo Note 1 below.

**Post-review amendments — accepted, not drift.** Two deltas in `ba9b19c` go
beyond the spec's letter; both implement the fixes prescribed verbatim in the
`Diff Review — Quality` section of this same file, so they are Gate-2.5
amendments to the spec, not deviations from it:

- *Detector widened* (spec §2 vs `agent-runner.ts:143-158`). `isAbortRejection`
  is no longer byte-equivalent to the spec snippet: it gained an `e ===
  signal.reason` identity leg and an `ABORT_ERROR_NAMES` set
  (`AbortError | TimeoutError | ResponseAborted`, mirroring the SDK's own
  `isAbortError`). This is exactly the predicate Quality B1 prescribed, and the
  `signal.aborted` conjunct the spec argued for is preserved as an early return
  — the negative test (`:235`) still pins it.
- *Structured runs finalize* (`agent-runner.ts:1530-1544`). A closure
  `emitCancelledTerminal()` emits `agent.message.complete
  {content:"", finishReason:"cancelled"}` with the accrued token totals before
  each `RunCancelledError` throw that follows `agent.message.start` — the three
  catches (`:1565`, `:1638`, `:1764`) *and* the tier-1-cancelled path (`:1706`,
  a fourth site Quality B1 didn't enumerate but which has the same requirement).
  The pre-start guard (`:1455`) correctly emits nothing: it throws before
  `message.start` at `:1489`, so no row is ever opened. The event body is
  field-for-field identical to `run()`'s cancelled terminal (`:1248-1259`), and
  `RunStoreExporter` finalizes on it (`exporters/run-store.ts:225-227`) —
  `status: "ok"` with `finishReason: "cancelled"`, which is the only shape the
  store's status enum (`storage/run-store.ts:83`) can express, matching `run()`.

**Everything else still holds.** Re-verified after the fix round: the three
`abortSignal` adds at `:800` (`run()`), `:1557` (no-tools), `:1758` (tier-2);
the already-forwarding sites at `:1597` (capable) and `:2001` (`stream()`)
un-regressed; `run()`'s catch (`:809-822`) emits `agent.llm.end
{finishReason:"cancelled"}`, skips `_gatewayAwareError`, sets
`cancelledAtIteration` and breaks into the shared cancelled return
(`:1246-1270`) — D1 held, `run()` still never throws on abort; no cancel-event
changes to `run()` this round (pinned decision respected); `stream()` untouched.
The 5 spec'd tests remain in the spec'd order with the hang-until-signal
fixture; 2 were added for the amendments (7 total). Verified green locally:
7 + 97 (`agent-runner.test.ts`) + 27 (`agent-runner-stream.test.ts`, incl. the
#341 set) + 3 (`agent-runner-event-bus.test.ts`) = **134 passed**, pre-existing
counts unchanged; `bun run typecheck` and `bun run lint` clean across all six
workspaces. (`src/exporters src/admin src/runner` shows 25 failures, all from
the container's `better-sqlite3` NODE_MODULE_VERSION mismatch — environmental,
30 matching stack frames, unrelated to this diff.)

**Blockers (0):** none.

**Notes (4):**
- [`packages/agent-runtime/src/runner/types.ts:183-187`] The new emit clause is
  not scoped to the paths that emit. The sentence reads "`runStructured()` …
  emits a terminal `agent.message.complete {finishReason:"cancelled"}` (so
  run-store exporters still finalize the run) and then throws a
  `RunCancelledError` … whether the signal fires **before**, during, or between
  its provider calls." On the *before* path the pre-start guard (`:1455`) throws
  with no terminal event at all — correctly, since `message.start` (`:1489`) has
  not fired and there is no row to finalize. This is the same shape as the
  blocker just fixed (a doc claim overreaching its actual scope), one notch
  weaker: nothing observable is misdescribed, because the emit is vacuous
  exactly where it's absent, so no reader acts wrongly on it. Flagging as a note
  rather than a blocker for that reason — but `runners.md:99` got this right
  ("On an in-flight abort, … `runStructured()` emits …"), and the docstring
  should match. · _Suggested:_ "…emits a terminal `agent.message.complete
  {finishReason:"cancelled"}` when the abort lands after the run has started
  (nothing is opened, so nothing is emitted, when it fires first), then throws…"
- [`agent-runner-abort-forwarding.test.ts:153-177`] The terminal-event
  assertion (`cancelledComplete`) covers only 2 of the 4 emission sites: the
  no-tools catch (tests at `:150`, `:232`) and the capable-path catch (`:196`).
  The tier-2 catch (`agent-runner.ts:1764`) is exercised by test 3 but that test
  constructs `new AgentRunner(model)` with no bus, so it asserts nothing about
  events; the tier-1-cancelled site (`:1706`) is exercised only by the
  pre-existing `agent-runner.test.ts:1784`, which predates the emission and
  asserts only the thrown type. Quality B1's prescribed fix said "assert the
  terminal event in the suite" — half the sites are unpinned, so a future
  refactor could drop either emission silently. · _Suggested:_ pass a collected
  bus to test 3 and add `expect(cancelledComplete(events)).toBe(true)`; add one
  tier-1-cancelled case (abort during the tier-1 delegate).
- [`packages/agent-runtime/src/runner/agent-runner.ts:2229`] Carried from the
  prior round, and the gap widened. `stream()`'s belt-and-braces catch is still
  `e instanceof Error && e.name === "AbortError"` — no `signal.aborted`
  conjunct, no reason-identity leg, no `TimeoutError`/`ResponseAborted`. After
  this round `isAbortRejection` (`:154`) and the streaming path disagree in
  *both* directions on the same input: an `AbortSignal.timeout` that fires
  mid-stream is not recognized as a cancel there, while a provider's unrelated
  `AbortError` is. The spec scoped `stream()` out and the #341 tests pin its
  behaviour, so this remains not-a-deviation — but it is now the only detector
  in the file that the new suite does not describe. Follow-up issue.
- [`agent-runner-abort-forwarding.test.ts:102`, `:172`, `:211`, `:227`] The
  wall-clock race flagged last round is unaddressed and now has two more
  instances (`AbortSignal.timeout(30)` at `:211`, `setTimeout(…, 30)` at
  `:227`). Every abort is scheduled *before* the run is awaited, so a slow box
  can land the abort before the provider call is reached: test 1 then routes
  through the top-of-iteration guard and `expect(llmEnds).toHaveLength(1)`
  fails; test 3's abort can land inside the tier-1 delegate, leaving
  `tier2Called` false. All fail rather than false-pass, so correctness of the
  gate is preserved — but these are avoidable CI flakes. Firing
  `controller.abort()` from inside `doGenerate` (after the listener registers)
  removes the race and proves forwarding at least as well.

**Nits (3):**
- [`agent-runner.ts:1566`, `:1639`, `:1765`] The
  `"runStructured: aborted during the provider call (no structured output
  available)"` literal is still written three times — and the fix round added a
  fourth copy of the `await emitCancelledTerminal(); throw new
  RunCancelledError(…)` pair at each site. Now that the emit half *is* factored
  into a closure, folding the throw half in with it (`await
  cancelAndThrow(...)`) is a smaller change than it was last round.
- [`agent-runner.ts:822`] Carried: the `run()` cancel path emits
  `agent.iteration.start` and the terminal `message.complete` with no
  `agent.iteration.end` for the started iteration. `stream()` declares the same
  choice explicitly (`:354`); this path should carry the same one-sentence note.
- [`agent-runner.ts:1706`] When the caller supplies `options.runId` (#437), the
  tier-1 delegate at `:1687` inherits it through the `...options` spread, so a
  tier-1 cancel now produces *two* `message.complete {cancelled}` events for one
  `runId` — `run()`'s own at `:1248` and `emitCancelledTerminal()`'s. Harmless
  (the store's `WHERE … status = 'running'` makes it first-terminal-wins) and
  the happy 2-tier path has had the same duplication since before this PR, so
  it is pre-existing shape rather than a regression — noting it only so the
  duplicate isn't read as new.

**Reviewed by:** reviewer agent · 2026-08-14T20:19:00Z (re-run #2)

<details>
<summary>Superseded — re-run #1 verdict on <code>5c5dc76</code> (REVISE)</summary>

**Blockers (1):**
- [`packages/agent-runtime/src/runner/types.ts:175`, `docs/runners.md:99`] The
  rewritten docstring and §2.5 item 7 both assert "the runner also checks it at
  the top of each iteration **and before each tool dispatch** (never silently
  ignored on any `RunOptions` path)". The pre-tool-dispatch guard exists only in
  `stream()`. `run()` has no such guard — its intent loop and parallel dispatch
  run the whole batch unguarded, and it only re-checks at the next iteration's
  top. The text this replaced was correctly scoped; the rewrite collapsed the
  scoping and introduced a new false claim into the two documents whose honesty
  is this PR's stated purpose. · _Fix:_ re-scope both sentences per method.
  **Fixed in `ba9b19c`.**

Notes 1-3 and nits 1-2 from that round are carried forward above (updated line
anchors); the accounting note (`agent.llm.end` reporting `inputTokens: 0` /
`RunResult.iterations` reusing `cancelledAtIteration`) is dropped as a
deliberate, spec-consistent mirror of the existing error path — the Quality
section records the same call.

</details>

## Diff Review — Quality
<!-- written by: reviewer · gate 2.5 · /sdlc:review · lens=quality -->

**Target:** `git diff 17b7523...ba9b19c` (PR #544, head `ba9b19c`; base is `origin/main` = `17b7523` — the local `main` ref is stale, so `main...HEAD` overstates the diff)
**Against:** `.claude/canvases/quality-checks/categories.yaml` (spec-blind)
**Verdict:** PASS_WITH_NOTES
**Run:** re-run after the fix round (`ba9b19c`) — replaces the prior REVISE block from head `5c5dc76` (git history keeps it)

**Prior blockers — both resolved:**

- **B1 (detector too narrow)** — resolved. `isAbortRejection` (`agent-runner.ts:154`) is now `signal.aborted && (e === signal.reason || ABORT_ERROR_NAMES.has(e.name))` with `ABORT_ERROR_NAMES = {AbortError, TimeoutError, ResponseAborted}` (`:143`), mirroring the SDK's own `isAbortError`. Re-verified by running the suite: `AbortSignal.timeout()` and `controller.abort(customReason)` both now settle as cancels, and the AND-conjunct still routes an uncorrelated provider `AbortError` to the error path (test `:236`). The `signal.aborted` conjunct was worth keeping and was kept.
- **B2 (cancelled structured run never finalized)** — resolved. `emitCancelledTerminal()` (`:1530`) emits `agent.message.complete {content:"", finishReason:"cancelled"}` before every `RunCancelledError` throw that can occur **after** `agent.message.start`: no-tools catch (`:1565`), capable-path catch (`:1638`), tier-1-cancelled (`:1706`), tier-2 catch (`:1764`). I enumerated every `throw new RunCancelledError` site in `runStructured()` — the only uncovered one is the pre-run guard at `:1456`, which fires before `message.start`, so no row is ever opened and nothing needs finalizing. Correct. Three tests now assert the terminal on the bus, not just the thrown type.
- The prior note about the doc claiming a pre-tool-dispatch guard on every path is also resolved — `types.ts:174-177` and `docs/runners.md:99` both now scope it ("guards are per-method: `run()` and `stream()` check at the top of each iteration; `stream()` additionally before each tool dispatch"), which matches the code.

**Blockers (0):** none.

**Notes (4):**

- [`packages/agent-runtime/src/runner/agent-runner.ts:2229`] (carried forward, now sharper) `stream()`'s belt-and-braces catch still keys on `e instanceof Error && e.name === "AbortError"` — the exact predicate B1 just widened two functions above it, unshared. Two consequences. (a) The `TimeoutError` / `ResponseAborted` names the fix round added are not recognized there, so an abort-shaped rejection with either name that reaches that catch is rethrown raw out of the generator — contradicting the "`stream()` … does NOT throw (locked D1)" guarantee that `types.ts:178-180`, edited by this diff, states unconditionally. (Narrow in practice: when the signal is already `.aborted` the SDK synthesizes the clean `abort` stream part and never reaches this catch — which is precisely why it's a note, not a blocker.) (b) The correlation policy is now *opposite* in one class: `isAbortRejection` requires `signal.aborted` and the new test at `:236` pins that; `agent-runner-stream.test.ts:848` deliberately pins the reverse for `stream()` ("No `abortSignal` at all — proves the guard is keyed on the error's shape"). Both are defensible, but nothing in the file says they diverge on purpose. · _Suggested:_ widen `:2229` to `ABORT_ERROR_NAMES.has(e.name)` — a one-liner that keeps the pinned shape-only policy intact — and add one sentence to the `isAbortRejection` doc recording why `stream()` doesn't take the `signal.aborted` conjunct.
- [`packages/agent-runtime/src/runner/__tests__/agent-runner-abort-forwarding.test.ts:61-67`] The name-matching half of the B1 fix has no positive coverage. `hangUntilAbort` always rejects with `signal.reason`, so in all six passing abort tests `e === signal.reason` short-circuits and `ABORT_ERROR_NAMES` is never the deciding branch — including the test named for `AbortSignal.timeout` (its `TimeoutError` arrives via the identity leg, not the name leg). Deleting `TimeoutError` and `ResponseAborted` from the set would leave the suite green. Related: the timeout test (`:203-217`) asserts only `finishReason === "cancelled"` and no `agent.error`, both of which the top-of-iteration guard also satisfies, so it doesn't structurally pin that the mid-call detector ran at all (the first test does pin it, via `llm.end{cancelled}` count). · _Suggested:_ one test that rejects with a *different* `DOMException("…","AbortError")` instance while the caller's signal has fired, plus the `llm.end{cancelled}` assertion on the timeout test.
- [`packages/agent-runtime/src/runner/types.ts:186-187`] Over-claim in the doc this diff rewrites: `runStructured()` "emits a terminal `agent.message.complete {finishReason:"cancelled"}` … **whether the signal fires before**, during, or between its provider calls." For the "before" case — the pre-run guard at `agent-runner.ts:1456` — no terminal is emitted (correctly: it throws before `message.start`, so no run row exists). The CHANGELOG carries the same phrasing ("and then throws its existing `RunCancelledError` on any abort"). Given #487 one commit back was entirely about deleting doc claims that didn't hold, worth scoping to "any abort after the run starts; an already-fired signal throws before `message.start`, so there is no row to finalize."
- [`packages/agent-runtime/src/runner/agent-runner.ts:824`] (carried forward, unchanged) The new mid-call cancel `break`s after `agent.iteration.start` (`:763`) without a matching `agent.iteration.end` — the first unbalanced iteration span on `run()`'s cancel path (the pre-existing guard at `:758` breaks *before* opening the iteration). `LangfuseExporter` deletes `_iterationSpans[runId]` only in `_onIterationEnd` (`exporters/langfuse.ts:210`); `_onMessageComplete` doesn't (`:365-370`), so every mid-call cancel leaves an unended span plus a map entry retained for the process lifetime — unbounded in a long-lived server with a stop button. `RunStoreExporter` also drops that iteration's step metric (`exporters/run-store.ts:17-19`). The pre-existing error path leaks the same way, so this isn't novel — but cancel is a routine user action, unlike a provider error. · _Suggested:_ emit `agent.iteration.end {hasMore:false}` before the break, or carry `stream()`'s explicit "accepted, see gate Q2" note (`:343-345`).

**Nits (3):**

- [`packages/agent-runtime/src/runner/agent-runner.ts:1565`, `:1638`, `:1764`] The shared closure covers the emit half of the invariant but not the throw half: the `if (isAbortRejection(…)) { await emitCancelledTerminal(); throw new RunCancelledError("runStructured: aborted during the provider call (no structured output available)") }` block is still hand-duplicated at three sites with a byte-identical message string, plus the tier-1 variant. A fifth throw site added later can forget the terminal again — which is exactly how B2 happened. `const throwCancelled = async (reason: string): Promise<never> => { await emitCancelledTerminal(); throw new RunCancelledError(reason); }` collapses all four and gives the string one home (category: `magic_constants`, string-literal leg).
- [`…/agent-runner-abort-forwarding.test.ts:172`, `:211`] `abortSoon(controller, 60)` / `AbortSignal.timeout(30)` race wall-clock against run setup. The tier-2 case fails (not false-passes) if tier-1 hasn't finished within 60 ms on a loaded runner — `tier2Called` stays false. Ran the file three times locally, green each time (~215 ms), so this is latent, not active. Deterministic alternative: abort from *inside* the hanging `doGenerate`, which by construction only runs when the call is genuinely in flight.
- [`packages/agent-runtime/src/runner/agent-runner.ts:815-816`] (carried forward) The cancelled `agent.llm.end` reports `inputTokens: 0, outputTokens: 0`; usage on an aborted call is *unknown*, not zero, and the prompt tokens were in fact billed. Matches the existing error path and the event fields can't express absence — flagged only so the asymmetry with `usageDetails`'s documented "absent ≠ zero" stays a decision rather than an accident (category: `convenient_fallback`).

**Also verified this round:** all five provider call sites now forward the signal (`:792`, `:1551`, `:1610`, `:1747`, `:1991`) and no sixth `generateText`/`streamText` call exists in the runner, so `docs/runners.md` §2.5 item 7's "forwarded to every provider call" is literally true. `emitCancelledTerminal` reads the accumulators at call time and every accumulator is declared above it — the tier-1 site correctly reports the tokens tier-1 already folded in. The cancelled terminal mirrors the success terminal's shape (`:1807-1819`) field for field. New suite: 7/7 green across three runs; the 125 failures in the full runtime suite are the known local `better-sqlite3` native-module env break, unrelated to this diff.

**Reviewed by:** reviewer agent · 2026-08-14T20:31:00Z

## Live Validate
<!-- written by: validator · gate 3 -->

**Branch:** `hr/runner-2-abort-forwarding` @ `13a5af8`
**Profile:** `strict`
**Result:** ✅ all active gates passed (2 known-environment test failures, unrelated to this diff)
**Gates:** build=PASS · dist-contract=PASS · typecheck=PASS · lint=PASS · tests=PASS* · model-facing-schemas=PASS · smoke:memory=PASS · docs-events=PASS
**Acceptance:** 6/6 mechanically verifiable items met — new suite 8/8 green; `agent-runner.test.ts` 97, `agent-runner-stream.test.ts` 27, `agent-runner-event-bus.test.ts` 3 unchanged and green; `types.ts` + `docs/runners.md` §2.5 + CHANGELOG all updated.
**\*** `claude-code-runner.test.ts` 2 failures are container-only (`--dangerously-skip-permissions cannot be used with root`), pre-existing, pass in CI.
**Posted to:** PR #544
**Validated by:** validator agent · 2026-08-14T20:35:00Z

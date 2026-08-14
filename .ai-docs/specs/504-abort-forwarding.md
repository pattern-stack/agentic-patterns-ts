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

**Target:** `git diff origin/main...HEAD` on `hr/runner-2-abort-forwarding` (impl commit `5c5dc76`; spec commit `ca46d49` excluded from review)
**Against:** `.ai-docs/specs/504-abort-forwarding.md`
**Verdict:** REVISE

Approach §1–§2 are implemented exactly as specified and verified against the tree:
the three `abortSignal` adds land at `agent-runner.ts:789` (`run()`), `:1524`
(`runStructured()` no-tools), `:1720` (tier-2); `isAbortRejection`
(`agent-runner.ts:145-147`) is byte-equivalent to the spec's snippet; `run()`'s
catch emits `agent.llm.end {finishReason:"cancelled"}`, skips
`_gatewayAwareError`, sets `cancelledAtIteration = iteration` and breaks into
the shared cancelled return (`:1235-1260`, `finishReason: "cancelled"`, never
throws — D1 held); all three `runStructured()` catches (`:1531`, `:1603`,
`:1725`) throw `RunCancelledError` before `_gatewayAwareError`; `stream()` is
untouched. All five spec'd tests exist in
`agent-runner-abort-forwarding.test.ts` in the spec'd order, with the
hang-until-signal fixture as written. Verified green locally: 5 new + 97
(`agent-runner.test.ts`) + 27 (`agent-runner-stream.test.ts`) + 3
(`agent-runner-event-bus.test.ts`) = 132 passed, unchanged counts; `typecheck`
and `lint` clean. (The full runtime suite has 125 pre-existing failures from a
`better-sqlite3` NODE_MODULE_VERSION mismatch in this container — environmental,
unrelated to this diff.)

**Blockers (1):**
- [`packages/agent-runtime/src/runner/types.ts:175`, `docs/runners.md:99`] The
  rewritten docstring and §2.5 item 7 both assert "the runner also checks it at
  the top of each iteration **and before each tool dispatch** (never silently
  ignored on any `RunOptions` path)". The pre-tool-dispatch guard exists only in
  `stream()` (`agent-runner.ts:2338`). `run()` has no such guard — its intent
  loop (`:965`) and parallel dispatch (`:981`) run the whole batch unguarded,
  and it only re-checks at the next iteration's top (`:746`). The text this
  replaced was correctly scoped (`stream()` … "checks it at the top of each
  iteration and before each tool dispatch"; `run()` and `runStructured()` "also
  check it at the top of each iteration"); the rewrite collapsed the scoping and
  introduced a new false claim into the two documents whose honesty is this PR's
  stated purpose. Fails acceptance item "types.ts docstring + runners.md §2.5
  sentence match shipped behaviour" — docs-only, but that item is the
  criterion. · _Fix:_ re-scope both sentences, e.g. "…the runner also checks it
  at the top of each iteration on every path; `stream()` additionally checks
  before each tool dispatch."

**Notes (3):**
- [`packages/agent-runtime/src/runner/agent-runner.ts:2190`] `stream()`'s
  belt-and-braces catch still uses the name-only check (`e instanceof Error &&
  e.name === "AbortError"`) that `isAbortRejection` was introduced to replace.
  The spec's own rationale for the AND — "the name check alone would misclassify
  a provider's unrelated `AbortError` (e.g. its own internal timeout) as our
  cancel" — applies identically on the streaming path, where the misclassified
  failure becomes `agent.message.cancel` + `agent.conversation.end
  {reason:"cancelled"}` instead of an error. The spec deliberately scoped
  `stream()` out, so this is not a deviation — but the weaker detector now sits
  40 lines from the stronger one. Worth a follow-up issue.
- [`agent-runner-abort-forwarding.test.ts:92,158`] Forwarding is proven through
  a wall-clock race (`setTimeout(…, 30 | 60)` started *before* the run is
  awaited), not a deterministic hook. On a loaded runner, test 3's abort can
  land during tier-1's `run()` delegate instead of tier-2 — the run still
  rejects `RunCancelledError` (via the tier-1 cancelled check at `:1668`), so
  the `rejects.toThrow` passes and only `expect(tier2Called).toBe(true)` — the
  assertion that actually proves tier-2 forwarding — fails. Test 1 has the
  mirror-image exposure: a >30ms stall before `generateText` is reached routes
  through the top-of-iteration guard, no `agent.llm.end` is emitted, and
  `expect(llmEnds).toHaveLength(1)` fails. Firing `controller.abort()` from
  inside `doGenerate` (after the listener is registered) removes the race
  entirely.
- [`packages/agent-runtime/src/runner/agent-runner.ts:803-812`] Accounting on
  the aborted iteration under-reports the thing the PR's headline is about. The
  new `agent.llm.end` reports `inputTokens: 0, outputTokens: 0` for a call that
  may have burned tokens before the abort, and `RunResult.iterations` reuses
  `cancelledAtIteration` (`:1256`), so a mid-call abort at iteration 0 reports
  `iterations: 0` even though an iteration started and a provider call was
  issued (test 1 pins this at `:116`). Both mirror the existing error path, so
  it is consistent — but the field that used to mean "nothing had happened yet"
  now also covers "one call was made and interrupted".

**Nits (2):**
- [`agent-runner.ts:1532`, `:1604`, `:1726`] The same
  `"runStructured: aborted during the provider call (no structured output
  available)"` literal is written three times. The spec prescribed exactly this
  shape, so it is faithful — but a two-line `_abortOrRethrow` private would keep
  the message in one place alongside the tier-1 variant at `:1669`.
- [`agent-runner.ts:812`] The new `run()` cancel path emits
  `agent.iteration.start` and then `agent.message.complete
  {finishReason:"cancelled"}` (`:1236`) with no `agent.iteration.end` for the
  started iteration. `stream()`'s documented posture (`:343-345`) skips *both*
  by design; every normal `run()` loop exit emits both. This path is a hybrid of
  the two — harmless for the collector (`admin/collector.ts:341`) but worth one
  sentence in the `emitCancellation` doc block so the next reader doesn't read
  it as an oversight.

**Reviewed by:** reviewer agent · 2026-08-14T20:05:00Z

## Diff Review — Quality
<!-- written by: reviewer · gate 2.5 · /sdlc:review · lens=quality -->

**Target:** `git diff 17b7523...5c5dc76` (PR #544, head `5c5dc76`; note the PR base is `origin/main` = `17b7523` — the local `main` ref is stale at `956bb16`, so `main...HEAD` overstates the diff by ~340 files)
**Against:** `.claude/canvases/quality-checks/categories.yaml` (spec-blind)
**Verdict:** REVISE

**Blockers (2):**

- [`packages/agent-runtime/src/runner/agent-runner.ts:145`] `isAbortRejection` only accepts `e.name === "AbortError"`, but a real `fetch` rejects the in-flight request with **the signal's `reason`**, not a synthetic `AbortError`. Two idiomatic cancels are therefore misclassified as provider failures: `AbortSignal.timeout(ms)` (reason is a `DOMException` named `TimeoutError` — verified against the runtime) and `controller.abort(reason)` with any custom reason. Verified by running the real runner against a fixture that rejects with `signal.reason` (what undici does): `AbortSignal.timeout` → `run()` **throws** a raw `TimeoutError` and emits `agent.llm.end{error}` + `agent.error`; `runStructured()` throws a raw `TimeoutError`, not `RunCancelledError`. That contradicts three absolutes this very diff writes: "D1: never throws" (CHANGELOG), "`run()` … returns a `RunResult` with `finishReason: "cancelled"`" and "throws a `RunCancelledError` (never a raw `AbortError`) whether the signal fires before, during, or between its provider calls" (`types.ts:169-187`). It is also self-inconsistent: the same `AbortSignal.timeout` IS honored as a cancel by the top-of-iteration `signal.aborted` check (`:746`), so a timeout between iterations returns `cancelled` while a timeout mid-call throws. The AI SDK's own predicate (`@ai-sdk/provider-utils` `isAbortError`) accepts `AbortError | ResponseAborted | TimeoutError`, and its `handleFetchError` returns abort reasons **unchanged**, so the reason arrives verbatim. · _Fix:_ widen the predicate — `signal?.aborted === true && (e === signal.reason || (e instanceof Error && ABORT_ERROR_NAMES.has(e.name)))`. The `e === signal.reason` leg is exact (fetch guarantees it), covers custom reasons, and is immune to name drift; keep the `signal.aborted` conjunct so an unrelated provider `AbortError` still routes to the error path (that property is well-argued and worth keeping). Add a case per abort flavor to the new suite.

- [`packages/agent-runtime/src/runner/agent-runner.ts:1531`] (same at `:1603`, `:1725`) A mid-call abort in `runStructured()` emits **no terminal event at all** — verified: after `agent.message.start`, the bus sees nothing before the `RunCancelledError` propagates. `RunStoreExporter` opens a row on `message.start` and finalizes only on `message.complete` (`run-store.ts:214`) or non-recoverable `agent.error` (`:236`); it has no `message.cancel` handler. So every cancelled `runStructured()` leaves its `runs` row stuck `'running'` until the next open-time sweep. On the capable path this is a strict **regression**: pre-diff the raw abort went through `_gatewayAwareError`, which emitted `agent.error {recoverable:false}` and finalized the row as `'error'`; the diff removes that emission as "spurious" and puts nothing in its place. The immediately-preceding commit in this same CHANGELOG (#495) exists precisely because stuck `'running'` rows are never what an operator wants. The author already applied the correct reasoning in `run()` — see the comment at `:1229-1234`, "a `message.complete` with an honest finishReason is enough for every existing collector/exporter to finalize the run cleanly" — it just wasn't carried to `runStructured()`. · _Fix:_ emit a terminal event before each of the three `throw new RunCancelledError` sites — `agent.message.complete {content: "", finishReason: "cancelled"}`, mirroring `run()` — then throw. The pre-run guard at `:1444` needs nothing (it throws before `message.start`, so no row is opened). Assert the terminal event in the suite, not just the thrown type.

**Notes (3):**

- [`packages/agent-runtime/src/runner/types.ts:174-177`, `docs/runners.md:99`] Both rewritten doc blocks now claim the runner "checks it at the top of each iteration **and before each tool dispatch**" as a property of every `RunOptions` path. Only `stream()` has a pre-tool-dispatch guard (`:2338`); `run()` has abort checks at `:746` and `:798` only, so an abort that fires while iteration N's tool batch is executing still runs the remaining batch and stops at the next iteration top. The prior wording was careful to scope the pre-tool claim to `stream()`; the rewrite collapsed that distinction. Given #487 (one commit back) was entirely about deleting false doc claims, worth restoring the scoping.
- [`packages/agent-runtime/src/runner/agent-runner.ts:145` vs `:2190`] The file now carries two competing definitions of "this rejection is our abort". `isAbortRejection` argues at length that a name-only check "would misclassify a provider's unrelated `AbortError` … as our cancel" — which is exactly what `stream()`'s pre-existing belt-and-braces check at `:2190` still does (name only, no `signal.aborted` conjunct). The new suite pins the AND-semantics for `run()`; `stream()` behaves the opposite way on the identical input. Either migrate `:2190` to the helper or document why the two paths differ.
- [`packages/agent-runtime/src/runner/agent-runner.ts:799-814`] The new cancel path emits `agent.llm.end` but breaks without an `agent.iteration.end`, so the `agent.iteration.start` at `:752` is left unclosed — the first such case in `run()` (the pre-existing top-of-iteration break at `:746` returns *before* opening the iteration). `RunStoreExporter` pushes a step-metrics entry only on `iteration.end` (`:198`) and `_onMessageComplete` does not flush `acc.currentIteration`, so the honestly-emitted cancelled `llm.end` is folded into an accumulator that is then discarded. `stream()` makes the same choice but declares it explicitly (`:343-345`, "accepted per the human gate's Q2 answer"); the new path should either emit the `iteration.end` or carry the same explicit note.

**Nits (3):**

- [`packages/agent-runtime/src/runner/__tests__/agent-runner-abort-forwarding.test.ts:92`] `abortSoon(controller, 30)` / `60` races wall-clock against run setup. If the runner hasn't reached the provider call within 30 ms on a loaded CI box, the top-of-iteration guard fires instead and `expect(llmEnds).toHaveLength(1)` fails; in the tier-2 test, if tier-1 hasn't finished by 60 ms, `tier2Called` stays `false` and the assertion fails. Both fail rather than false-pass, but they're avoidable flakes. Deterministic alternative: abort from *inside* `doGenerate` (`doGenerate: (o) => { controller.abort(); return hangUntilAbort(o.abortSignal); }`) — the callback only runs when the call is genuinely in flight, which proves forwarding at least as well.
- [`packages/agent-runtime/src/runner/agent-runner.ts:1531`, `:1603`, `:1725`] The same five-line normalization block with a byte-identical message string is copy-pasted three times. A one-line `throwIfAbortRejection(e, signal)` helper next to `isAbortRejection` collapses all three and gives the message one home (category: `magic_constants`, string-literal leg).
- [`packages/agent-runtime/src/runner/agent-runner.ts:806-807`] The cancelled `agent.llm.end` reports `inputTokens: 0, outputTokens: 0`. Usage on an aborted call is *unknown*, not zero — and the prompt tokens were in fact billed, which is mildly at odds with the "stops token burn" framing. `usageDetails` in this same file is documented as "absent ≠ zero — never zero-filled" (`events/types.ts:366-370`); the required-number fields can't express absence, so this matches the existing error path and is defensible — flagging only so the accounting asymmetry is a decision, not an accident (category: `convenient_fallback`).

**Verified and clean:** the "three of five provider calls never received `options.abortSignal`" claim is accurate (call sites `:781`, `:1518`, `:1709` were missing it; `:1596` and `:1962` already had it, and no sixth `generateText`/`streamText` call exists in the runner). The AND-conjunct rationale in the `isAbortRejection` doc is sound and matches the SDK's own `isAbortError(error) && abortSignal.aborted` shape. The `hangUntilAbort` fixture is a genuinely good proving mechanism — a dropped signal fails by timeout rather than by an assertion that could be trivially satisfied. The negative test (`:184`) is the right test to have written.

**Reviewed by:** reviewer agent · 2026-08-14T20:12:00Z

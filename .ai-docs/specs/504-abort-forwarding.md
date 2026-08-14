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

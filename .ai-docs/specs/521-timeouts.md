# Implementation strategy — issue #521: `runtime+core: RunOptions.timeout`

**Size M (upper) · one PR from `hr/runner-5-timeouts`, STACKED on `hr/runner-4-model-params` (#514) · packages: runtime, core · plan-key `framework-hardening/runner-5`**

Fourth in the serialized agent-runner.ts stack (#496 → #504/PR #544 → #514/PR #545 → this). Depends on #504 (the abort forwarding + `isAbortRejection` this composes with), #514 (the call-site spread precedent), and #485 (docs-1 — see the delta below: its premise is unmet).

## Current state (verified on the stacked branch @ `72e7b47`)

- **SDK (installed `ai@7.0.58`):** `TimeoutConfiguration` is `number | { totalMs?, stepMs?, firstChunkMs?, chunkMs?, toolMs?, tools? }` (`dist/index.d.ts:597-604`), accepted as `timeout?:` by `generateText` and `streamText` (`:659/:4520/:5205/:6059`) — exactly as the issue claims. Its `toolMs` can never apply to our dispatch: tools are `execute`-less (gate-chain invariant) and dispatch is hand-rolled.
- **Provider calls (post-#514 anchors):** `run()` `generateText` `agent-runner.ts:854`, `runStructured()` no-tools `:1617`, capable `:1677`, tier-2 `:1815`, `stream()` `streamText` `:2062`. All five already spread `...callParams` (#514) and forward `abortSignal` (#504).
- **Tool dispatch sites (3):** `run()` `:1087`, `convertExecutableTools.execute` `:1449`, `stream()` `:2521` — each `await toolExecutor.execute(name, args, this.buildToolCtx({...}))` inside a try/catch that already converts a throw into a structured `{ error }` result fed back to the model, plus an `agent.tool.end` carrying `error`.
- **Cooperative guards:** top-of-iteration `options?.abortSignal?.aborted` checks at `:819` (run) and `:2021` (stream); pre-dispatch at `:2449` (stream only); `runStructured()` pre-start at `:1518`.
- **Core seam:** `ToolExecutionContext` (`packages/agent-core/src/molecules/toolbox.ts:35`) — all-optional readonly fields, "core declares the slot, the host wires the meaning" (the `emit`/`host` precedent). No `signal` today.
- **`workflows/node-tool.ts:151`** documents "Per-subagent timeout is NOT forwardable today — no `RunOptions.timeout`" — this PR creates the field; forwarding is runner-6's, untouched here.
- **`AbortSignal.any` / `AbortSignal.timeout`:** available (Node ≥ 20 / 22 toolchain; already used by the #504 test suite for `AbortSignal.timeout`).

### Delta to the issue

- **The README Known-limitations section does NOT exist** — `grep -i limitation` over the root, runtime, and core READMEs finds nothing; #485 (docs-1) is still open, so "section exists" is premature. This PR **creates** a minimal `## Known limitations` section in `packages/agent-runtime/README.md` carrying the timeout line (unbounded-by-default + abandoned-promise caveat); docs-9's terminal sweep later owns the full section.
- Issue anchors `:606/:963/:1323/:2315` have drifted to `:678` (convertTools invariant) / `:1087` / `:1449` / `:2521` — same sites.

## Approach

### 1. `RunOptions.timeout` (runner/types.ts)

```ts
export interface RunTimeouts {
  /** Per-model-call budget → SDK `timeout` (native; no hand-rolled races). */
  modelMs?: number;
  /** Per-tool-dispatch budget (hand-rolled race — see §3). */
  toolMs?: number;
  /** Whole-run wall-clock budget (checked at iteration boundaries + composed into the effective abort signal). */
  runMs?: number;
}
```

`timeout?: RunTimeouts` on `RunOptions`, exported from the runner barrel (the #514 lesson — the option's type must be nameable). Docstring: AgentRunner-only (same posture as `modelParams`); absent = today's unbounded behaviour; cooperative caveats per field (§3's abandonment, §4's boundary granularity).

### 2. `modelMs` → native SDK timeout

One resolver beside `_resolveCallParams`: `modelMs` present → `timeout: { totalMs: modelMs }` spread into the **four `generateText`** calls, and `timeout: { stepMs: modelMs }` for **`streamText`** — our stream loop is single-step (no `stopWhen`), so `stepMs` bounds exactly one model call; `totalMs` on a stream would also meter the drain time downstream of the model, which is not what "model call budget" means. `firstChunkMs` is deliberately NOT set: `stepMs` already bounds time-to-first-chunk from above, and two timers for one budget is a redundancy trap (the issue's "map `stepMs`/`firstChunkMs`" names the available knobs; picking `stepMs` alone satisfies "native, no hand-rolled races" — flag for critique). Absent → no `timeout` key materialized by us (value-level absence at the mock per the #514-established posture).

**Expiry semantics (deliberate, documented):** a `modelMs` expiry is a per-call failure — it surfaces through the EXISTING error path (`_gatewayAwareError` → `agent.error` → throw), NOT as a cancel: `isAbortRejection` requires *our effective signal* to have fired, and a model-call timeout is the SDK's own timer, not our signal. `runMs` (§4) is the graceful whole-run deadline; the docstring states the difference.

### 3. `toolMs` → bounded dispatch, structured expiry, abandoned promise

Module-private in `agent-runner.ts`:

```ts
/** Race `p` against `ms`; expiry RESOLVES to the structured tool-error the
 * loop already feeds back to the model. The losing promise is ABANDONED —
 * never killed; `ctx.signal` (§5) is the cooperative cancellation channel. */
function withToolTimeout(p: Promise<unknown>, ms: number, toolName: string): Promise<{...}>
```

Wrapped around the **three dispatch sites** only when `toolMs` is set. On expiry: `toolResult = { error: "Tool '<name>' timed out after <ms>ms" }`, `errorMsg` set — the same shape the catch already produces — so `agent.tool.end` carries the error, the result feeds back to the model, the loop CONTINUES, nothing throws. Timer cleared on normal settle (no open-handle leak).

### 4. `runMs` → deadline + effective signal, "timeout" finishReason

- At each public method's entry, when `runMs` set: `deadlineAt = Date.now() + runMs`, plus a derived `AbortSignal.timeout(runMs)` composed with the caller's signal: `effectiveSignal = AbortSignal.any([...caller, ...derived])` (this composition is why the issue lands after runner-2). The **effective** signal is what gets forwarded to provider calls and checked by `isAbortRejection` and the guards — one signal, all existing #504 machinery applies unchanged.
- `run()`: top-of-iteration guard becomes effective-signal + deadline aware; expiry (either the boundary check or an in-flight abort whose cause is the deadline, distinguished by `deadlineAt <= Date.now()` when the caller's own signal has NOT aborted) routes into the EXISTING shared cancelled return with a parameterized reason: `finishReason: "timeout"` (a `string` field — no type change), `agent.llm.end {finishReason:"cancelled"}` stays as-is on the in-flight route (no new event vocabulary, pinned).
- `stream()`: same guard; routes through the existing `emitCancellation` path → `agent.message.cancel` + `agent.conversation.end {reason:"cancelled"}` (pinned: maps to `"cancelled"`, no vocabulary change).
- `runStructured()`: the effective signal composes into its existing #504 normalization — expiry lands as `RunCancelledError` after the terminal cancelled `message.complete`. Message text gains a timeout variant; no structural change.

### 5. Core: `ToolExecutionContext.signal` (additive; core floats)

`readonly signal?: AbortSignal;` added to `molecules/toolbox.ts` with the emit/host precedent doc ("core declares the slot, the host wires the meaning; cooperative-only — the runner never kills a tool"). `buildToolCtx` populates it **only when `toolMs` is set**: a per-dispatch `AbortSignal.timeout(toolMs)` composed via `AbortSignal.any` with the run's effective signal — so a timed-out (or run-aborted) dispatch observes `ctx.signal.aborted === true` and can stop cooperatively. When `toolMs` is unset the field is omitted entirely (scope-tight: wiring the run signal alone is defensible but expands the acceptance surface; deferred).

### 6. Docs

- `runner/types.ts` docstrings (`timeout` + a cross-reference from `abortSignal`'s doc to the composed effective signal).
- `packages/agent-runtime/README.md`: NEW minimal `## Known limitations` section — unbounded-by-default without `timeout`, expiry abandons (never kills) in-flight promises, `ctx.signal` is cooperative-only. (Delta from the issue: the section didn't exist; docs-9 owns the eventual sweep.)
- CHANGELOG Unreleased → Features.
- Per-subagent forwarding explicitly out of scope (runner-6): leave `node-tool.ts:151`'s comment BUT update its parenthetical from "no `RunOptions.timeout`" to "…exists since #521 but is not forwarded here" — the sentence is otherwise false the moment this merges.

## Tests (`agent-runner-timeouts.test.ts`)

Sibling-idiom fixtures (V3 mocks, prompt-keyed scripting; `vi.useFakeTimers` NOT used — the SDK's own timers must fire, keep budgets ≤ 100ms):

1. **`modelMs` reaches every provider call natively** — hang-forever `doGenerate` (never observes any signal) + `modelMs: 50`: `run()` rejects promptly via the error path (and NOT with `finishReason:"cancelled"`); same for `runStructured()` no-tools (rejects, not `RunCancelledError`… unless the SDK rejection is abort-shaped AND our derived signal fired — it must not be, since no `runMs` is set; assert the distinction) and a `stream()` variant. This is behavioral proof of native delivery — the SDK cannot time out a call it never received a `timeout` for.
2. **`toolMs` expiry** — never-resolving `toolExecutor` + fast tool-call→text script: structured error in `agent.tool.end`, model sees it, run COMPLETES normally; nothing thrown; `result.toolCallsCount` counts the timed-out dispatch.
3. **`ctx.signal`** — executor captures `ctx.signal`; after expiry it reports `aborted === true`; with `timeout` absent, `ctx.signal` is absent (own-property check on the ctx we build — ours, not the SDK's).
4. **`runMs` boundary expiry** — per-iteration tool loop with `runMs` shorter than two iterations: `run()` returns `finishReason: "timeout"`; `stream()` yields `message.cancel` + `conversation.end {reason:"cancelled"}` and no `message.complete`.
5. **`runMs` in-flight expiry** — hang-until-abort `doGenerate` (the #504 fixture) + `runMs: 50`, no caller signal: `run()` resolves `finishReason: "timeout"` (not `"cancelled"`), `agent.llm.end {finishReason:"cancelled"}`, no `agent.error`.
6. **Caller abort still wins as "cancelled"** — caller aborts before `runMs` expires → `finishReason: "cancelled"` (pins the reason discrimination).
7. **Omission** — no `timeout`: provider call options carry `timeout: undefined` (value-level), tool ctx has no `signal` key, run behaves byte-identically (existing suites are the real guard: 97/27/3/8/9 must hold).

## Acceptance (from the issue, restated)

- [ ] `bun run check` green
- [ ] `modelMs` reaches every provider call as an SDK `timeout` (behavioral proof)
- [ ] Never-resolving executor under `toolMs` → structured tool-error + `agent.tool.end` with error + completing run
- [ ] `runMs` expiry → `finishReason: "timeout"` + `conversation.end {reason:"cancelled"}` (stream)
- [ ] `ctx.signal` aborted for the timed-out tool; documented cooperative-only
- [ ] Omitting `timeout` leaves every call object byte-identical (value-level at the mock)
- [ ] README Known-limitations line added (section created — see delta)

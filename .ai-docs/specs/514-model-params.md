# Implementation strategy — issue #514: `runtime: model-parameter passthrough`

**Size M · one PR from `hr/runner-4-model-params`, STACKED on `hr/runner-2-abort-forwarding` (#504) · packages: runtime · plan-key `framework-hardening/runner-4`**

Third in the serialized agent-runner.ts track. Depends on #496 (merged) and #504 (PR #544, in review — this branch stacks on it).

## Current state (verified, post-#504 anchors)

- The five provider calls pass only `{model, instructions, messages, tools?, output?, abortSignal?, headers}`: `run()` `generateText` (`agent-runner.ts:781`), `runStructured()` no-tools (`:1518`), capable (`:1576`), tier-2 (`:1709`), `stream()` `streamText` (`:1952`). No generation control reaches any of them.
- **SDK verification (installed `ai@7.0.58` / `@ai-sdk/provider@4.0.7`):** `CallSettings` already carries `maxOutputTokens` / `temperature` / `topP` / `topK` / `seed` / `stopSequences` (+ `presencePenalty`/`frequencyPenalty`, not in scope) and a first-class `reasoning?: LanguageModelV4CallOptions['reasoning']` whose value union is `'provider-default' | 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'` — a superset of `ReasoningEffortLevelSchema`'s six levels (`providers/capabilities.ts:70-77`). Call-level `providerOptions` passes through to the provider verbatim. Reasoning effort is a top-level call setting, not a per-provider hand-roll — the issue's claim holds.
- `ReasoningEffortCapabilitySchema` (`capabilities.ts:141`) is exported and read by nothing; `UNVERIFIED_REASONING` (`:166`) is the every-model default. Advisory machinery precedent: `adviseStructuredRun` (`:530`) → `adviseStructuredRunFor` (`:539`), once-per-key memory + `resetAdvisoryWarningsForTests` (`:586`).
- The no-new-keys precedent: `_callHeaders` (`agent-runner.ts:273`) / `_resolveCallHeaders` (`:290`) return `undefined` when unconfigured so the no-config path passes NO `headers` key and mock assertions stay byte-identical; computed once per run and reused across iterations.

## Approach

### 1. `RunOptions.modelParams` (runner/types.ts)

One nested bag, per the pinned decision — not five flat fields:

```ts
export interface ModelParams {
  temperature?: number;
  maxOutputTokens?: number;   // epic said "maxTokens"; ai@7 spells it maxOutputTokens
  topP?: number;
  topK?: number;
  seed?: number;
  stopSequences?: string[];
  /** Mapped to the SDK's top-level `reasoning` call setting. */
  reasoningEffort?: ReasoningEffortLevel;
  /** Passed through verbatim as call-level `providerOptions`. */
  providerOptions?: ProviderOptions;
}
```

`ReasoningEffortLevel` imports from `providers/capabilities.js` (same package, already an agent-runner import source); `ProviderOptions` is `ai`'s own exported type (the runtime package already depends on `ai`; fall back to `Record<string, Record<string, unknown>>` only if the type isn't exported — it is in 7.0.58). Per-run only: no runner-level defaults on `AgentRunnerOptions`.

### 2. `_resolveCallParams(options)` (agent-runner.ts)

Private, mirroring `_callHeaders`: returns `undefined` when `options?.modelParams` is absent, else an object built with per-key conditional spreads (the event-payload idiom) so only keys the caller actually set appear — `reasoningEffort` renamed to `reasoning`, everything else name-preserving, `providerOptions` verbatim. Computed **once per public call**, right next to `callHeaders` (`:673`, `:1465`, `:1838`), then spread into all five sites as `...callParams` — spreading `undefined` adds no keys, so the no-config call object is byte-identical (exact-shape asserted in tests, mirroring #406's headers posture).

Inside `_resolveCallParams`, when `reasoningEffort` is set: call `adviseReasoningEffort(modelId, level)` — one seam covers all three public methods, once per run. (This needs the resolved `modelName`, so `_resolveCallParams(modelName, options)` — same shape as `_resolveCallHeaders` taking resolved inputs.)

### 3. `adviseReasoningEffort` (providers/capabilities.ts)

Beside `adviseStructuredRun`, same once-per-`(model × "reasoningEffort")` memory, same test reset hook: warns when the capability table has no verified reasoning support for the model (`support !== "yes"`) or the requested level isn't in its `levels`. Advisory only — never throws, never alters or blocks the call. **No rows added to `MODEL_CAPABILITIES`** (pinned: honesty refines require evidence we don't have; every model stays `UNVERIFIED_REASONING`, which simply means the advisory fires once for any model until real capability rows exist).

### 4. Docs

- `docs/runners.md` §2.5 **item 2** (`:94`) claims `AgentRunner` "never forwards" `providerOptions` and calls the passthrough "future" — this PR falsifies it; rewrite as shipped (`RunOptions.modelParams.providerOptions` + `reasoningEffort`). The **"Net:"** line (`:101`) loses "a `providerOptions` passthrough" from the missing-bits list (leaving `reasoning` events… which `stream()` emits — verify while there and correct only if wrong).
- CHANGELOG Unreleased → Features entry.
- Note (out of scope, per the issue header): the epic item's per-step close condition lands with runner-6 (workflow-seam forwarding), not here.

## Tests (`agent-runner-model-params.test.ts`)

1. **Reaches all five call sites** — capture the mock's received call options per path (run / runStructured no-tools / capable / tier-2 / stream): `temperature`, `maxOutputTokens`, `stopSequences`, `providerOptions` arrive.
2. **No-config exact shape** — without `modelParams`, the captured call options contain none of the new keys (assert exact absence, the #406 precedent).
3. **`reasoningEffort: "high"` arrives as `reasoning: "high"`** — asserted on the captured options. Implementation note: if ai@7's V3→V4 compat shim drops `reasoning` before a `MockLanguageModelV3`, use `ai/test`'s V4 mock for this one test rather than weakening the assertion.
4. **Advisory** — `vi.spyOn(console, "warn")`: two runs with `reasoningEffort` on the same unverified model → exactly one warning; never throws; the call object is unaffected by the advisory. Uses `resetAdvisoryWarningsForTests`.
5. Existing suites unchanged (`agent-runner.test.ts` 97, stream 27, event-bus 3, abort-forwarding 5).

## Acceptance (from the issue, restated)

- [ ] `bun run check` green
- [ ] `modelParams` reaches all five call sites (captured via mock)
- [ ] Omitting it produces a call object with no new keys (exact shape asserted)
- [ ] `reasoningEffort: "high"` arrives as `reasoning: "high"`
- [ ] `adviseReasoningEffort` warns once, never throws, never alters the call
- [ ] No `MODEL_CAPABILITIES` rows change

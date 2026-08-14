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

`ReasoningEffortLevel` imports from `providers/capabilities.js` (same package, already an agent-runner import source). `ProviderOptions` imports from **`@ai-sdk/provider-utils`** (already a direct dep, `^5.0.0` → 5.0.25, compile-verified) — `ai@7.0.58` declares the type but does NOT re-export it, and the untyped-record fallback fails typecheck against `JSONValue` (Spec Review blocker 1). Per-run only: no runner-level defaults on `AgentRunnerOptions`.

Docstring posture (Spec Review note): `modelParams` is honored by **`AgentRunner`'s five provider calls only** — harness-backed runners (`CodingAgentRunner` subclasses) and `MockRunner` ignore it today, and the docstring must SAY so (the adjacent `abortSignal` doc promises cross-runner behavior; this field must not imply the same). Workflow-seam forwarding is runner-6's close condition, not this PR's.

### 2. `_resolveCallParams(options)` (agent-runner.ts)

Private, mirroring `_callHeaders`: returns `undefined` when `options?.modelParams` is absent, else an object built with per-key conditional spreads (the event-payload idiom) so only keys the caller actually set appear — `reasoningEffort` renamed to `reasoning`, everything else name-preserving, `providerOptions` verbatim. Computed **once per public call**, right next to `callHeaders` (`:673`, `:1465`, `:1838`), then spread into all five sites as `...callParams` — spreading `undefined` adds no keys, so the no-config call object is byte-identical (exact-shape asserted in tests, mirroring #406's headers posture).

Inside `_resolveCallParams`, when `reasoningEffort` is set: call `adviseReasoningEffort(modelId, level)` — one seam covers all three public methods, once per run. (This needs the resolved `modelName`, so `_resolveCallParams(modelName, options)` — same shape as `_resolveCallHeaders` taking resolved inputs.)

### 3. `adviseReasoningEffort` (providers/capabilities.ts)

Beside `adviseStructuredRun`, same once-per-key memory keyed per `(model × condition)` — e.g. `${bareModelId}:reasoningEffort:unverified` vs `…:level` (unverified-support and unsupported-level are distinct conditions and must not share one slot; matches Tests item 4) — same test reset hook: warns when the capability table has no verified reasoning support for the model (`support !== "yes"`) or the requested level isn't in its `levels`. Advisory only — never throws, never alters or blocks the call. **No rows added to `MODEL_CAPABILITIES`** (pinned: honesty refines require evidence we don't have; every model stays `UNVERIFIED_REASONING`, which simply means the advisory fires once for any model until real capability rows exist).

### 4. Docs

- `docs/runners.md` §2.5 **item 2** (`:94`) claims `AgentRunner` "never forwards" `providerOptions` and calls the passthrough "future" — this PR falsifies it; rewrite as shipped (`RunOptions.modelParams.providerOptions` + `reasoningEffort`). The **"Net:"** line (`:101`) is stale on BOTH halves (Spec Review): `providerOptions` ships here, and "`reasoning` events" were never missing — `run()` emits `agent.reasoning` at `:886` and `stream()` at `:2042/:2077/:2090/:2238`. Correct item 3 (same stale reasoning-events claim) and the Net line together.
- CHANGELOG Unreleased → Features entry.
- Note (out of scope, per the issue header): the epic item's per-step close condition lands with runner-6 (workflow-seam forwarding), not here.

## Tests (`agent-runner-model-params.test.ts`)

1. **Reaches all five call sites** — capture the mock's received call options per path (run / runStructured no-tools / capable / tier-2 / stream): `temperature`, `maxOutputTokens`, `stopSequences`, `providerOptions` arrive. (Tier-1 is a free win: the 2-tier delegate spreads `{...options}` into `run()` at `:1687`, so `modelParams` forwards with no extra plumbing.)
2. **No-config value-level shape** — without `modelParams`, the captured call options carry `undefined` for every new member (`temperature`/`topP`/`topK`/`seed`/`stopSequences`/`maxOutputTokens`/`reasoning`/`providerOptions`). **Value-level, not key-absence** (Spec Review blocker 2): the SDK materializes every `CallSettings` member as an own property valued `undefined` at `doGenerate` regardless of config, and the #406 headers test was itself weakened to value-level for exactly this reason (`agent-runner.test.ts:2652-2671`). The spread-`undefined` design in §2 still holds at the `generateText` argument level — it just isn't observable at the mock.
3. **`reasoningEffort: "high"` arrives as `reasoning: "high"`** — asserted on the captured options. Hedge resolved by execution (Spec Review): ai@7's `asLanguageModelV4` shim is a transparent Proxy overriding only `specificationVersion`; `reasoning` and `providerOptions` reach a `MockLanguageModelV3`'s `doGenerate` verbatim. Keep V3 mocks throughout.
4. **Advisory** — `vi.spyOn(console, "warn")`: two runs with `reasoningEffort` on the same unverified model → exactly one warning; never throws; the call object is unaffected by the advisory. Uses `resetAdvisoryWarningsForTests`. Key the once-memory by `(model × condition)` — unverified-support and unsupported-level are distinct conditions and must not share one slot.
5. Existing suites unchanged (`agent-runner.test.ts` 97, stream 27, event-bus 3, abort-forwarding **8** — post-Gate-2.5 count).

## Acceptance (from the issue, restated)

- [ ] `bun run check` green
- [ ] `modelParams` reaches all five call sites (captured via mock)
- [ ] Omitting it leaves every new member `undefined` at the provider call (value-level assertion — the SDK materializes all `CallSettings` keys, so key-absence is unsatisfiable; amended per Spec Review blocker 2)
- [ ] `reasoningEffort: "high"` arrives as `reasoning: "high"`
- [ ] `adviseReasoningEffort` warns once, never throws, never alters the call
- [ ] No `MODEL_CAPABILITIES` rows change

## Design Addendum (post Spec Review, re-run 1)

Blocker fixes: `ProviderOptions` now imports from `@ai-sdk/provider-utils` (not `ai`, which doesn't re-export it; the untyped fallback failed typecheck) — §1. The no-config acceptance/test moved from key-absence to value-level `undefined` (the SDK materializes every `CallSettings` member; #406's headers test made the same move) — Tests §2 + acceptance item 3.

Notes folded in: V3-mock hedge resolved by the reviewer's execution (shim forwards `reasoning` verbatim; V4 mock contingency dropped); `modelParams` docstring must state it is AgentRunner-only today (harness runners ignore it); advisory once-memory keyed per condition, not per field; runners.md Net line + item 3 corrected on the stale reasoning-events half; abort-forwarding baseline is 8 tests; tier-1 forwarding noted as free via the `{...options}` spread.

## Spec Review
<!-- written by: reviewer · gate 1.5 · /sdlc:critique · lens=mixed -->

**Target:** `.ai-docs/specs/514-model-params.md` @ working tree (post-Design-Addendum, uncommitted; base `30cbb5b`)
**Against:** cited code in the tree (`hr/runner-4-model-params`, stacked on `hr/runner-2-abort-forwarding`)
**Verdict:** PASS_WITH_NOTES · **re-run 1** (supersedes the REVISE below)

Both blockers are fixed, and both fixes were re-verified by execution rather than accepted on assertion.

- **Blocker 1 (`ProviderOptions` import) — RESOLVED.** `@ai-sdk/provider-utils` is a direct dependency of `agent-runtime` (`package.json:65`, `^5.0.0` → resolves 5.0.25) and does export `ProviderOptions` (`dist/index.d.ts:154`, `type ProviderOptions = SharedV4ProviderOptions`). Compile-probed in-package under the real `tsconfig.json`: the spec's exact `ModelParams` shape plus a conditional-spread `callParams` object spread into `generateText({ model, messages, ...callParams })` typechecks with **zero errors**. The negative still holds — switching the import to `"ai"` reproduces `error TS2459: Module '"ai"' declares 'ProviderOptions' locally, but it is not exported.` The fix is correct as written.
- **Blocker 2 (no-config assertion) — RESOLVED.** Probed against `MockLanguageModelV3` with a bare `generateText({ model, messages })`: all eight new members (`temperature`/`topP`/`topK`/`seed`/`stopSequences`/`maxOutputTokens`/`reasoning`/`providerOptions`) are own-properties valued **`undefined`** — `reasoning` is NOT defaulted to `'provider-default'`, which was the live risk in the amended criterion. The value-level acceptance is satisfiable exactly as restated.

The dropped V3-mock hedge (Tests item 3) also re-verified: `reasoning: "high"`, `providerOptions: {acme:{flag:true}}` and all six scalars arrive verbatim at a `MockLanguageModelV3`'s `doGenerate`. Dropping the V4 contingency is safe. Notes 2/3/5 folded in correctly; baseline counts now exact (`agent-runner.test.ts` 97, stream 27, event-bus 3, abort-forwarding 8 — confirmed by `vitest run`, 135 total). One note survives: the fix for old-note 4 landed in the Tests section but not in the design section it contradicts.

**Blockers (0):** none.

**Notes (1):**

- [`§ 3 (adviseReasoningEffort), line 47` vs `§ Tests item 4, line 60`] **The advisory-keying fix is half-applied — the two sections now contradict each other.** Tests item 4 and the Design Addendum both say key the once-memory by `(model × condition)` because "unverified-support and unsupported-level are distinct conditions and must not share one slot." But §3 still specifies "same once-per-`(model × "reasoningEffort")` memory" — the per-*field* keying, which is exactly the collapsed-slot behavior the note asked to fix. An implementer building from §3 writes the wrong key; one building from Tests item 4 writes a key that §3's `adviseStructuredRunFor` precedent (`capabilities.ts:551`, `${bare}:${capabilityName}`) does not model. Not gate-blocking — the addendum and the test both state the intended direction unambiguously, so the tiebreak is available — but §3 should be amended in the same pass to say the key is `(model × condition)`, e.g. `${bare}:reasoningEffort:${"unverified" | "level"}`.

**Nits (4):** (carried forward — nits 1-3 were not addressed in re-run 1 and are re-verified as still stale)

- [`§ Current state, lines 9 + 12`; `§ 2, line 41`] Line anchors still drifted (all **sites** re-verified correct, so these mislead but don't misdirect): call sites `781→792`, `1518→1551`, `1576→1610`, `1709→1747`, `1952→1991`; `_callHeaders` `273→284`, `_resolveCallHeaders` `290→301`; resolution points `673→684`, `1465→1476`, `1838→1877`. Anchors confirmed still exact: `capabilities.ts` 70-77 / 141 / 166 / 530 / 539 / 586, `agent-runner.ts:1687` (tier-1 delegate), `agent.reasoning` at `:886` / `:2042` / `:2077` / `:2090` / `:2238`, and `docs/runners.md` 94 / 95 / 101.
- [`§ Tests item 2, line 58`] The #406 precedent is characterized slightly wrong. That test was weakened away from key-absence to a **no-leak** assertion (`expect(keys.some(k => k.startsWith("x-bf-") || k === "x-request-id")).toBe(false)`), not to a value-level `undefined` assertion — `headers` is one member ai@7 *always* populates, via `withUserAgentSuffix`. The load-bearing point (key-absence is unachievable; a prior Gate 1.5 review already forced this move) is right, and `modelParams`' members genuinely are value-`undefined`, so the amended assertion is stronger than #406's. Just don't cite it as the same assertion. Also the path is `src/runner/__tests__/agent-runner.test.ts`, and the `it()` opens at `:2652` (range `2652-2671` is exact).
- [`§ 2, lines 41-43`] "one seam … once per run" is still imprecise on the 2-tier path: tier-1 delegates through `this.run(...)` (`:1687`), so `_resolveCallParams` runs twice and `adviseReasoningEffort` is invoked twice — the module-level `advisedKeys` Set is what makes it *observably* once. The free-tier-1-forwarding upside was folded into Tests item 1; this half wasn't.
- [`§ 4 (Docs), docs/runners.md:101`] While rewriting the Net line for both stale halves, note its trailing clause is stale too — "it just needs to pick the right `LanguageModelV1`" carries the same dead V1 reference the spec already flags in item 2.

**Reviewed by:** reviewer agent · 2026-08-14T20:46:43Z (re-run 1)

<details>
<summary><strong>Superseded</strong> — run 0 verdict (REVISE, 2 blockers) · retained for audit</summary>

**Target:** `.ai-docs/specs/514-model-params.md` @ `30cbb5b`
**Against:** cited code in the tree (`hr/runner-4-model-params`, stacked on `hr/runner-2-abort-forwarding`)
**Verdict:** REVISE

The design is sound — the nested bag, the `_callHeaders`-mirroring resolver, the once-per-run seam, and the no-new-rows advisory posture all check out against the tree. Two blockers, both in claims that were asserted rather than executed: one SDK export that does not exist, and one test/acceptance assertion that cannot pass.

**Blockers (2):**

- [`§ 1 (Approach), lines 31 + 35`] **`ProviderOptions` is NOT exported from `ai@7.0.58`.** The spec asserts "`ProviderOptions` is `ai`'s own exported type … it is in 7.0.58". It is not. `ai`'s `dist/index.d.ts` *imports* it from `@ai-sdk/provider-utils` (line 6) and never re-exports it; the only `Provider*` tokens on any export line are `Provider`, `ProviderMetadata`, `ProviderReference`, `ProviderRegistryProvider`. Verified by compile: `import type { ProviderOptions } from "ai"` → `error TS2459: Module '"ai"' declares 'ProviderOptions' locally, but it is not exported.` The stated fallback is also wrong: `Record<string, Record<string, unknown>>` is **not** assignable to the SDK's `ProviderOptions` (`error TS2322: … 'unknown' is not assignable to type 'JSONValue'`), so it would fail typecheck the moment it is spread into `generateText`. · _Fix:_ `import type { ProviderOptions } from "@ai-sdk/provider-utils"` — already a direct dependency of `agent-runtime` (`^5.0.0`, resolves 5.0.25), and verified to compile. If an `ai`-only import is preferred, `ProviderMetadata` from `ai` is structurally identical and accepts a `ProviderOptions` value (verified). Do not use the `Record<..., unknown>` fallback.

- [`§ Tests item 2 + § Acceptance line 65`] **"Exact absence of the new keys" is unachievable, and it misreads the #406 precedent.** The SDK materializes every `CallSettings` member as an own-property of the options object handed to `doGenerate`, valued `undefined`, regardless of configuration. Probed against `MockLanguageModelV3` with a bare `generateText({ model, messages })`: captured keys are `["abortSignal","frequencyPenalty","headers","maxOutputTokens","presencePenalty","prompt","providerOptions","reasoning","responseFormat","seed","stopSequences","temperature","toolChoice","tools","topK","topP"]`, with `Object.hasOwn(captured, "temperature" | "reasoning" | "providerOptions" | "stopSequences") === true`. So "the captured call options contain none of the new keys" fails on every path. The cited "#406 precedent" is in fact the opposite posture — `agent-runner.test.ts:2652-2671` carries the comment *"MockLanguageModelV3's doGenerate never literally sees `undefined` — the regression guard is that no Bifrost correlation/guardrail key leaked in, not that the field is strictly absent (Gate 1.5 review note)"*, i.e. a prior Gate 1.5 review already forced exactly this weakening for `headers`. · _Fix:_ restate test 2 and the acceptance criterion as **value**-level: with no `modelParams`, every new member of the captured options is `undefined` (and no unrequested value leaks in). The §2 design rationale ("spreading `undefined` adds no keys, so the no-config call object is byte-identical") is correct at the `generateText` **argument** level — keep it as rationale, but stop claiming it is observable at the mock.

**Notes (5):**

- [`§ Tests item 3`] The hedge resolves — **no shim problem, drop the contingency.** `asLanguageModelV4` (`ai/dist/index.js:811`) is a transparent `Proxy` that overrides only `specificationVersion`; it does not touch call options. Probed end-to-end: `generateText({ …, reasoning: "high", providerOptions: { acme: { flag: true } }, temperature: 0.3, maxOutputTokens: 55, topP: 0.9, topK: 7, seed: 42, stopSequences: ["STOP"] })` against a `MockLanguageModelV3` yields `doGenerate` options with `reasoning === "high"` and `providerOptions === {"acme":{"flag":true}}` verbatim, all six scalars intact. Assert on the V3 mock; `MockLanguageModelV4` (also exported from `ai/test`) is unnecessary, and the repo's 172 existing V3 usages stay uniform.
- [`§ 4 (Docs), docs/runners.md:101`] The **Net line is stale on both halves**, not just the `providerOptions` half. It says "the main missing bits are `reasoning` events and a `providerOptions` passthrough" — but `stream()` already emits `agent.reasoning` (`agent-runner.ts:2042`, `:2077`, `:2090`, `:2238`) and `run()` does too (`:886`). The spec's "verify while there and correct only if wrong" resolves to **wrong**; scope the fix to remove both bits. §2.5 **item 3** ("`AgentRunner.stream()`'s switch statement drops them on the floor") is stale for the same reason and sits three lines away — worth correcting in the same pass. Item 2's "accepts only the raw `LanguageModelV1`" is also a stale version reference.
- [`runner/types.ts:140`] `RunOptions` is the **shared** protocol options type — `claude-code-runner.ts`, `harness/coding-agent-runner.ts`, `mock-runner.ts`, and the workflow layer all consume it. `modelParams` will be silently ignored on every non-`AgentRunner` path. The `abortSignal` doc in the very same interface (`:177`) explicitly commits that it "is never silently ignored on any `RunOptions` path", so this codebase treats that as a stated contract. The spec should take an explicit posture (a TSDoc sentence scoping `modelParams` to `AgentRunner` is probably enough).
- [`§ 3 (adviseReasoningEffort)`] The once-per-`(model × "reasoningEffort")` key collapses **two** distinct warning conditions (no verified support; requested level not in `levels`) into one slot, so after any first warning for a model, a later run with a *different* unsupported level is silent. Consistent with the `adviseStructuredRunFor` precedent (`capabilities.ts:539-575`, keyed `${bare}:${capabilityName}`), but the spec asserts both conditions without saying they share a slot. State the intent, or key on level.
- [`§ Tests item 5`] Stale baseline: `agent-runner-abort-forwarding.test.ts` is **8** tests, not 5 (the two post-spec fix commits `ba9b19c` / `13a5af8` added legs). The other three counts verified exact: `agent-runner.test.ts` 97, stream 27, event-bus 3.

**Nits (3):**

- [`§ Current state, line 9 + line 12`] Line anchors drifted (all **sites** verified correct): call sites `781→792`, `1518→1551`, `1576→1610`, `1709→1747`, `1952→1991`; `_callHeaders` `273→284`, `_resolveCallHeaders` `290→301`; resolution points `673→684`, `1465→1476`, `1838→1877`. Anchors that are still exact: `capabilities.ts` 70-77 / 141 / 166 / 530 / 539 / 586, and `docs/runners.md` 94 / 101.
- [`§ Current state, line 9`] "pass only `{model, instructions, messages, tools?, output?, abortSignal?, headers}`" — the capable path also passes `stopWhen` (`:1614`) and `toolApproval` (`:1617`). The load-bearing claim ("no generation control reaches any of them") is correct.
- [`§ 2, line 41`] "one seam … once per run" is imprecise on the 2-tier path: tier-1 delegates through `this.run(agent, message, { ...options, … })` (`:1687`), so `_resolveCallParams` runs twice and `adviseReasoningEffort` is called twice — the module-level `advisedKeys` Set makes it observably once. Worth noting the upside explicitly: that same options spread means **tier-1 already forwards `modelParams` for free**, so the "five sites" framing holds without extra plumbing.

**Reviewed by:** reviewer agent · 2026-08-14T20:41:00Z

</details>

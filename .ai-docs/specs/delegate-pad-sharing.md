# Implementation strategy — issue #269: delegateTo pad sharing (verify-and-finish)

Issue: https://github.com/pattern-stack/agentic-patterns-ts/issues/269
Baseline: `main` @ `ab0369b` (runtime/server/cli 0.26.1, core 0.11.0)
Spec author: Fable (session 2026-07-15), source-chain re-verified at HEAD before writing.

## Scope and PR slicing

**One PR**, runtime-only + docs + ADR + lockstep bump `0.26.1 → 0.27.0`.

The issue is verify-and-finish: the pad-sharing mechanics landed with #124 and are
live in the published dist. What ships here:

1. **MockRunner ctx threading** — the only behavior change. Both dispatch sites
   build and pass a `ToolExecutionContext`, mirroring `buildToolCtx` minimally.
2. **Regression suite** pinning run-scoped share-through-fork across `delegateTo`
   on BOTH the MockRunner rail and the live `AgentRunner` rail.
3. **Docs**: fix the stale `sequential-agents.ts` denial; touch up
   `docs/node-context.md`; CHANGELOG entry.
4. **Decision record**: ADR 0003 ratifying default-on (no new API).
5. **Version bump**: lockstep `0.27.0` so the published `.d.ts` stops denying the
   contract (explicit acceptance criterion). Note: #247 already shipped in 0.26.x
   (verified: its commit predates the 0.26.1 bump commit `091980c`) — the handoff's
   "unpublished" note is stale; this changelog names only #269's changes.

Non-goals (explicitly out): any new `delegateTo`/`SubagentSpec` API surface
(knobs, prompt decorators), `join()`/merge-back across the seam,
`MockRunner.runStructured` tool dispatch, `emit` wiring in the mock ctx.

Scope extension (user-requested, 2026-07-15, not in the filed issue): the
runStructured tier-0 terminal short-circuit — see the
"Addendum — runStructured tier-0" section at the end of this spec.

## Current state (verified at ab0369b)

The chain the issue describes is intact, with one test file it didn't know about:

| Link | Where | Status |
|---|---|---|
| Host passthrough | `packages/agent-runtime/src/workflows/agent-step.ts:137` — `host: { scratchpad: ctx.scratchpad, deps: ctx.deps, eventBus: ctx.eventBus } // #124` | ✅ |
| Single copy site | `packages/agent-runtime/src/runner/agent-runner.ts:207-218` (`buildToolCtx`), relayed at the 3 dispatch sites `:555`, `:835`, `:1475` | ✅ |
| Fork at the seam | `packages/agent-runtime/src/workflows/node-tool.ts:58-64` — narrows `ctx.host`, prefers `host.scratchpad.fork()` over closure/fresh | ✅ |
| Coordinator re-entry | `packages/agent-runtime/src/workflows/coordinator-step.ts:138` — `leaf.run(input, { ...ctx, toolExecutor })` carries `ctx.scratchpad` | ✅ |
| MockRunner gap | `packages/agent-runtime/src/runner/mock-runner.ts:128` (`run`) and `:261` (`stream`) — `execute(tc.name, tc.arguments)` with NO ctx | ✅ (the gap is real) |
| Executor ctx param | `packages/agent-runtime/src/runner/types.ts:78` — `ToolExecutor.execute` already declares the trailing optional ctx | ✅ additive |
| `RunOptions.host` | `runner/types.ts:143-148` | ✅ |

**Existing coverage** — `packages/agent-runtime/src/workflows/__tests__/host-propagation.test.ts`
(#124's suite, 6 groups) already pins: full rail via `CoordinatorStep` + real
`AgentRunner` (parent→child prompt visibility), parallel branch isolation,
root deps, fork semantics incl. child→parent run-scoped write-back, host-over-closure
precedence, no-host back-compat, and event-bus crossing. What it does NOT cover —
and what #269 adds: the **`delegateTo` sugar itself**, the **backpack accessor path**
(`requireBackpack`/`openBackpack` from a subagent tool), the **MockRunner-as-coordinator
rail** (impossible today — the gap), and the **`agent.scratchpad.fork` event payload**.

**Downstream consumers**: aloevera-ts `examples/coordinator-stub/coordinator.ts`
hand-builds the team only to get pad-aware *briefs* (`taskPrompt`); the sharing
itself rides the stock chain. dealbrain holds evidence pools in closures citing the
stale doc line.

## Corrections to the issue

1. **"No regression test proves it" is half-right.** `host-propagation.test.ts`
   proves the seam mechanics end-to-end on the live rail. The missing pieces are
   `delegateTo`-shaped, backpack-shaped, and MockRunner-shaped (see table above).
   The new suite complements — it must not duplicate — #124's.
2. **Test-plan item (a) as written is impossible via stock `delegateTo`.** The
   generated `AgentStep` prompt is `(input) => input.task`
   (`node-tool.ts:182`) — it ignores the pad, so "the subagent's prompt callback
   sees the parent's run-scoped slots" cannot be asserted through the sugar.
   Parent→child visibility is asserted through the subagent's **tools**
   (`requireBackpack(ctx, pack)` reading parent-seeded entries) — which is the
   dealbrain-relevant path anyway. (Prompt-level visibility through a custom
   `AgentStep` is already pinned by host-propagation Test 1.)
3. **The issue's `CoordinatorStep`-shaped sketch is awkward on the MockRunner
   rail.** With a typed (non-string) `output`, the internal leaf takes
   `runner.runStructured` (`agent-step.ts:141` guards `output &&
   !isStringSchema(output)`) — and `MockRunner.runStructured` never dispatches
   `toolCalls` (`mock-runner.ts:154-201`), so delegation would never fire. A
   `CoordinatorStep` with `output: z.string()` WOULD take the dispatching
   `run()` path, but the mock-rail test instead hosts the coordinator as a
   plain **`AgentStep` (no `output`)** whose agent carries the `delegateTo`
   toolbox as a `Capability` — the simpler host with one fewer moving part;
   executor derivation (#228) covers dispatch, and `CoordinatorStep`'s ctx
   spread is already pinned live by host-propagation Test 1.
   `MockRunner.runStructured` tool dispatch is a follow-up candidate, not this
   issue.
4. **The minimal ctx proposed by the issue is right, with one addition.**
   `{ runId, traceId, parentToolCallId, host }` — `run()` must MINT ids
   (`generateId()`, honoring `options.traceId` like `stream()` does at `:211`);
   `stream()` reuses its existing `traceId`/`runId`/`toolCallId` locals. No
   `emit` in v1: MockRunner has no bus to publish on (`stream()` yields events
   instead), and wiring progress into the generator mid-dispatch is new mock
   vocabulary out of scope here.
5. **Known breakage to fix in-PR**: `runner/__tests__/mock-runner.test.ts:157-158`
   assert `toHaveBeenCalledWith(name, args)` with exact arity — the new third
   argument fails them. Update to `toHaveBeenCalledWith(name, args, expect.anything())`.

## Design decisions

### D1 — Ratify default-on; the isolation knob already exists (ADR 0003)

Run-scoped share-through-fork **is** the intended default for `delegateTo` /
`NodeToolbox` under any ctx-threading runner. No team-level opt-out knob:

- The isolation control already lives at the right altitude — **slot scope**.
  `scope: "run"` is an explicit declaration of "shared across this run's whole
  tree"; isolation-sensitive state declares `scope: "branch"` and stays
  per-fork (pinned by host-propagation Tests 2 & 4). To be precise: branch
  scope isolates across ALL forks (parallel branches and delegation alike),
  not the delegation seam specifically — there is no slot-level way to say
  "shared across stages but not across delegation". No consumer has asked for
  that split; if one does, that's the moment to design a knob. A
  `delegateTo(padSharing: …)` knob today would be a second, coarser switch
  over behavior the slot declaration already governs.
- Fork-don't-alias (#124) already bounds the blast radius: no join/merge-back,
  branch scopes never escape the call.
- Consumer evidence runs the other way: dealbrain's defect class came from state
  being INVISIBLE across the seam; nobody has asked for less visibility.

Revisit only if a real consumer needs per-team isolation of run-scoped state
(the escape hatch today: key separate packs, or scope the slot `branch`).

### D2 — MockRunner ctx: minimal mirror of `buildToolCtx`

Per correction 4. One `runId`/`traceId` pair minted per `run()` call (outside
the tool loop), a fresh `parentToolCallId` per tool call; `stream()` uses its
existing per-call `toolCallId` as `parentToolCallId` — matching the live
runner's "a tool call's span IS the parent span for what it spawns" invariant.
`host: options?.host` verbatim (may be `undefined` — matches live behavior,
pinned by agent-runner.test.ts "no accidental default"). `runStructured`
untouched (no dispatch exists to thread ctx into).

### D3 — Regression suite placement and shape

New file `packages/agent-runtime/src/workflows/__tests__/delegate-pad-sharing.test.ts`
(sits beside `host-propagation.test.ts`; that file stays untouched). Uses real
core `Agent`s with `Capability`-wrapped toolboxes (the host-propagation Test-6
pattern), a small `BackpackSpec` (slot key `backpack.notes`), and the OBSERVED
accessors (`requireBackpack` from `observed-backpack.ts` re-export) exactly as a
consumer tool would.

### D4 — Docs carry the contract; ADR carries the decision

`sequential-agents.ts` gets the corrected contract inline (it renders into the
published `.d.ts` — the load-bearing surface a consumer cited as a design
ruling). The ADR records *why* default-on with no knob. CHANGELOG names the
semantics so dealbrain can retire closure seams against a stated contract.

### D5 — Lockstep bump rides in this PR

`0.27.0` (minor: observable MockRunner behavior change + ratified contract).
Publish fires on merge. Per release process: regenerate `bun.lock` after the
bump (`rm bun.lock && bun install`) or the publish gate rejects.

## File-by-file change plan

### `packages/agent-runtime/src/runner/mock-runner.ts`

- `run()` (`:124-134`): when `options?.toolExecutor` exists, mint
  `const traceId = options?.traceId ?? generateId(); const runId = generateId();`
  before the loop; pass `{ runId, traceId, parentToolCallId: generateId(), host: options?.host }`
  as the third arg to `execute` per call. The no-executor branch is untouched.
- `stream()` (`:257-265`): pass `{ runId, traceId, parentToolCallId: toolCallId, host: options?.host }`
  using the generator's existing locals (`:211-212`, `:248`).
- Header doc: note that the mock now threads the same seam as the live runner (#269).

### `packages/agent-runtime/src/runner/__tests__/mock-runner.test.ts`

- Fix `:157-158` exact-arity assertions (correction 5).
- Add a `describe("ToolExecutionContext threading (#269)")` group — see Test plan T5.

### `packages/agent-runtime/src/workflows/__tests__/delegate-pad-sharing.test.ts` — NEW

Test plan T1–T4.

### `packages/agent-runtime/src/workflows/sequential-agents.ts`

Replace the stale bullet (`:20-23`). Current:

```
 *  - Because slots are run-scoped, the same sharing holds across `Loop`
 *    iterations for free: `Loop({ body: sequentialAgent([...]) })` re-enters
 *    with the pad intact. (Subagent teams — `delegateTo` — do NOT see the pad
 *    yet; opt-in sharing there is a declared follow-up.)
```

Replacement:

```
 *  - Because slots are run-scoped, the same sharing holds across `Loop`
 *    iterations for free: `Loop({ body: sequentialAgent([...]) })` re-enters
 *    with the pad intact. Subagent teams — `delegateTo` — share the pad the
 *    same way (#124, ratified in #269 / ADR 0003): each delegated call runs on
 *    a FORK of the live caller's pad, so run-scoped slots are shared by
 *    reference across the delegation while branch-scoped slots stay isolated
 *    per call. join()/merge-back does not cross the seam (v2).
```

No code change in this file — comment-only, behavior-neutral.

### `docs/node-context.md`

`:193-194` — the "Today that requires threading `scratchpad` into
`delegateTo(…, { scratchpad })` by hand … #99 makes it ambient" paragraph is
pre-#124 framing in present tense. Reword to shipped ("Since #124 this is
ambient…") and cross-reference the #269 regression suite. Two sentences, no
structural edit.

### `docs/adr/0003-delegateto-pad-sharing-default.md` — NEW

Context (the #124 chain, the stale doc, the dealbrain/aloevera evidence) →
Decision (default-on, share-through-fork, no team-level knob; slot scope is the
isolation control) → Consequences (docs are the contract; consumers retire
closure seams; escape hatches; join/merge-back stays v2) → Alternatives
rejected (`SubagentSpec.sharePad` / `delegateTo(opts.padSharing)` — second knob
for the same behavior; explicit construction-time `scratchpad` — superseded by
the live host by design, pinned by host-propagation Test 5).

### `CHANGELOG.md`

New `## 0.27.0 (2026-07-15)` section:

- **agent-runtime** (Bug Fixes): MockRunner now builds and passes a
  `ToolExecutionContext` (`runId`, `traceId`, `parentToolCallId`, `host`) at both
  tool-dispatch sites, exercising the same #124 host-passthrough seam as the live
  runner — no-LLM tests can now observe `delegateTo` pad sharing (#269).
- **agent-runtime** (Docs): retired the stale "subagent teams do NOT see the pad"
  claim from `sequentialAgent`'s docs (stale since #124); the actual contract —
  run-scoped slots shared by reference through the delegation fork, branch-scoped
  isolated, no join across the seam — is documented and pinned by a regression
  suite, and ratified as the default in ADR 0003 (#269).

### `packages/agent-{runtime,server,cli}/package.json` + `bun.lock`

Lockstep `0.27.0` (use the justfile `bump-lockstep` path); regen `bun.lock`.

## Test plan

All no-LLM (MockRunner + `MockLanguageModelV2`), vitest, in the new file unless
noted. Shared fixtures: `notesPack: BackpackSpec<{id,text}, {id,text}, readonly {id,text}[], string>`
(slot key `backpack.notes`); child agent `notes` with one capability tool
`add_note` that (a) captures `requireBackpack(ctx, notesPack).entries()` into a
test-scoped variable, (b) `drop`s `{id:"c1", text:"from-child"}`; coordinator
agent carrying `delegateTo(childRunner, [{ agent: childAgent, name: "notes", description: … }])`
wrapped in a `Capability`.

- **T1 — mock rail, parent→child + child→parent (the headline).**
  Coordinator hosted as `AgentStep` (no `output`) on a MockRunner whose canned
  response tool-calls `notes`; child on its own MockRunner whose canned response
  tool-calls `add_note`. Root pad seeded with `{id:"p1", text:"from-parent"}`
  via `readBackpack(rootPad, notesPack, "seed")`. Assert: the child tool saw
  `p1` (parent→child through TWO MockRunner hops — coordinator dispatch AND the
  child AgentStep's own dispatch); after the run, `readBackpack(rootPad, …)`
  contains `c1` (child→parent, shared by reference); the coordinator's
  MockRunner `callHistory` has the delegation, the child's has the sub-run.
- **T2 — branch isolation on the same rail.** The child tool also writes a
  branch-scoped slot through the narrowed `ctx.host.scratchpad`. Assert the
  root pad's branch slot is untouched after the run (fork semantics across the
  full delegateTo rail; unit-level equivalent exists in host-propagation Test 4).
- **T3 — fork event carries the shared keys.** Root pad is an
  `ObservedScratchpad` (construction mirrored from `observed-scratchpad.test.ts`)
  with `backpack.notes` materialized pre-run; subscribe `agent.scratchpad.fork`;
  run T1's flow; assert at least one fork event whose `sharedKeys` includes
  `"backpack.notes"` (`events/types.ts:394-398`).
- **T4 — live rail through `delegateTo` (acceptance: "both paths").** Outer =
  real `AgentRunner` on a 3-call `MockLanguageModelV2` script (the
  host-propagation Test-1 pattern: tool-call → text → structured finish is NOT
  needed here — host as plain `AgentStep`, so 2 calls suffice: tool-call →
  text); child + assertions identical to T1. Pins that the sugar (not just
  `NodeToolbox`) shares on the production rail.
- **T5 — MockRunner unit tests (in `mock-runner.test.ts`).**
  (a) `run()`: executor receives a ctx; `ctx.host === options.host` (identity);
  `runId`/`traceId`/`parentToolCallId` are non-empty strings; `options.traceId`
  is honored; two tool calls in one response share `runId` but get distinct
  `parentToolCallId`s. (b) `run()` without `host`: ctx still passed,
  `ctx.host === undefined`. (c) `stream()`: `ctx.parentToolCallId` equals the
  `toolCallId` on the yielded `agent.tool.start` event; `ctx.host` relayed.
  (d) existing behavior untouched: no-executor path, error capture in `stream()`.

Suite-wide guard: `bun run --filter=@agentic-patterns/runtime test` green — the
arity fix (correction 5) is the only expected pre-existing-test edit. Anything
else failing means the mock ctx leaked somewhere unexpected: stop and reassess,
don't patch tests to green.

## Documentation plan

Covered in the file-by-file plan (sequential-agents bullet, node-context reword,
ADR 0003, CHANGELOG). One addition: `docs/node-context.md`'s "Tests to add"
list (`:197-201`) gets a one-line pointer to the two suites that now exist.

## Risks and compatibility

- **Behavior change surface**: only consumers driving MockRunner **through a
  toolExecutor** see new behavior, and only when the executor's tools read ctx.
  Tools ignoring the trailing ctx param are unaffected (it was already optional
  in the `ToolExecutor` contract, `runner/types.ts:75-78`). Direct
  `mockRunner.run(agent, msg)` calls: unchanged.
- **Semantics flip worth naming**: a no-LLM test that previously (wrongly)
  observed "subagent gets a fresh pad" will now observe sharing — that is the
  point of the issue; downstream no-LLM smokes reporting the old conclusion were
  measuring the mock's gap, not the contract.
- **Exact-arity assertions**: fixed in-PR (correction 5); external consumers
  with similar assertions on their own executor spies take a one-line fix —
  named in the CHANGELOG entry.
- **No public type change**: `ToolExecutor.execute`'s ctx param and
  `RunOptions.host` both already exist; core untouched entirely.
- **Version risk**: none beyond normal lockstep publish; core does not bump.

## Acceptance mapping

| Issue acceptance | Where satisfied |
|---|---|
| New test passes on MockRunner path | T1–T3, T5 |
| New test passes on live-runner path | T4 |
| `sequential-agents.ts` doc matches behavior; published d.ts no longer denies sharing | File plan + 0.27.0 bump/publish |
| CHANGELOG names the semantics for downstream | CHANGELOG entry (contract named verbatim) |
| Opt-in/opt-out question decided + recorded | ADR 0003 (D1: default-on, no knob) |

## Addendum — runStructured tier-0 terminal short-circuit

User-requested scope extension (2026-07-15), same seam family. Motivation
(dealbrain overnight run 2026-07-15): when a tool-bearing agent's tier-1 loop
ends via a TERMINAL tool, `runStructured`'s 2-tier path re-converts the
already-structured terminal result through a second LLM call — wasteful and
demonstrably lossy (tier-2 on gemini flash-lite stripped `observation:`
prefixes from citation keys 5/5 runs, immune to in-prompt counter-instruction).

### Design (verified against `agent-runner.ts` at HEAD)

Site: the 2-tier branch ONLY (`agent-runner.ts` `runStructured`, the
`else` arm — currently tier-1 `this.run(...)` at `:985`, empty-guard at `:998`,
tier-2 `generateText` at `:1004`). The other two branches have no tier 2 and
are untouched.

After tier 1 returns and BEFORE the empty-response guard:

1. Eligibility: `tier1.finishReason === "terminal_tool"` exactly
   (`terminal_tool_error` is NOT eligible — that result is an error string).
2. Candidate reconstruction: `RunResult` carries only the serialized text; the
   terminal capture (`agent-runner.ts:611-614`) is
   `typeof result === "string" ? result : JSON.stringify(result ?? "")` — so
   the candidate is `JSON.parse(tier1.response)` and, on parse failure, the
   raw `tier1.response` string. (JSON round-trip is lossless here: a
   non-string terminal result already crossed the tool boundary as JSON.)
3. `schema.safeParse(candidate)`:
   - **success** → `rawObject = candidate`, `finishReason = "terminal_tool"`,
     SKIP tier 2 entirely — no tier-2 tokens, no `iterations += 1`. The shared
     validation at `:1023` re-parses (redundantly but harmlessly) and the
     shared `agent.message.complete` emission is unchanged.
   - **failure** → fall through to the empty-guard + tier 2 EXACTLY as today
     (including the guard's throw semantics on empty tier-1 text).

Backward compatible; no API change; no new RunOptions.

### File plan (addendum)

- `packages/agent-runtime/src/runner/agent-runner.ts` — the short-circuit in
  the 2-tier arm, with a comment naming the contract (terminal result IS the
  structured output when it validates; tier 2 is the fallback, not a
  re-normalizer).
- `packages/agent-runtime/src/runner/__tests__/agent-runner.test.ts` — new
  cases beside the existing "terminal-tool exit" describe (`:838`) /
  runStructured coverage, mirroring their fixture patterns.
- `CHANGELOG.md` — Features bullet under `## 0.27.0`.

### Tests (addendum)

- **T6 — short-circuit**: agent with a terminal tool whose result is a
  schema-valid object; mock model tool-calls the terminal tool on call 1.
  Assert: exactly ONE model call (doGenerate counter), `result.object` deep-equals
  the terminal result, `finishReason === "terminal_tool"`, and token totals
  equal tier-1's alone (tier-2 tokens = 0).
- **T7 — invalid terminal result falls back**: terminal result fails the
  schema; model script provides the tier-2 structured answer. Assert: two
  model passes, `result.object` comes from tier 2, tokens sum both tiers —
  byte-identical to today's behavior.
- **T8 — string terminal result**: terminal tool returns a plain string with
  `schema = z.string()`-shaped... only if cheap; otherwise cover via T6/T7 and
  note the parse-or-raw rule in the code comment. (Optional — implementer's
  call; do not force a contrived schema.)

### Acceptance (addendum)

| User's acceptance | Where satisfied |
|---|---|
| Schema-valid terminal result → exactly one LLM pass, output === terminal result | T6 |
| Invalid terminal result → tier-2 fallback unchanged | T7 |
| Tier-2 tokens = 0 on the short-circuit | T6 token assertion |

## Design Addendum

Post-critique amendments (Gate 1.5 verdict PASS_WITH_NOTES, 2026-07-15):

- **Correction 3 rewritten** per reviewer note 1: "output required → forces
  `runStructured`" was overstated — `agent-step.ts:141` routes `z.string()`
  output through the dispatching `run()` path. The plain-`AgentStep` host
  choice stands, now justified by simplicity rather than impossibility.
- **D1 first bullet tightened** per reviewer note 2: branch scope isolates
  across ALL forks, not the delegation seam specifically; the missing
  "stage-shared but delegation-isolated" middle ground is named explicitly and
  deferred until a consumer asks.
- Reviewer note 3 (node-context.md reword is mild scope creep) accepted as-is:
  same defect class, two sentences, kept in scope.

## Spec Review

**Verdict: PASS_WITH_NOTES** (Gate 1.5 — reviewer, lens=mixed, re-verified against source @ `ab0369b`).

The spec is faithful to the issue, internally coherent, and the test plan is feasible as
written. Every file:line citation checks out and every risky mechanism was traced to
working code. Two reasoning imprecisions and one small scope creep — none change the plan.

### Citations — all verified
`agent-step.ts:137` (host passthrough) and `:125` (`ctx.toolExecutor ?? deriveToolboxExecutor`,
#228) ✅; `node-tool.ts:58-64` (fork) and `:182` (`prompt: (input) => input.task`) ✅;
`coordinator-step.ts:138` (`leaf.run(input, { ...ctx, toolExecutor })`), `output` required at
`:92` ✅; `mock-runner.ts:128`/`:261` (execute with no ctx), `:154-201` (`runStructured`
never iterates `toolCalls`), `:211-212`/`:248` (stream locals) ✅; `runner/types.ts:78`
(trailing ctx), `:143-148` (`host?`) ✅; `agent-runner.ts:207-218` + dispatch sites
`:555/:835/:1475` ✅ (a 4th host-thread exists at `:951` via `convertExecutableTools`, but
it is not a `buildToolCtx` site — the spec's phrasing is precise); `events/types.ts:394-398`
(`ScratchpadForkEvent.sharedKeys`) ✅; `mock-runner.test.ts:157-158` are exact-arity
`toHaveBeenCalledWith` — they DO break on a third arg (correction 5 valid) ✅.

### Test-plan feasibility — confirmed
- **T1 two-hop** traced end-to-end: derived team executor → `Toolbox.execute` forwards ctx
  (core `toolbox.ts:201-208`) → `nodeTool` forks (shared run-entries Map by reference) → child
  `AgentStep` derives its OWN executor → child MockRunner threads host into `add_note`. Both
  hops require the #269 fix; child→parent write-back is the same mechanism host-propagation
  Test 4 already pins. ✅
- `requireBackpack(ctx, spec)` reads `ctx.host.scratchpad` (`backpack.ts:572-599`) ✅. The
  **observed** accessors fall back to the raw pack when the pad carries no emitter
  (`observed-backpack.ts:251/265/285`), so T1/T2's plain `createScratchpad()` seed-through is safe.
- **T3**: `ObservedScratchpad.fork` emits `sharedKeys = [...runEntries.keys()]`
  (`observed-scratchpad.ts:190-196`); constructible via `createStateEmitter(bus, {...})` exactly
  as `observed-scratchpad.test.ts:37-42`. ✅
- **T4**: the 2-call live script (tool-call → text, plain `AgentStep` so no `runStructured`
  tier-2) is sound. ✅

### Notes
1. **Correction 3 is overstated.** "`output` is required, which forces `runStructured`" is not
   accurate: `AgentStep` only routes to `runStructured` when `!isStringSchema(output)`
   (`agent-step.ts:141`); a `CoordinatorStep` with `output: z.string()` takes the `run()` text
   path, which DOES dispatch `toolCalls` on `MockRunner` (`CoordinatorStepSpec` even blesses
   `z.string()` at `:91`). So `CoordinatorStep` *can* host a mock-rail dispatch test. The
   decision to host as a plain `AgentStep` still stands (a `z.string()` coordinator is
   degenerate) — only the stated reason needs correcting.
2. **D1's supporting sentence overreaches** (decision itself is sound). "Slot scope is the
   isolation control" conflates two axes: `scope: "branch"` isolates across ALL forks
   (FanOut/Loop/`delegateTo` alike), not the delegation seam specifically — there is no
   single-slot way to say "shared across stages, isolated across sub-teams." But D1 explicitly
   defers the knob pending real demand, and the consumer evidence runs toward MORE visibility
   (dealbrain's defect was invisibility), so deferring is well-justified YAGNI.
3. **Minor scope creep:** `docs/node-context.md` reword is beyond the issue's literal doc list
   (which names only `sequential-agents.ts`). Same stale-framing defect class, so defensible —
   just flagging it as an addition.

### Confirmed facts
`#247` merged 2026-07-14 10:34, predates BOTH the 0.26.0 (16:33) and 0.26.1 (16:44) bumps — the
spec's "shipped in 0.26.x" correction is accurate (conservatively; it actually rode 0.26.0).
Versions runtime/server/cli 0.26.1, core 0.11.0 confirmed. Nothing required by the issue is
missing; corrections 1/2/4/5 all check out — correction 2 (prompt callback unassertable via
stock `delegateTo`, reframed to tool-side) is a genuinely good catch.

## Diff Review — Adherence

_(Gate 2.5 — reviewer A appends here.)_

## Diff Review — Quality

_(Gate 2.5 — reviewer B appends here.)_

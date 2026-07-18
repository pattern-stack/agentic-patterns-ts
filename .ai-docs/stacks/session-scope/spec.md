# SessionScope (#308) — stack spec

> Assembled post-hoc from the ultracode build's locked-decision artifacts (understand-phase maps + lead decisions) so Gate 2.5 has a durable adherence reference. Issue: pattern-stack/agentic-patterns-ts#308. Stack: #309 → #310 → #311 (branches feat/session-scope → feat/scope-form → feat/scope-render).

## PR-1 + PR-2 locked decisions (D1–D15)

# SessionScope PR-1 — locked decisions (lead, 2026-07-18)

Resolves every contradiction/gap raised by the understand-phase gapcheck. These are FINAL for PR-1; do not relitigate in implementation. Issue: #308.

## D1 — Scope carriage = sibling `host.scope` key (NOT inside host.deps)
`host.deps` is a DepReader (workflows/deps.ts:52-58; node-tool.ts:64 forwards it as one) — a plain object there crashes `ctx.deps.get()`. Scope rides as a SIBLING key on the host bag: `RunOptions.host = { scratchpad?, deps?, eventBus?, scope? }`.
- `NodeRunContext` gains optional `readonly scope?: Record<string, unknown>`.
- `agent-step.ts:137` host pack adds `scope: ctx.scope`.
- `node-tool.ts:58-68` narrow adds `scope`; forwards it into the sub-node ctx (so scope survives nested AgentSteps / agent-as-tool).
- `as-agent.ts` NodeBackedRunner.run: narrow `options?.host` for `scope` and thread it onto the NodeRunContext it builds (~261-274). stream() already spreads options into run().
- No depKey; no DepRegistry entry. This avoids the ESM/CJS depKey identity hazard entirely.

## D2 — Accessor module = `packages/agent-runtime/src/workflows/scope-host.ts`
Exports (single module so inject+read share one instance):
- `buildScopeHost(parsed: Record<string, unknown>): { scope: Record<string, unknown> }` — host fragment builder used by server/CLI injection sites (merge: `{ ...otherHostBits, ...buildScopeHost(parsed) }`).
- `readScope(ctx: { host?: unknown } | undefined): Record<string, unknown> | undefined` — soft accessor, duck-narrows `ctx?.host` per node-tool.ts:58 cast style.
- `requireScope(ctx): Record<string, unknown>` — fail-loud with remediation text (copy backpack.ts requireBackpack tone).
- Typed overload: `readScope<S>(ctx, scope: S extends SessionScope-like): ScopeValue-typed | undefined` via a generic parameter on the SessionScope-like's parse return; implement as a second signature that calls scope.parse? NO — do not re-parse per tool call. Instead: `readScopeAs<T>(ctx): T | undefined` simple generic cast sugar, documented as trusting the server-side parse. Keep it honest and simple.
Export from `workflows/index.ts` next to the deps block.

## D3 — Zod error payload = duck-typed `err.issues`
Server 400 body: `{ error: "scope validation failed", issues: err.issues }` where detection is `err && Array.isArray((err as any).issues)`. NEVER `instanceof ZodError`, never `.flatten()` (zod peer range ^3.25||^4; cross-module-instance zod).

## D4 — Server/CLI type = structural `SessionScopeLike`
File-local structural interface in server `config.ts` (exported so playground.ts/CLI can reference it):
```ts
export interface SessionScopeLike {
  readonly schema: unknown;
  readonly redactKeys: readonly string[];
  readonly defaults?: Readonly<Record<string, unknown>> | undefined;
  readonly presets?: Readonly<Record<string, Readonly<Record<string, unknown>>>> | undefined;
  parse(value: unknown): Record<string, unknown>;
  toJsonSchema(): Record<string, unknown>;
}
```
NOTE: defaults/presets are TOP-LEVEL readonly getters on SessionScope (core exposes `.defaults`/`.presets`/`.redactKeys` directly, NOT under `.options`) — keep core's public surface flat so the structural type stays simple. discover.ts duck-type check: object + typeof parse === 'function' + typeof toJsonSchema === 'function' + schema present. All-or-nothing drop if malformed. instanceof is FORBIDDEN across the module boundary.

## D5 — `instantiation.available` widens to `hasHook || hasScope`
It means "POST /conversations accepts a scope/context for this agent" — which is now true for scope-only registrations. Dashboard's existing JSON editor works unchanged with this (posts `context`, server aliases). Apply identically in routes/agents.ts AND routes/composition.ts (twin payloads). instantiation gains: `schema: reg.scope ? try(reg.scope.toJsonSchema()) : null`, `defaults: reg.scope?.defaults ?? reg.instantiateDefaults ?? null`, `presets: reg.scope?.presets ?? null`. toJsonSchema wrapped in try/catch → null (one bad registration must not 500 the roster).

## D6 — Core validates defaults & presets at construction (fail-fast)
SessionScope constructor parses `options.defaults` and EVERY `options.presets[name]` against the composed schema; stores frozen PARSED COPIES (atoms/base.ts:28 discipline — never freeze caller refs). Invalid defaults/presets throw at construction with a message naming the offending preset. Test both paths.

## D7 — Presets materialize client-side
No `preset` body key on POST /conversations. The wire only ever carries materialized scope values. Document in the docs catalog.

## D8 — Response compat: `context` stays populated
Create-response for hook-OR-scope registrations always includes `context` (redacted echo) + `context_redacted` — the dashboard's useChat.ts:142 depends on it. Additionally include `scope` as the same value for scope-declaring registrations (forward-looking name). Hook-less AND scope-less response stays byte-identical `{id, agent_id}` (pinned test).

## D9 — hasHook keying widens in ALL THREE places
conversations.ts:139 (registry entry context), :143 (response branch), :352-gate feeder (entry.context populated) → `hasHook || hasScope`. Scope-only registrations MUST get echo + run-metadata stamp.

## D10 — Parse order & who receives what
`effective = rawScope ?? shallowCopyOf(scope.defaults ?? instantiateDefaults)`; if reg.scope: `parsed = scope.parse(effective ?? {})` → 400 on issues. The PARSED value (with zod defaults/coercions applied) is what: (a) instantiate receives (shallow copy — frozen input would throw on a mutating hook), (b) redactContext sees, (c) run-metadata stamps, (d) buildScopeHost injects. Redact keys = union(scope.redactKeys, contextRedactKeys). composition.ts delivered route (:745) gets the SAME parse treatment (not optional) + the missing shallow-copy fix.

## D11 — scope.parse({}) with required fields = intentional 400
A registration that declares required scope fields without defaults makes bare POST /conversations a 400. That is CORRECT behavior (the agent declared it needs a scope). Document in docs catalog + a test pins it.

## D12 — `ap run` (cli run.ts) gets the same treatment in PR-1
resolveRunContext defaults precedence gains scope.defaults; scope.parse before instantiate (:102); host injection via buildScopeHost into `new Conversation` (:133) once the runtime slot exists; banner uses union redact keys.

## D13 — CC runners: relay host
ClaudeCodeRunner / claude-code-api-runner: add `host` relay from options into their tool ctx IF the runner shape makes it a small, safe edit; otherwise leave a TODO comment + report it. Do not force it.

## D14 — Server docs catalog updated in the server slice
docs/catalog.ts:117-139 (create request gains `scope`, fix the hook-only prose, response fields), :164-165 (instantiation.schema/presets + new `available` meaning). docs.test.ts updated accordingly.

## D15 — Example migration is schema-first
examples/agents/workspace/agent.ts: `const workspaceScope = new SessionScope({ workspace: scopeItem(z.string().min(1), { description: "Tenant workspace" }), user: scopeItem(z.string().email(), { description: "Acting user" }), region: scopeItem(z.string().min(1), { description: "Data region" }) }, { defaults: DEFAULT_SCOPE, presets: { "sam @ acme": DEFAULT_SCOPE, "li @ globex": { workspace: "globex-ops", user: "li@globex.dev", region: "eu-west" } } })`. Do not invent constraints beyond these (region stays a plain non-empty string). `type WorkspaceScope = ScopeValue<typeof workspaceScope>` replaces the interface. Wrapper gains `scope: workspaceScope`; keep instantiate (drop its `as WorkspaceScope` cast — parse supplies typing); DROP instantiateDefaults/contextRedactKeys from the wrapper (scope subsumes; this example is the reference consumer). Tools keep closing over scope via the existing constructor pattern — PLUS add one demonstration read of `readScope` in ONE tool? NO — runtime import in an example agent is fine (examples import core+runtime already? CHECK: if the example currently imports only core, do NOT add a runtime dep; skip the readScope demo).

## Build-order law (verified)
Cross-package imports resolve to BUILT DIST. After core edits: `bun run --filter=@agentic-patterns/core build` before runtime/server/cli can see exports. Chain: core → runtime → server → cli. Full gate = `bun run build && bun run typecheck && bun run lint && SKIP_SDK_TESTS=true bun run test` (matches CI exactly; NEVER `bun run check`).

## Git law
Implementer agents NEVER run git commands. The lead owns all commits. Work happens on branch `feat/session-scope` in the main working tree.

## PR-3 locked decisions (R1–R8)

# SessionScope PR-3 — locked decisions (lead, 2026-07-18)

Scope-aware prompt rendering on ONE shared agent instance. Ratifies the scout maps
(`pr3-core-render.json`, `pr3-runtime-callsites.json`) — follow their insertion plans
verbatim; these decisions resolve everything they left open. FINAL for PR-3.

## R1 — Mechanism = Awareness.fromScope (render-fn field on the instance)
No new section class. `Awareness` gains `readonly scopeRender?: (scope: Record<string, unknown>) => string`
(2nd optional ctor param) + `static fromScope(scopeLike, fn, base?)`. `toPrompt(ctx?)` appends
`\n\n` + fn(ctx.scope) when both exist (skip empty string), byte-identical otherwise —
APPEND after existing content incl. the no-sources fallback line, never reorder/replace.

## R2 — RenderContext lives in atoms (Layer 0)
`export interface RenderContext { readonly scope?: Readonly<Record<string, unknown>>; }` in
`atoms/base.ts`; re-export upward (atoms/index, rendering/sections/base + index, rendering/index).
Atoms NEVER import rendering or molecules: `fromScope`'s first arg is typed STRUCTURALLY
(`{ parse(input: unknown): unknown }`, value type via `ReturnType<S["parse"]>`) — a typing
anchor only, never re-parsed at render time (same "cast, not validation" stance as readScopeAs).

## R3 — replace() must preserve the fn
`AgenticModel.replace()` reconstructs via 1-arg ctor and silently drops instance fields —
`Awareness` OVERRIDES `replace()` to re-attach `scopeRender`, with a test proving survival
through `withDomain`/`withDomains`/`withCapabilities`.

## R4 — Signature widening map (exact)
- `Agent.renderInitialPrompt(ctx?)` → delegates `renderSections(ctx)`; `toPrompt()` STAYS nullary
  (AgenticModel abstract untouched — an override may add optional params, the abstract may not widen).
- `rendering/sections/base.ts` `render(ctx?)`; only `ContextSection` consumes it and forwards ONLY
  to `awareness.toPrompt(ctx)` (Background stays nullary). `PromptRenderer.renderInitial(ctx?)`
  widens for symmetry; `renderContinuation` untouched.
- runtime `runner/types.ts:30` AgentLike widens (import type RenderContext from core) + amend the
  RunOptions.host doc ("runner never reads it" → now reads exactly `host.scope` for the render ctx).
- `sdk-bridge.ts:111` AgentLikeForBridge widens identically (second independent declaration).

## R5 — Call sites
`agent-runner.ts` private `_renderCtx(options?)` inline structural narrow (CANNOT import
workflows/scope-host — reverse layering); use at all THREE sites (~309 run, ~901 runStructured,
~1122 stream). `claude-code-runner.ts:510` passes the same narrow from `_buildOptions`.
`workflows/base.ts:175` applyStepModel wrapper forwards ctx (`(ctx) => agent.renderInitialPrompt(ctx)`)
— the silent-ctx-drop trap. DELIBERATELY nullary (do not "fix"): PromotedAgent (as-agent.ts:169),
judge scorer (judge.ts:320), all test stubs, server lens calls (composition.ts:687/694 — the
playground prompt lens stays unscoped in PR-3; noted as follow-on).

## R6 — Purity + byte-compat are hard gates
No fetching in fromScope fns; no prompt caching; same instance renders differently per {scope} and
byte-identically nullary. Existing organisms/rendering snapshots must pass WITHOUT -u. Tests per
scout step 12: ctx join-invariant, two-scopes-two-prompts-then-nullary-restores, replace() survival,
runner spy proving run/stream/runStructured each deliver {scope} from host and undefined without.

## R7 — Example migration (the acceptance demo)
`examples/agents/workspace/agent.ts`: build the agent's awareness via
`Awareness.fromScope(workspaceScope, (s) => ...)` rendering
"Acting on behalf of <user> in workspace <workspace> (<region>)." — core-only import, one shared
instance, no instantiate change. This is #308's acceptance sketch line for PR-3.

## R8 — No version bumps in this PR
Publishing is a separate decision; do not touch package versions or bun.lock.

## Gate
Full root: `bun run build && bun run typecheck && bun run lint && SKIP_SDK_TESTS=true bun run test`.
Build-order law applies (core → runtime → server → cli). Never `bun run check`. Snapshots: no `-u`.
Stale-artifact warning: ignore dist/*.d.ts grep hits and the `.claude/worktrees/*` duplicate tree.

## Git law
Implementers never run git. Branch: `feat/scope-render` (stacked on feat/scope-form).

## Diff Review — Adherence

**Verdict:** PASS_WITH_NOTES
**Reviewer:** stack-review-adherence (Gate 2.5, lens=adherence)
**Target:** `git diff main...feat/scope-render` @ `6d28e80` (PRs #309 → #310 → #311, 7 commits)
**Against:** locked decisions D1–D15 + R1–R8 (this spec) · issue #308
**Findings:** 0 blockers / 0 notes / 3 nits

### Summary

Every one of the 23 locked decisions is honored, most with an in-code comment
citing the decision ID. No decision is partially implemented, skipped, or
contradicted. The two documented known-limitations (CC tool execution stays
scope-less per D13; declared defaults/presets served verbatim per the D14
docs-catalog note) are present and correctly scoped as limitations, not gaps.
Behavioral claims were not taken on faith — the byte-compat / purity invariants
and the wire grammar were confirmed by running the suites (below).

### Decision-by-decision (all ADHERENT)

- **D1** — Scope rides as sibling `host.scope`, never inside `host.deps`.
  `NodeRunContext.scope` added (`node.ts`); `agent-step.ts:137` host pack adds
  `scope: ctx.scope`; `node-tool.ts:58` narrow + sub-node forward;
  `as-agent.ts` `NodeBackedRunner.run` narrows `options.host.scope` onto the
  ctx; `stream()` inherits via the options spread. No depKey. Full rail proven
  by `host-propagation.test.ts` Test 7 + `as-agent.test.ts`.
- **D2** — `workflows/scope-host.ts` exports `buildScopeHost` / `readScope` /
  `requireScope` / `readScopeAs<T>` (the resolved cast-sugar form, not a
  re-parsing overload); one module; exported from `workflows/index.ts`. Duck
  narrow matches `node-tool.ts:58`.
- **D3** — Duck-typed `err.issues` detection in `conversations.ts`,
  `composition.ts`, and CLI `run.ts` `formatScopeValidationError`; body is
  `{ error: "scope validation failed", issues }`. No `instanceof ZodError`, no
  `.flatten()`.
- **D4** — Structural `SessionScopeLike` in `config.ts` (exact shape from spec),
  re-exported via `index.ts` and re-exported into CLI `discover.ts`;
  `isSessionScopeShape` all-or-nothing duck check (object + `schema` +
  string[] `redactKeys` + `parse`/`toJsonSchema` fns). Core surface is flat
  (`.defaults`/`.presets`/`.redactKeys` top-level).
- **D5** — `available: instantiate || scope !== undefined` applied identically
  in `routes/agents.ts` and `routes/composition.ts`; `schema` via try/catch →
  null (`scopeJsonSchema`), `defaults: scope?.defaults ?? instantiateDefaults`,
  `presets: scope?.presets ?? null`.
- **D6** — Constructor parses `defaults` and every preset against the composed
  schema, stores frozen *parsed copies* (`validateNamed` returns
  `schema.parse(...)`, never the caller ref), throws naming `defaults` /
  `preset "<name>"`. Both failure paths tested.
- **D7** — No `preset` wire key. Dashboard materializes presets client-side and
  posts materialized values; preset name never sent.
- **D8** — Response `context` populated for `hasHook || hasScope`; additional
  `scope` mirror only when `hasScope`; hook-less+scope-less stays byte-identical
  `{id, agent_id}` (pinned in `conversation-scope.test.ts`).
- **D9** — `hasHook || hasScope` widening in all three sites: registry entry
  `context` (`:204`), response branch (`:208`), and the run-metadata stamp
  feeder gates on `entry.context !== undefined` (`:423`), which is now populated
  for scope-only registrations.
- **D10** — `effective = rawScope ?? shallowCopy(scope.defaults ?? instantiateDefaults)`;
  parsed value flows to instantiate, redactContext, run-metadata, and
  buildScopeHost; redact keys = union. Composition delivered route gets the
  same parse treatment + the previously-missing shallow copy.
- **D11** — `scope.parse(effective ?? {})` makes a required-field, defaults-less
  scope a deliberate bare-POST 400; documented in the catalog and pinned by test.
- **D12** — `ap run`: precedence gains `scope.defaults`; parse before
  instantiate; `buildScopeHost` into `new Conversation({ host })`; banner uses
  `unionRedactKeys`. Acceptance widened to `hasHook || hasScope`.
- **D13** — CC runner tool execution left scope-less with a precise TODO
  explaining why (SDK MCP tool loop + `Playbook.execute` has no ctx param);
  prompt rendering IS scope-aware (`_buildOptions` → `_renderCtx`). Documented
  limitation, as authorized.
- **D14** — `docs/catalog.ts` updated (create request `scope` + deprecated
  `context` alias, response `scope`/`context`, instantiation
  `available`/`schema`/`presets` + verbatim-defaults note); `docs.test.ts` green.
- **D15** — Example migrated schema-first: `SessionScope` + `scopeItem`,
  `type WorkspaceScope = ScopeValue<…>`, wrapper gains `scope`, `instantiate`
  drops its cast (parse supplies typing), `instantiateDefaults` dropped. Core-only
  import, so the `readScope` demo is correctly skipped.
- **R1** — `Awareness.scopeRender` + `static fromScope(scopeLike, fn, base?)`;
  `toPrompt(ctx?)` appends `\n\n`+fn(scope) after existing content incl. the
  no-sources fallback, skips empty string, byte-identical nullary.
- **R2** — `RenderContext` in `atoms/base.ts`, re-exported through
  `atoms/index`, `rendering/sections/base` + `index`, `rendering/index`.
  `fromScope`'s first arg typed structurally (`{ parse(input): unknown }`,
  value via `ReturnType<S["parse"]>`); never re-parsed (test asserts 0 parse
  calls).
- **R3** — `Awareness.replace()` overridden via `this.constructor` to re-attach
  `scopeRender`; survival through withDomain/withDomains/withCapabilities tested,
  plus a plain-Awareness-stays-undefined test.
- **R4** — Signature widening exactly as mapped: `renderInitialPrompt(ctx?)` →
  `renderSections(ctx)`, `toPrompt()` stays nullary, section `render(ctx?)` with
  only `ContextSection` forwarding to `awareness.toPrompt(ctx)` (Background
  nullary), `PromptRenderer.renderInitial(ctx?)`, `renderContinuation`
  untouched, runtime `types.ts` AgentLike + `sdk-bridge.ts` AgentLikeForBridge
  both widened, RunOptions.host doc amended.
- **R5** — `_renderCtx` inline narrow at all three `agent-runner.ts` sites +
  `claude-code-runner.ts:_buildOptions`; `workflows/base.ts` `applyStepModel`
  forwards ctx (the silent-drop trap); deliberately-nullary sites (PromotedAgent,
  judge, composition lens) left untouched.
- **R6** — Purity/byte-compat hard gate met: core snapshots pass WITHOUT `-u`;
  same-instance-different-scope-then-nullary-restores, join-invariant, replace
  survival, and runner-spy scope-delivery tests all green.
- **R7** — Acceptance demo present: `Awareness.fromScope(workspaceScope, (s) =>
  "Acting on behalf of … in workspace … (…).")`, core-only, one shared instance.
- **R8** — No package.json / bun.lock changes in the stack (verified).

### Nits (non-blocking; no action required to clear the gate)

1. `buildScopeHost` freezes a shallow copy (`{ scope: Object.freeze({...parsed}) }`)
   — an addition beyond D2's stated signature. It is safe and defensible (the
   host bag is shared by every render + tool read for the conversation lifetime;
   it is built *after* `instantiate` runs, so it never frozen-blocks a mutating
   hook per D10). Recorded only because it exceeds the literal decision text.
2. The example migration also renames Mission `success_criteria` →
   `successCriteria` (`examples/agents/workspace/agent.ts`). Necessary to compile
   against the current Mission atom, but outside the enumerated D15 changes.
   Benign.
3. The dashboard posts the operator's scope under the `context` wire key (not
   `scope`) for old-server forward-compat. This is spec-anticipated — D5 states
   "Dashboard's existing JSON editor works unchanged with this (posts `context`,
   server aliases)" — so it is adherent, noted here only to preempt a reviewer
   flagging the apparent name mismatch.

### Verification run (build core→runtime first, per build-order law; never root `check`)

- `@agentic-patterns/core` test: **434 passed** (incl. session-scope 22, atoms
  59 w/ fromScope+replace+byte-compat, sections 36, organisms/agent 31 w/
  scope-aware render) — snapshots green without `-u` (R6).
- `agent-runtime` scope/host/runner/conversation suites: **136 passed**
  (scope-host, host-propagation Test 7, as-agent, base ctx-forward,
  agent-runner + stream `_renderCtx`).
- `agent-server` scope suites: **78 passed** (conversation-scope 14,
  conversation-context 18, composition 30, docs 16).

## Diff Review — Quality

**Reviewer:** quality lens (spec-blind) · **Target:** `main...feat/scope-render` (HEAD `6d28e80`; PRs #309/#310/#311) · **Against:** quality-canvas

**Verdict: PASS_WITH_NOTES**

Well-built across the board. The one feature — a typed, declarative `SessionScope` — is threaded cleanly through every layer (core molecule → runtime host bag → server route → CLI → dashboard form) with consistent naming, honest error handling, and disciplined layering. All five packages typecheck under strict TS, pass biome, and every suite is green (core 434, runtime 1109/+2 pre-existing unrelated skips, server 269, cli 140, dashboard 389). No `.skip`/`.only`/`.todo` added, no `ts-ignore`/`ts-expect-error` in source, `as any` confined to test payloads with justified `biome-ignore`s.

### Strengths (load-bearing craft)

- **Layering discipline is exemplary.** `RenderContext` is placed at layer 0 (`atoms/base.ts`) so both rendering and an atom-level render hook can reference it without atoms importing upward. The runners deliberately do NOT import `workflows/scope-host.ts`'s `hostOf` (that would be a reverse-layer import, since `workflows` depends on `runner`) and instead carry a small inline `_renderCtx` narrow with a comment naming the exact constraint. Correct call, correctly explained.
- **API-surface honesty.** `readScopeAs` is documented as "a cast, not validation" and deliberately does not re-parse. `ClaudeCodeRunner`'s `TODO(#308)` openly states that `host.scope` reaches the CC *prompt* but NOT CC *tool execution* (the SDK-MCP tool loop has no `ToolExecutionContext` seam), and explains why half-wiring it would be worse than the uniform absence. This is exactly the kind of asymmetry that usually gets silently shipped; here it's surfaced.
- **Duck-typed boundaries done right.** `SessionScopeLike` / `isSessionScopeShape` mirror `SessionScope`'s flat public surface and never `instanceof` across the CLI-discovered-agent / dual-build module boundary, consistent with the existing `AgentIntrospect`/`CapabilityLike` precedent. The flat surface (`.defaults`/`.presets`/`.redactKeys` as top-level readonly, not nested under `.options`) keeps the structural type simple.
- **Defensive against silent-drop bugs.** `toAgentRegistration` is an explicit field-by-field map (not a spread) *and* is exported specifically so a test asserts every field survives the CLI→server trip by identity — precisely because a dropped `scope` field would fail silently (server sees `scope: undefined`, zero errors).
- **Redaction is echo-only and shared.** The unredacted parsed scope reaches tools via `buildScopeHost`; only the response echo and run-metadata stamp are redacted. `redactContext`/`isPlainRecord` were extracted to `routes/redact.ts` so the create route and composition-preview route redact identically (the drift they'd otherwise leak is called out).
- **Validation fails fast and specifically.** `SessionScope` parses defaults and every preset at construction with label-naming errors (`preset "bad" failed validation…`). Server/CLI parse scope before `instantiate`/model work; malformed hand-rolled scope returns a diagnosable 502 ("scope.parse returned a non-object") rather than crashing redaction with a raw 500.
- **Tests are honest and end-to-end.** `host-propagation.test.ts` Test 7 drives scope through the full rail (CoordinatorStep → AgentRunner → nodeTool → delegated node) and asserts the child actually observed the root scope, plus the negative (no `host.scope` → `ctx.scope` stays `undefined`, no accidental default). Not stubbed.
- **Back-compat framed precisely.** The dashboard client posts under the legacy `context` wire key even in #308 mode, with a comment explaining that an independently-deployed pre-#308 server would silently 201-and-discard an unknown `scope` key — a real cross-version trap, correctly avoided.

### Notes (non-blocking)

1. **`_renderCtx` is duplicated verbatim in `AgentRunner` and `ClaudeCodeRunner`** (identical 2-line `host.scope` narrow + near-identical comment). The reverse-layering rationale for not importing `hostOf` is sound, but both runners live in the *same* layer — a tiny shared helper (e.g. `runner/host.ts` or a `runner/types.ts` export) would remove the drift risk without violating layering. Two copies is acceptable; flagging as the one spot where a shared util fits.
2. **Comments encode cross-file line numbers** (`node-tool.ts:58`, `composition.ts:733/744-745`, `useChat.ts:142`, `AgentLensPage.tsx:329`, and others). The rationale-heavy commenting is a genuine asset here, but line-number references rot silently as those files change; symbol/function references would age better. Recurs across the stack.

### Nits (trivial)

3. `foldToolParams` casts `prop.enum` to `string[]` unconditionally. Correct for `z.enum` (string members, which the scope form assumes) but would mis-type a numeric/native enum; a one-line "assumes string enum members" note would make the assumption explicit.
4. `isPlainRecord` (`routes/redact.ts`) doesn't exclude `Date` the way core's `isRecord` (`atoms/base.ts`) does — harmless for a `z.object` parse result, but the two record-guards now diverge slightly.

None of the above blocks the merge.

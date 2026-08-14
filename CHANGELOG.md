# Changelog

## Unreleased

### Features

- **evals**: Memory-behavior eval set (#446, `evals/memory-behavior/`) — five families over the shipped Phase 1 surface with the companion (#445) as subject: recall+cite, save-on-instruction, supersede-don't-duplicate, scope-confinement, and budget marked-truncation (the last fully deterministic — `assembleRecall` as a FunctionStep node target, no model). Store-STATE scorers close over each family's fresh `InMemoryMemoryStore` and assert what was written (a live record "contradicts" only when it asserts the old fact without the new — a correction mentioning both is correct). Persistence mirrors `ap eval` (`startEvalRun` + `createEvalResultRecorder` into the standard events db); `just eval-memory` runs it; `--dry` restricts to deterministic families; exit codes are CI-gated. These families are ADR-0008 D7's promotion gates in waiting (Phase C, #435). First full live run: 5/5 PASS on the claude-CLI runner.

- **agent-runtime**: `buildCompanionAgent` preset + the `companion` playground agent (#445) — the first-party generalist assistant with cross-session memory, and the memory layer's dogfood instrument. Composition: memory-discipline Judgment (save durable facts, supersede on correction, search before guessing, cite recalled answers; never save secrets, never invent memories), scope-bound `memoryCapability` (partition fixed at build time — per-conversation rebinding via the registration's `instantiate` hook), `Awareness.fromRecall` over a base domain naming cross-session memory as an information source, and NO pinned model (#179). `agents/companion/agent.mjs` boots the persistent default store via `loadMemoryStore()` and pairs the toolbox with the #444 turn-1 recall wiring over the SAME store instance; `AP_USER` (default `"local"`) names the partition, `context: { user }` overrides per conversation. `just companion` runs the demo; runbook in `docs/memory/guide.md` §Quickstart.

- **agent-runtime, agent-server, agent-cli**: Playground memory wiring (#444, ADR-0007 D8a) — turn-1 recall now has a route from a registration to the rendered prompt. A registration may declare `memory: { store, scope, budgetChars? }` (agent-file-owned store — typically `loadMemoryStore()`, the SAME instance its `instantiate` hook binds into `memoryCapability`, so toolbox writes and recall share one store; author-declared partition scope as a static string map or a function of the PARSED effective context, resolved once at creation, 502 on empty/non-string-map/throwing derivations). At FIRST-message time — when the user text exists to serve as the query, per the pinned ordering — `POST /conversations/:id/messages` calls `assembleRecall(store, scope, { query })` and sets the finished block on the conversation's mutable host bag (`host.recall`); both runners' `_renderCtx` now narrow `host.recall` alongside `host.scope` into the `RenderContext` handed to `renderInitialPrompt`, with empty-string recall treated as absent (rendering stays byte-identical when nothing was recalled). Assembly is a one-shot, best-effort latch: a failed assembly logs and the turn streams without recall; later turns re-render the same block (the bag persists, never re-fetches). The `agent.memory.recall` emission publishes on the shared bus with freshly-minted trace/run ids (host-side, pre-stream — exporters already tolerate row-less runIds). CLI discovery threads a duck-typed `memory` wrapper declaration (all-or-nothing structural check, same rule as `scope`) through `toAgentRegistration` by identity. Memory-less registrations keep their hostless behavior byte-identically.

### Fixes

- **docs**: retired the internal eval-surface roadmap and corrected `runners.md` §2.5 (#487) — `docs/eval-surface.md` was a 368-line internal planning artifact shipped on the public docsite, claiming the eval engine is wired "to no store, no CLI, no server route, and no UI" — false on all four (`EvalStore`, `ap eval`, `POST /eval/runs`, and the dashboard compare view all ship) — and citing absolute paths on a contributor's laptop. Moved to `.ai-docs/design/` and delisted from the Design-notes sidebar. In `docs/runners.md` §2.5, items 1 and 7 claimed structured output and `abortSignal` were missing; `runStructured()` and `RunOptions.abortSignal` both ship. Item 7 is corrected with the honest remaining caveat: `run()` still never forwards the signal to `generateText`, so a cancel during a long model call keeps burning tokens. Items 2-6 re-verified accurate and left alone. Laptop paths neutralized across the four other docs that carried them.

- **agent-runtime, agent-cli**: orphaned `'running'` rows are swept when the store is opened, not just in the playground (#495) — `RunStore.sweepRunning()` had exactly ONE call site (`playground.ts`), so the server and every other `load*` consumer left rows stuck `'running'` forever after a crash, while three comments in the tree promised "the next boot's `sweepRunning()`". The sweep moves into `loadRunStore` / `loadEvalStore` / `loadConversationStore` — the seam every consumer already goes through — and the swept count is returned on the load result (`swept`), so the playground banner keeps printing it. Opt OUT via `sweepOnOpen: false`, not in: a stuck `'running'` row is never what an operator wants, and forgetting to opt in is how they accumulated. A directly-constructed `new RunStore(...)` still sweeps nothing — the constructor stays side-effect-free. All three stale comments corrected to name the real seam.

  Correction to the #482 epic text: `sweepRunning()` was described there as dead code. It is not — `playground.ts:604` called it. The real, narrower bug was the single call site.
- **examples**: `examples/agents` is typechecked, and the silent schema drift it was hiding is fixed (#489) — the workspace member had no `tsconfig.json` and no `typecheck` script, so `bun run typecheck` (`--filter='*'`) skipped it entirely. Adding both surfaced exactly two errors, both the same live bug: `pipeline2/subagents/curator.ts` and `toolsmith/agent.ts` passed `success_criteria:` where the schema is `successCriteria`. Zod strips the unknown key, so BOTH missions rendered with no Success Criteria section at all — silently, in the canonical multi-agent example the docs point newcomers at. `include` is scoped to this member only; `examples/live-demo.ts` and `server-demo.ts` sit one level up and carry 14 further errors, a deliberate follow-on.

- **agent-runtime**: bound `@anthropic-ai/sdk` below the next major (#494) — the range was `>=0.93.0`, an unbounded runtime *dependency*, so any future major would install automatically into every consumer and could break their build with no upper guard. The string had been copied from `claude-agent-sdk`'s *peer* range, which is a different contract. Now `>=0.93.0 <1.0.0`; deliberately not `^0.116.0`, because a pre-1.0 caret pins the minor and would conflict with the claude-agent-sdk peer range. Lock still resolves current `0.116.x`. Audited every `dependencies`/`peerDependencies`/`devDependencies` range across all packages and the root — this was the only unbounded spec in the repo.

## core 0.16.0 (2026-07-26)

### Features

- **agent-core**: `definePlay` (#266) — typed play factory, the play-side counterpart of `defineTool`. `execute` args arrive typed from `parameters` (`z.infer`, type-level only — the host boundary already parses them); the callback's return is compile-checked against `returns` (`z.input`), which is now REQUIRED (unlike `defineTool`, where it's optional metadata) — a `definePlay` with no `returns` would be indistinguishable from validation-not-configured. Output is validated at runtime by default and the parsed `z.output` value is what validation sees; `validateReturns: false` opts out. Violations are tagged and, at `Playbook.execute`, renamed to a play-named `{ error }` envelope (`play 'x' output violated its returns schema: …`) — never thrown past that boundary, preserving the `{ error }` envelope plays have always returned on failure (a contract choice for backward compatibility and consistency, not a dependency either `toolbox-executor.ts` or `sdk-bridge.ts` has on it — both already tolerate a throw). Calling `.execute()` on the returned `PlayDefinition` directly (bypassing a `Playbook`) does throw the tagged violation — outside the supported path. No `terminal` (plays are never terminal) and no `ctx` (out of scope, ADR 0005 precedent). Returns a plain, non-generic `PlayDefinition` — no Zod types leak into consumer `.d.ts`. Plain object `PlayDefinition`s are untouched: their `returns` stays metadata-only, exactly as before.
- **agent-core**: `playbook(name, description, plays)` — literal Playbook factory, mirroring `toolbox(...)`; no more one-shot `class X extends Playbook` for static play records. The record is retained by reference; result satisfies `instanceof Playbook` with inherited schema/name/execute behavior.
- **agent-core**: hoisted the returns-violation tag (`Symbol.for`, guard, message constant, constructor) into a shared package-internal module (`molecules/returns-violation.ts`) used by both `defineTool` and `definePlay`, retiring the duplicated `"output violated its returns schema"` string literal across the tool and play sides.
- **docs**: `docs/authoring-a-toolbox.md` — new "Authoring a play" section (envelope semantics, the D2 validate-before-serialize caveat, the tool-wins-on-collision rule); `packages/agent-core/README.md` — Playbook example updated to `definePlay`/`playbook()`.

## 0.38.0 · core 0.17.0 (2026-08-07)

### Features

- **agent-core, agent-runtime**: Memory layer Phase 1 (#417–#422, ADR-0007) — cross-session memory as a first-class Store. **Core** gains `molecules/memory-record.ts`: `MemoryRecord` (Zod schema + `z.infer` types + deep-freezing `memoryRecord()` factory) with `MemoryScope` (flat string map, canonicalized to sorted-key form), the four `kind`s (`fact`/`preference`/`episode`/`profile`), the invalidation-chain fields (`invalidAt`/`supersededBy`), `MemoryTarget` (full ADR-0008 D1 union incl. the guarded `judgment.constraints`/`escalationTriggers` slots, the Role-level `recovery` arm, and the later-phase `manual` arm — the union ships whole because widening a stored record later is breaking), structured payload schemas for the `example`/`awareness` arms validated on write, and `supports` for corroboration. No confidence/salience/decay/embedding fields. `RenderContext` widens with `recall?: string` and `Awareness.fromRecall(fn?, base?)` mirrors `fromScope` (instance-carried, survives `replace()`; rendering is byte-identical when `ctx.recall` is absent). **Runtime** gains `memory/`: the six-method async `MemoryStore` protocol with `InMemoryMemoryStore` beside it, subset-match scope filtering (`{}` matches everything — deliberate, never exposed to the agent), atomic supersede-on-write, `invalidate` as the ONLY mutator of `updatedAt`, and `limit: 0` returning `[]`; `SqliteMemoryStore` on its **own** SQLite file with its own `PRAGMA user_version` ladder (never the `events.db` ladder), FTS5/bm25 for query search and recency ordering for query-less listings, working under both `better-sqlite3` and `bun:sqlite`; `loadMemoryStore()` following the `load*` template and soft-degrading to the in-memory store with a reason rather than failing; and `runMemoryStoreConformance(makeStore)` — the repo's **first exported conformance kit**, the SQLite↔Postgres portability contract, which both impls pass.
- **agent-runtime, agent-dashboard**: Memory observability + agent surface (#420, #421) — `agent.memory.write` / `agent.memory.search` / `agent.memory.recall` events through the four coordinated SSE-formatter guards, the regenerated `sse-event-manifest.json`, the OBSERVABILITY event profile, and the dashboard client event union. Budget units are **characters end-to-end** (`recall` reports `{ count, chars, truncated }`); bytes appear only in the house-rule 512 B preview caps. `MemoryToolbox` exposes `memory_save` / `memory_search` / `memory_list` / `memory_invalidate` with the partition scope **bound at construction** (ADR-0004 instantiate seam) — no `scope` parameter on any tool, no unscoped search reachable, and deliberately **no `memory_delete`** (true forgetting stays a host/privacy operation). `memory_save` enforces the ADR-0008 D2 write-time nudge: a near-duplicate targeted collision in the same scope + target returns a structured conflict envelope demanding supersede-or-re-key instead of silently duplicating. Reads honor the reserved `agent` scope key (`RESERVED_AGENT_SCOPE_KEY` + `matchesAgentConvention`) via a client-side post-filter — documented consequence: a page may return fewer than `limit` hits, with no over-fetch compensation in v1. `memoryCapability(store, scope, opts)` bundles the toolbox with a built-in Manual carrying the standing instruction and save policy.
- **agent-runtime**: Turn-1 recall surface (#422) — `assembleRecall(store, scope, { budgetChars, query, pinCandidates, emit })` returns `{ block, count, chars, truncated }`, assembling profile-kind records first, then optionally-pinned targeted candidates, then search hits against the first user text, capped at `DEFAULT_RECALL_BUDGET_CHARS` (4000) with **marked** truncation — never a silent clip. Ordering is pinned and documented in the module docblock: the HOST calls it at **first-message time** (when the user text exists to serve as the query), not at conversation creation, and passes `result.block` via `RenderContext.recall`. Render purity (ADR-0005) holds — this is the one place recall fetching, formatting, and budgeting live; core only places the finished string.
- **docs**: `docs/memory/guide.md` and `docs/memory/evolution-cookbook.md` downgraded from DESIGN PREVIEW to Phase-1-shipped, with every design question they raised marked RESOLVED (with what shipped) or still flagged for Phase B/C; `docs/store-family.md` MemoryStore row updated to the complete Phase 1 surface.

- **agent-runtime, agent-server**: Conversation-scoped run context (#268, PR-1 of the playground run-scope stack) — `AgentRegistration.instantiate(context)` is promoted from introspection-only to the single delivered-instance factory: `POST /conversations` now accepts an optional `context`, runs the registration's `instantiate` hook (explicit context, else `instantiateDefaults`, else `undefined`), and binds the DELIVERED instance for the whole conversation — both its prompt/closures AND the tool executor derive from it, not the declared `agent`. Context is resolved once at creation and immutable for the conversation's lifetime (a scope change means a new conversation). `contextRedactKeys?: readonly string[]` on a registration redacts declared top-level context keys to `"[redacted]"` (+ a `context_redacted` marker) before the value is echoed on the create response, held on the conversation entry, or persisted — a raw context value never reaches the store. New `RunStore.updateRunMetadata(runId, patch)` shallow-merges into a run's persisted metadata; `POST /conversations/:id/messages` stamps the turn's run row with its (redacted) context from a `finally` wrapping the SSE drain — landing whether the turn completed cleanly, errored mid-run, or the client disconnected — surfaced via the existing `GET /admin/runs/:id`. `GET /agents` summaries gain `instantiation: { available, defaults }`. See `docs/adr/0004-instantiate-as-execution-seam.md`.

### Behavior change

- **agent-server**: Registrations that already declare an `instantiate` hook now have it run on EVERY conversation creation, and the conversation binds whatever it returns instead of the registration's declared `agent`. A hook that rejects now fails conversation creation with a `502` (previously `instantiate` was only reachable via the composition-preview lens and never affected chat). Registrations without an `instantiate` hook are unaffected — byte-identical create-response shape and executor derivation.

## 0.27.1 (2026-07-15)

### Bug Fixes

- **agent-runtime**: `runStructured`'s tier-0 terminal short-circuit now tries two candidates in
  order: the JSON-parsed value first, then the raw terminal string when the parsed value fails
  schema validation. JSON-looking strings no longer trigger an unnecessary tier-2 pass (#273).

## 0.27.0 (2026-07-15)

### Features

- **agent-runtime**: `runStructured` now short-circuits its 2-tier path when a terminal tool result
  validates against the requested schema, using that result directly with no tier-2 model pass;
  invalid terminal results retain the existing tier-2 fallback. This avoids lossy tier-2
  re-conversion of already-structured downstream results (#269 addendum).

### Bug Fixes

- **agent-runtime**: MockRunner now builds and passes a `ToolExecutionContext` (`runId`, `traceId`,
  `parentToolCallId`, `host`) at both tool-dispatch sites, exercising the same #124
  host-passthrough seam as the live runner — no-LLM tests can now observe `delegateTo` pad sharing
  (#269).

### Documentation

- **agent-runtime**: Retired the stale "subagent teams do NOT see the pad" claim from
  `sequentialAgent`'s docs (stale since #124); the actual contract — run-scoped slots shared by
  reference through the delegation fork, branch-scoped isolated, no join across the seam — is
  documented and pinned by a regression suite, and ratified as the default in ADR 0003 (#269).

## core 0.12.0 (2026-07-15)

### Features

- **agent-core**: `lintModelFacingSchema` (#265, PR-2 of #264) — a pure, structural Zod schema linter for constructs unsupported by a model-facing conversion path. Imports only the Zod type surface (no vendor SDK/runtime imports, no env/network) and walks Zod 3 `_def`/Zod 4 `_zod.def` trees version-tolerantly; never throws for a finding and never mutates the schema. Ships two initial dialects as closed, data-driven rule sets (`dialect: "gemini-bifrost"` by default): `gemini-bifrost` catches exclusive numeric bounds (`.positive()`/`.gt()`/`.negative()`/`.lt()`, both directions), unresolvable `z.lazy()` recursion (detected via a DFS active-ancestor set — a non-recursive lazy wrapper stays clean), and `z.tuple(...)`; `openai` catches structured-output object properties that are `.optional()` without a nullable value form (a required-nullable field is clean, and `.optional().nullable()` in either order is intentionally not flagged). An opt-in `requireDescribe` option adds `missing-description` warnings (never errors) for undescribed object-property leaves, recognizing `.describe()` on any transparent wrapper and never letting a parent object's description satisfy its children. `defineTool` does not auto-run this linter (see `docs/authoring-a-toolbox.md` for why) — the intended integration is explicit consumer smoke/CI code.
- **repo**: `tools/check-model-facing-schemas.ts` + `bun run check:model-facing-schemas`, appended to the root `check` pipeline — lints every shipped preset/example tool's `parameters`/`returns`, playbook plays, and core `ManualToolbox`'s built-in tools under `gemini-bifrost`, throwing (labeled by agent/capability/tool/schema) on any finding. Zero findings on the current shipped agents.

## core 0.11.0 (2026-07-14)

### Features

- **agent-core**: `defineTool` — typed tool factory (#264, subsumes #43). `execute` args arrive typed from `parameters` (`z.infer`, type-level only — the host boundary already parses); the callback's return is compile-checked against `returns` (`z.input`); output is validated at runtime by default and the parsed `z.output` value is what the host receives. Violations throw a uniform tool-named error at `Toolbox.execute` ("tool 'x' output violated its returns schema: …") with the `ZodError` as `cause`. Returns a plain, non-generic `ToolDefinition` — no Zod types leak into consumer `.d.ts`. `validateReturns: false` opts out (verbatim output). Plain object definitions are untouched: their `returns` stays metadata-only.
- **agent-core**: `toolbox(name, description, tools)` — literal Toolbox factory; no more one-shot `class X extends Toolbox` for static tool records. The record is retained by reference; result satisfies `instanceof Toolbox` with inherited schema/name/execute behavior.
- **agent-core**: `capability({ name, description, toolbox, manual?, playbook? })` — object-literal Capability factory over the positional constructor (freezing and methods preserved).
- **docs**: `docs/authoring-a-toolbox.md` — before/after authoring guide; fixed the core README molecule example (it instantiated the abstract `Toolbox` with the wrong shape).

## 0.6.2 (2026-07-02)

### Bug Fixes

- **agent-runtime**: `runStructured` now fails LOUD — before any LLM call — when a structured-output schema contains open-object nodes (`z.record` / `.passthrough()` / `.catchall()` / `z.map`), naming the offending paths. Schema-subset providers silently decode open objects to `{}` (Gemini's `responseSchema` conversion drops `additionalProperties`; OpenAI strict mode prohibits open maps). Escape hatch: `RunOptions.allowOpenObjectSchemas: true` downgrades the error to a once-per-schema warning. Portable remedy: carry free-form objects as a JSON-encoded string field and decode after parsing (the wire-seam pattern).

## 0.0.1 (2026-04-12)

### Features

- **agent-core**: Atoms layer — Persona, Judgment, Mission, Background, Awareness, State, Agency, Roster and 6 more
- **agent-core**: Protocols layer — 8 domain protocol interfaces (Task, Project, Tag, User, Sprint, Comment, Document, Environment)
- **agent-core**: Molecules layer — Toolbox, ToolSchema, Manual, Capability with format converters (OpenAI, Claude, Vercel AI)
- **agent-core**: Rendering layer — PromptRenderer with 7 section types (Identity, Boundaries, Capabilities, Context, Mission, Methodology, State)
- **agent-core**: Organisms layer — Role, Agent with fluent builders
- **agent-runtime**: Events + EventBus with profiles, middleware, priority-sorted handlers
- **agent-runtime**: Gates — Safety, RateLimit, HumanApproval, Audit
- **agent-runtime**: AgentRunner — Vercel AI SDK tool loop with parallel execution
- **agent-runtime**: Multi-agent runtime — AgencyRuntime, AgentNode, InProcessTransport, MessagingToolbox
- **agent-runtime**: Conversation with exchange tracking, fork/rollback, streaming
- **agent-runtime**: Exporters — Console, Langfuse, OpenTelemetry
- **agent-runtime**: Presets — coordinator, orchestrator, analyst, retrieval role factories
- **agent-runtime**: ClaudeCodeRunner + SDK bridge for @anthropic-ai/claude-agent-sdk

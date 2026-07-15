# Changelog

## Unreleased

### Features

- **agent-runtime, agent-server**: Conversation-scoped run context (#268, PR-1 of the playground run-scope stack) — `AgentRegistration.instantiate(context)` is promoted from introspection-only to the single delivered-instance factory: `POST /conversations` now accepts an optional `context`, runs the registration's `instantiate` hook (explicit context, else `instantiateDefaults`, else `undefined`), and binds the DELIVERED instance for the whole conversation — both its prompt/closures AND the tool executor derive from it, not the declared `agent`. Context is resolved once at creation and immutable for the conversation's lifetime (a scope change means a new conversation). `contextRedactKeys?: readonly string[]` on a registration redacts declared top-level context keys to `"[redacted]"` (+ a `context_redacted` marker) before the value is echoed on the create response, held on the conversation entry, or persisted — a raw context value never reaches the store. New `RunStore.updateRunMetadata(runId, patch)` shallow-merges into a run's persisted metadata; `POST /conversations/:id/messages` stamps the turn's run row with its (redacted) context after the SSE drain completes, surfaced via the existing `GET /admin/runs/:id`. `GET /agents` summaries gain `instantiation: { available, defaults }`. See `docs/adr/0004-instantiate-as-execution-seam.md`.

### Behavior change

- **agent-server**: Registrations that already declare an `instantiate` hook now have it run on EVERY conversation creation, and the conversation binds whatever it returns instead of the registration's declared `agent`. A hook that rejects now fails conversation creation with a `502` (previously `instantiate` was only reachable via the composition-preview lens and never affected chat). Registrations without an `instantiate` hook are unaffected — byte-identical create-response shape and executor derivation.

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

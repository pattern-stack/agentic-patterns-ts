# Changelog

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

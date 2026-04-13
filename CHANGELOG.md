# Changelog

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

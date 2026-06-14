# Dogfood Readiness Audit — agentic-patterns-ts

**Date:** 2026-06-13
**Context:** First production-agent dogfood. Fresh TypeScript port of a Python agent framework; we expect (and found) port gaps. This audit is the consolidated output of five per-package expert passes (core, runtime, server, dashboard, cli) plus a handoff from a sibling Python consumer project about the Playbook/Capability/Toolbox model.

> **Framing note carried from the sibling project's handoff:** do not let a downstream consumer's incidental hacks define the framework's primitives. The Python side faked a *toolbox-less* capability with an `EmptyToolbox` stub. The TS port does **not** ship that stub — `Capability` requires a real `Toolbox`. Protect that invariant. The *real* idea buried in the hack ("expose only curated plays, hide the raw verbs") is a legitimate, deliberate framework feature — see §3.

---

## 1. The framework as it actually is

`Agent = Role × Background × Awareness × Mission`; `Role = Persona + Judgments + Capabilities + Responsibilities`; `Capability = Toolbox (required) + Manual? + Playbook?`.

**core** (`packages/agent-core`, v0.1.13) — pure, dependency-light primitives (`zod` + `zod-to-json-schema` only). atoms → protocols → molecules → rendering → organisms. Never imports runtime. Terminates in `toPrompt()`/`render()` strings. Two build routes converge on the same `Agent`:
- **Fluent:** `RoleBuilder` (requires persona) → `AgentBuilder` (requires mission). Custom tools = subclass `Toolbox` / `Playbook`.
- **Declarative:** `buildAgentFromConfig(config, { resolver })` where `config.capabilities` are *names* resolved to live `Capability` objects by a host-supplied `CapabilityResolver`. Test asserts byte-identical prompts to the fluent route.

**runtime** (`packages/agent-runtime`, v0.1.13) — turns a built `Agent` into something that runs against a real LLM. Vercel AI SDK v4. `createRunner()` is the zero-config entry; env auto-detect picks a provider (`PROVIDER_PRIORITY`: anthropic, openai, google, groq, mistral, xai, deepseek, openrouter, ollama → `claude` CLI → MockRunner). Events, gates, exporters, multi-agent, persistence, workflow patterns layer on top.

**server** (`packages/agent-server`, v0.1.13) — thin Hono adapter. `createServer(config) → Hono`. No business logic; pure wiring of `AgentRegistration[]` + `adminService` + `eventBus` + `sseExporter`. REST + SSE.

**dashboard** (`packages/agent-dashboard`, v0.1.1 — **lags**) — standalone React 19 SPA operator console. Polls `/admin/*`, streams `/admin/events/stream`, chats via `POST /conversations/:id/messages`.

**cli** (`packages/agent-cli`, v0.1.13) — `ap` binary. Discovers agents via `agents/**/agent.{ts,js,mjs}` default-exporting `{ id, name, agent }`. Commands: `status`, `agents`, `run`, `tools list/call`, `playground`, `init`, `config`.

### The two tool-dispatch paths (the single most important structural fact)

| | Path A — `ToolboxExecutor` | Path B — SDK-bridge / MCP-per-capability |
|---|---|---|
| Used by | `AgentRunner`, `MockRunner`, anything driving a `LanguageModelV1` (incl. `claudeCode()`) | `ClaudeCodeRunner`, `ClaudeCodeAPIRunner` |
| Who owns the tool loop | the framework | Claude Code |
| Dispatch | `createToolboxExecutor(agent).execute(name,args)` | each `Capability` → in-process MCP server (`buildAgentServers`) |
| `toolExecutor` arg | **required** | accepted but **ignored** |
| Play routing | `playbook.execute` (error-envelope) | `playbook.execute` (error-envelope) |
| Collision rule | toolbox tool wins | toolbox tool wins |

A **third, hybrid** path: `claudeCode()` is a `LanguageModelV1` that runs a single-turn SDK `query()`, registers the LLM's offered tools as a throwaway MCP server, and uses `canUseTool` to intercept-and-abort (`behavior:"deny", interrupt:true`) so the tool call surfaces back to `AgentRunner` as a normal `toolCalls` result. Net: Max-sub Claude runs through Path A with the full event vocabulary. **This is the canonical way to get full observability + gate enforcement from Claude.**

---

## 2. Gap register — ranked by what blocks building real agents

### Tier 0 — correctness bugs that silently break a tooled/gated production agent

**T0-1 — ✅ FIXED (commit `f8ba131`, branch `dug/fix-agentrunner-gate-allow`). `AgentRunner` gate-allow detection was unsound (runtime).** `emitIntent` (`runner/agent-runner.ts:88-92`) infers allowed-vs-blocked from `results.length > 0 || gates.length === 0`. But `AgentEventBus.publish` returns `[]` for an *allowed* intent whenever nobody is subscribed to `agent.tool.intent` (gates are not handlers). ⇒ **attach any gate + no exporter subscribed to `agent.tool.intent` ⇒ every tool call throws `ToolCallBlocked` even when all gates allow.** Masked because UX/OBSERVABILITY/DEBUG/TOOLS event profiles include `agent.tool.intent`, so attaching e.g. a `ConsoleExporter` accidentally fixes it. `ClaudeCodeRunner.emitIntent` (`claude-code-runner.ts:145-160`) does it correctly via an `agent.tool.rejected` subscription. The two runner families are asymmetric; `AgentRunner`'s is the buggy one. Existing test only covers the *block* case. **Fix before any gated dogfood.**

**T0-2 — `createToolboxExecutor` is opt-in and silent on omission (runtime).** Call `runner.run(agent, msg)` without `toolExecutor` and every tool call returns `{ error: "No tool executor configured" }` (`agent-runner.ts:365`), loop continues, no throw/warn. `createRunner` does **not** auto-wire it. **Update on investigation:** this is *intentional, tested* behavior — `runner/__tests__/agent-runner.test.ts:519` asserts the missing-executor path yields the error envelope and the loop continues. So it is a **DX footgun / open design decision** (auto-wire in `createRunner` vs fail-fast in `run`), **not** a silent correctness bug. Left unchanged; decide deliberately. Note: the standard build path (CLI `run.ts`, server `conversations.ts`) always wires the executor, so we won't hit it.

**T0-3 — server's unsafe cast hides T0-2 (server).** `routes/conversations.ts:38` casts `AgentLike → AgentWithCapabilities` with `as unknown as`. If an agent lacks `.role.capabilities`, the executor dispatches nothing, silently. Same failure mode as T0-2, one layer up.

### Tier 1 — structural divergences that mislead a production author

**T1-1 — two live, divergent system-prompt renderers (core).** `Agent.getSystemPrompt()` (inline: `## Available Tools`, `## Guidance`) vs `Agent.renderInitialPrompt()` (section path: `## Capabilities` w/ nested headings) produce structurally different prompts from the same Agent. `claude-code-runner.ts:434` uses the inline path; `agent-runner.ts:165,473` uses the section path. Tune a prompt and you may be editing the path your runner ignores. **Decide which is canonical.**

**T1-2 — curated-play exposure is absent, and the leak spans three independent paths (core+runtime).** `Capability.getTools()` unconditionally returns toolbox schemas **+** playbook schemas (`capability.ts:43-49`). No flag/filter/view hides raw verbs. The tool set is re-derived independently in three places, so a core-only fix is incomplete:
- core prompt — `Capability.getTools` / `CapabilitiesSection` / `Role.renderSystemPrompt`
- runtime advertise — `sdk-bridge.ts:68-98` reads `toolbox.tools` + `playbook.plays` **directly**
- runtime execute — `toolbox-executor.ts:97-116` reads them **directly**

A core-only flag would hide verbs from the prompt while leaving them registered + callable (worst case: a hidden-but-invokable verb). **Fix shape:** one authoritative `Capability.getExposedTools()` consumed by all three. Decide all-or-nothing (hide whole toolbox) vs selective (hide named verbs). See §3.

**T1-3 — which Claude path is canonical for production?** `claudeCode()` + `AgentRunner` (full events, intercept-and-abort, gate-enforceable) vs `ClaudeCodeAPIRunner` (CC owns loop, **macOS-only** sandbox via Keychain, `iterations:1`, no `iteration.*`/`llm.*` events, tool durations hardcoded `0`). Materially different observability + gate characteristics.

### Tier 2 — port residue / cleanups

- **T2-1 Orphaned atoms (core):** `Methodology` and `Recovery` are exported with `toPrompt()` but wired into nothing; `MethodologySection` doesn't even use the `Methodology` atom (derives from `Judgment`). `Tone` is half-wired (`IdentitySection` accepts it; `Agent._buildRenderer` never passes it). Either wire or drop from public API.
- **T2-2 Dead config/code:** server `ServerConfig.store` + `staticDir` declared but never wired (`config.ts:73,76`); CLI `helpers/bootstrap.ts` unused; dashboard `api/client.ts:connectSSE` unused.
- **T2-3 Subpath export gap (runtime):** `providers/claude-code.ts:565` docstring imports `@agentic-patterns/runtime/providers`; only `.` is exported. Broken copy-paste.
- **T2-4 Provider deps (runtime):** `@ai-sdk/*` packages are undeclared (deps/peerDeps/peerDepsMeta) — `import()`-ed at runtime; the install hint says **pnpm** in a **bun** repo. Production authors must hand-install. Tier model-id maps are hardcoded/speculative with no resolvability smoke test.
- **T2-5 Toolbox/Playbook asymmetry (core):** tools throw on error; plays return `{ error }` + JSON-roundtrip (loses `Date`/`undefined`). Model sees them identically. Collision rule lives only in runtime, not core; core `getTools()` would emit duplicate schemas on a name clash with no dedup.

### Tier 3 — server/dashboard contract drift (blocks the dashboard's conversations UI)

- **T3-1 Missing REST endpoints (server):** dashboard calls `GET /admin/conversations`, `GET /conversations/:id`, `GET /conversations/:id/messages`, `GET /messages/:id/parts` — **none exist**. `AdminServiceProtocol.getConversations()` exists but is unrouted. The entire Conversations section is dead on arrival. Dashboard v0.1.1 lags server v0.1.13.
- **T3-2 Event-type prefix mismatch (dashboard):** `EventStream` keys badge tones on `agent.*`; `useEventStream`/exporter emit bare names ⇒ live events may all render grey. Verify against `SSEExporter` output.
- **T3-3 Server hardening (server):** no auth on any route (incl. the `/hooks/:eventType` ingress and CC session transcripts); conversation `Map` leaks unboundedly (no DELETE/TTL); no concurrent-message guard per conversation; no `event: error` SSE frame on mid-stream failure.

### Tier 4 — multi-agent is explicitly MVP

`AgencyRuntime`/`AgentNode`: in-process transport only (`agency-runtime.ts:92`); every node gets only a synthetic `messaging` capability — **no spec-driven domain tools** (`:225-231`); timeout-based (not consensus) termination; node runner errors `break` silently (not surfaced on bus/status); tool calls dropped from per-turn history. **Single-agent (`AgentRunner`) is the only blessed production path for v1.**

### CLI-specific (driving real agents from the terminal)

`ap run` has **no gate/safety layer** (CLI gap #7) and **ignores `AGENT_TIER`/`AGENT_MODEL`** while `playground` honors them (#12) — same agent, two models. `agent` is duck-typed `any` ⇒ a slightly-off `role` shape yields a silent empty tool list (#3). Hand-rolled `.env` parser (not dotenv).

---

## 3. Architectural decision — curated-play exposure

**Posture:** the TS port got the load-bearing decision right — `Capability` requires a real `Toolbox`; there is no `EmptyToolbox`. **Do not make `toolbox` optional.** That is the corruption the sibling project nearly committed.

**The real feature** the handoff was groping toward is an *exposure/rendering* concern, not a toolbox-less capability: a capability that **has** the toolbox but **presents only its curated plays**, hiding the raw verbs. Today that is impossible (T1-2).

**Recommended shape (when a real consumer demands it — do not build in a vacuum):** introduce a single authoritative accessor, e.g. `Capability.getExposedTools()`, that is the *only* source of advertised+executable tools, and route all three paths (core rendering, `sdk-bridge`, `toolbox-executor`) through it. Add a per-capability visibility mode (`exposeRawTools: boolean`, or a per-verb allowlist). The seam already exists because the model cleanly separates `toolbox.getToolSchemas()` (verbs) from `playbook.getPlaySchemas()` (plays). **Validate the need against the first agent that wants it (triage), then design deliberately.**

---

## 4. Dogfood plan

**Build target (confirmed):** the **standard `AgentRunner`** (Path A) against **remote Ollama at `10.88.111.52`** (`OLLAMA_HOST=http://10.88.111.52:11434`, qwen3-class small models). This puts us directly on the T0-1 code path (now fixed) and on the `createToolboxExecutor` path (T0-2). Small local models *raise* the value of curated-play exposure (T1-2): a tight tool surface keeps a 4–9B model from flailing across raw verbs.

**Order:** pick the first agent → fix the Tier-0 bug(s) the agent's shape forces (gated agent ⇒ T0-1 first) → build → let each gap surface in priority order → fix as we go. The dogfood *is* the test.

**First agent (confirmed): a task-management triage agent** — triage of *tasks & projects*, built against core's own protocol interfaces. Maximizes stack coverage, dogfoods the protocol layer, and closes the handoff loop.
- **Toolbox** = raw verbs over the `Task`/`Project`/`Sprint`/`Tag`/`Comment`/`User` protocols (`packages/agent-core/src/protocols/`): e.g. `search_tasks`, `get_task`, `set_status`, `assign`, `add_label`, `comment`, `move_to_project`. Side-effecting verbs → exercises gates → forces T0-1 + motivates an approval gate.
- **Playbook** = curated plays (`triage_task`, `groom_backlog`, `escalate`) → exercises play-dispatch + is exactly the case that wants "expose only curated plays" → validates T1-2's `getExposedTools()` need with a real consumer.
- **Manual** → exercises progressive disclosure / `ManualToolbox`.
- Servable over HTTP + watchable in the dashboard → exercises server + SSE + surfaces T3-1.
- **Open: backing system.** The toolbox implements the protocol interfaces against *something* — options: (a) an in-memory fake impl (pure dogfood, zero external deps, cleanest first build), (b) Linear (MCP available), (c) Notion (MCP available), (d) GitHub Projects/Jira. Recommend (a) for the first build to keep the loop hermetic, then swap the impl behind the same protocol for a real backend.

---

## 5. Decisions captured (2026-06-13)

**D1 — ToolExecutor: keep the seam; make a missing executor LOUD, not silent (T0-2).** The `ToolExecutor` is a *router*, not a backend. The Toolbox already carries per-tool execution (`molecules/toolbox.ts` — each `ToolDefinition.execute`, dispatched by `Toolbox.execute`), and the backing **platform** (in-memory fake / Linear / Notion) is injected *into* the toolbox by the author. `createToolboxExecutor(agent)` just flattens the agent's capabilities into the single `execute(name,args)` the runner calls (handling `mcp__` prefixing, tool-vs-play precedence, collisions). The seam is worth keeping — it's the interception point for mocks, record/replay, metering, permission-wrapping, remote dispatch — and it keeps runtime's coupling to core narrow (`AgentLike` + `ToolExecutor`, no Capability import). The graceful-degradation-on-missing-executor has exactly one real value (not crashing a half-streamed message); the **silent** part has none. **Eventual intended behavior:** keep the graceful flow but emit a warning / `agent.error`-style event the first time it fabricates a `"No tool executor configured"` result. Longer-term option to revisit: **auto-wire**, since the executor is *fully derivable from the agent* (unlike a backend, which must be injected) — blocked today only by the deliberate `AgentLike` narrowing. *Decision: "loud for now."*

**D2 — Curated-play exposure: one authoritative `Capability.getExposedTools()` (T1-2).** Confirmed direction. A core-only flag would hide a verb from the prompt while leaving it registered + callable (the worst case). The fix routes all three derivers — core rendering, runtime `sdk-bridge.ts`, runtime `toolbox-executor.ts` — through a single `Capability.getExposedTools()`, plus a per-capability visibility mode (all-or-nothing vs per-verb allowlist, TBD). **Never make `toolbox` optional.** Build the triage agent first and let its curated plays prove the shape before implementing.

## 6. Open decisions for the lead
1. First agent / domain — **task-management triage (confirmed)**; remaining sub-decision is the backing system (in-memory fake recommended for build #1).
2. Fix Tier-0 first, or build-and-fix-as-we-go (T0-1 is forced either way once gates are attached).
3. File the gap register as GitHub issues, or track here only.
4. T1-1: which renderer is canonical?
5. T1-3: which Claude path is canonical for production?
6. T1-2: all-or-nothing vs selective verb hiding for `getExposedTools()`.

*Expert teammates retained (core, runtime, server, dashboard, cli) — addressable for deeper dives.*

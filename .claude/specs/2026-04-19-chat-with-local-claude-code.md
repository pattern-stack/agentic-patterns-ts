# Chat with a local Claude Code session from the dashboard

Spec date: 2026-04-19
Owner: runtime + cli
Status: draft — ready to build

## Goal

Let a user open `http://localhost:3456/chat`, pick a "Claude Code" agent from the agent dropdown, type a message, and receive a streaming response from a real `claude` subprocess running locally. Follow-up messages in the same conversation must share context with prior turns (same Claude Code session), and tool calls the child `claude` makes must appear inline on the SAME conversation's event stream via the existing hook bridge.

## Non-goals

- No PermissionRequest approval UI (tools run via `bypassPermissions` as today).
- No persistent session history / resume-from-dashboard across server restarts.
- No retirement of the existing `/claude-code` page — stays as-is.
- No changes to `claudeCode()` provider / `canUseTool` path. This feature uses `ClaudeCodeAPIRunner` only; they are distinct code paths.
- No new exporters, protocols, or gate types.

## Current state (verified in code)

- `packages/agent-server/src/routes/conversations.ts:40` — `Conversation` is constructed with `reg.runner` directly; the server honors whatever runner the registration carries.
- `packages/agent-server/src/config.ts:25` — `AgentRegistration.runner` is already a required field of the public shape.
- `packages/agent-cli/src/commands/playground.ts:90-96` — `runPlaygroundCommand` unconditionally overwrites each registration's runner with the shared `createRunner()` result. This is the first bug we need to fix: a registration's explicit `runner` is silently dropped.
- `packages/agent-runtime/src/runner/claude-code-runner.ts` — `ClaudeCodeRunner.run/stream` spawns a fresh SDK `query()` per call. It sets `AP_RUNNER_CORRELATION_ID` env var, which `hooks/emit.mjs:23-26` forwards to `/hooks/:eventType` as `x-ap-runner-correlation-id`, which `packages/agent-server/src/routes/hooks.ts:44` uses to suppress double-counted `agent.tool.start/end` while still publishing the raw `claude_code.hook`. This plumbing already exists — we reuse it, not rebuild it.
- `packages/agent-runtime/src/runner/claude-code-api-runner.ts` — `ClaudeCodeAPIRunner` extends `ClaudeCodeRunner` and only overrides `_buildOptions` to block the file/bash/agent tools. No session tracking.
- SDK surface (`@anthropic-ai/claude-agent-sdk` v0.2.x) exposes `SDKOptions.resume?: string` (session UUID to resume). `SDKSystemMessage`, `SDKAssistantMessage`, and `SDKResultMessage` all carry a `session_id: string` field. Reference the type names only — line numbers shift between minor SDK releases.

## Architecture decision

### Session continuity — recommended: option (a), `resume` via SDK option

Evaluated:
- **(a) `resume: <sessionId>` per follow-up turn** — idiomatic SDK usage. Each turn is still a fresh `query()` call (clean cancellation, no PTY lifecycle), and the SDK takes care of replaying transcript state. Our runner only needs to remember one string per conversation.
- **(b) Long-running PTY, stdin/stdout streaming** — requires managing child process lifetimes, back-pressure, crash recovery, stderr muxing, and a new streaming parser. Much larger blast radius; no benefit over (a) for this use case.

Decision: **(a)**. The `ClaudeCodeAPIRunner` gets a tiny per-instance `Map<correlationId, sessionId>`. On `run/stream`, if `options.traceId` (which we will pin to the conversation id, see below) has a remembered session id, we pass `resume` on the SDK options. While consuming SDK messages, we capture the `session_id` out of the first system/result message and store it under the correlation key. That's the whole mechanism.

Correlation key: we use the conversation id as the stable key. The `Conversation.stream()` path in `packages/agent-runtime/src/conversation/conversation.ts:205` already generates a `traceId` per turn (currently `invocationId`), which is NOT stable across turns. We thread the conversation id into runner options using the existing `RunOptions` without adding a new field by re-purposing the server call site — detail:

- **Simplest wiring, no new `RunOptions` field:** the server's conversation route creates a `Conversation`, gets its `conversation.id`, and after construction assigns a per-conversation tag onto the runner via a new one-line opt-in API. We add a single public method on `ClaudeCodeAPIRunner`: `bindConversation(conversationId: string): void` that sets a "current conversation id" on the runner. But a per-instance runner shared across conversations makes that racy.

  **Chosen instead:** give each conversation its own `ClaudeCodeAPIRunner` instance when the agent registration says so. Concretely, `AgentRegistration.runner` becomes a *factory OR instance* — if the registration exports `runner` as an object with a `forConversation(conversationId): RunnerProtocol` method, the server calls it; otherwise the instance is used directly as today. The Claude Code agent registration opts into the factory shape and returns a fresh `ClaudeCodeAPIRunner` per conversation, each holding its own `sessionId`. This is one short interface addition, backward compatible with every existing registration (calculator/todo/writing-coach are unchanged).

### Per-agent runner override in `ap playground`

In `runPlaygroundCommand`, change the mapping so `reg.runner ?? runner` wins (not `runner` always). For agents with no explicit runner, the shared `createRunner()` result is still used. The Claude Code agent registration sets its own runner and bypasses the shared one entirely — which is the correct outcome, because `createRunner()` might pick the Ollama runner and we specifically want the Claude Code subprocess for this agent.

### Tool visibility default

Recommendation: the Claude Code agent registered in `agents/claude-code/agent.mjs` uses `ClaudeCodeAPIRunner` — which by default disallows `Read/Write/Edit/Bash/Glob/Grep/Agent/NotebookEdit/TodoRead/TodoWrite/WebFetch/WebSearch`. That is strictly safer for a "chat with Claude Code from a browser" affordance on a developer's machine and already matches the existing `ClaudeCodeAPIRunner` contract. Users who want full-tool Claude Code should construct `ClaudeCodeRunner` directly in their own `agent.mjs`; we will document that in a short comment at the top of the new `agent.mjs`. Leave the "should the chat agent expose Bash?" tuning to the user's own project — out of scope for this spec.

### Authentication

No changes. The SDK's subprocess inherits the user's shell env; `~/.claude` OAuth or `ANTHROPIC_API_KEY` is used exactly as for the existing `/claude-code` page. Documented in the new `agent.mjs` header comment only.

### Hook fan-out — already wired, nothing to do

Because `ClaudeCodeRunner` sets `AP_RUNNER_CORRELATION_ID` for the duration of the SDK call, the child `claude`'s `emit.mjs` shim POSTs every hook with `x-ap-runner-correlation-id`, and `hooks.ts` attaches that header to the published `claude_code.hook` event. The dashboard's per-conversation event subscription already listens to the shared bus. Tool calls made by the spawned claude therefore appear on the same conversation's stream with no mapper work. **Call out in code comments; do not add new glue.**

## File-by-file changes

### New files

- `agents/claude-code/agent.mjs` — new registration file. Exports a default factory:
  ```
  export default () => ({
    id: "claude-code",
    name: "Claude Code",
    description: "Chat with a local claude subprocess (API-mode: MCP tools only).",
    agent: buildClaudeCodeChatAgent(),  // a minimal AgentLike; see notes
    runner: {
      forConversation(conversationId) {
        return new ClaudeCodeAPIRunner({ /* eventBus bound later by Conversation */ });
      },
    },
  });
  ```
  The agent body can be constructed with a trivial `AgentBuilder` call (no tools — MCP capabilities are the only tool path available under `ClaudeCodeAPIRunner`, and this chat agent registers none). Mirror the structure of `agents/calculator/agent.mjs`.

### Modified files

- `packages/agent-server/src/config.ts`
  - Introduce a type alias `RunnerLike` for the existing required shape (renaming only — no behavior change for existing registrations):
    ```ts
    export type RunnerLike = Pick<RunnerProtocol, "run" | "stream"> & {
      run(agent: AgentLike, message: string, options?: Record<string, unknown>): Promise<RunResult>;
    };
    export interface RunnerFactory {
      forConversation(conversationId: string): RunnerLike;
    }
    ```
  - Widen `AgentRegistration.runner` to `RunnerLike | RunnerFactory` — **still required** (not optional). Widening the union does not break existing callsites that pass a concrete runner object; they satisfy `RunnerLike` as they do today.
  - Export a narrow type guard:
    ```ts
    export function isRunnerFactory(x: RunnerLike | RunnerFactory): x is RunnerFactory {
      return typeof (x as RunnerFactory).forConversation === "function";
    }
    ```
  - **Callsite inventory for the widening (verified via grep on `.runner` accesses against `AgentRegistration`-typed values):**
    - `packages/agent-server/src/routes/conversations.ts:40` — `new Conversation(reg.agent, reg.runner, ...)`. **This is the one call site that reads `reg.runner`** and must be updated to resolve the factory (see below).
    - `packages/agent-cli/src/commands/playground.ts:90-96` — constructs `AgentRegistration` objects with `runner: runner` (concrete). No read of `.runner` from an `AgentRegistration`-typed value; compatible.
    - `packages/agent-server/examples/live-demo.ts:49` — constructs a registration with a concrete runner. Compatible.
    - `packages/agent-server/src/__tests__/app.test.ts:27,289` (and other test registrations) — pass concrete `runner` objects. Compatible.
    - README / doc examples — illustrative only, show concrete runners. Compatible.
  - **Decision:** keep `runner` required and union-widen; do not introduce a `resolveRunner(reg, conversationId)` helper because there is exactly one read site (the conversations route), where the `isRunnerFactory` check is inlined for clarity.

- `packages/agent-server/src/routes/conversations.ts`
  - In the `POST /conversations` handler, after generating the `conversation.id`, resolve the runner to a per-conversation instance:
    ```ts
    const runner = isRunnerFactory(reg.runner)
      ? reg.runner.forConversation(conversation.id)
      : reg.runner;
    const conversation = new Conversation(reg.agent, runner, { toolExecutor });
    ```
    Conversation ctor already stores the runner on the instance, so follow-up turns on the same conversation reuse the SAME runner instance and therefore the SAME `sessionId` cache entry. (The in-flight 409 guard is specced separately — see task list step 3a below.)

- `packages/agent-cli/src/commands/playground.ts`
  - Change the map at lines 90-96 to prefer a per-agent runner:
    ```ts
    const registrations: AgentRegistration[] = opts.agents.map((reg) => ({
      id: reg.id,
      name: reg.name,
      description: reg.description,
      agent: reg.agent,
      runner: reg.runner ?? runner, // reg.runner is RunnerLike | RunnerFactory | undefined
    }));
    ```
    For agents with no explicit runner (`reg.runner` is `undefined` on the discovery side), the shared `createRunner()` result is still used. No other changes to the file; banner, static mount, and openBrowser are unchanged.

- `packages/agent-cli/src/helpers/discover.ts`
  - **Widen the `DiscoveredAgent` interface** to surface the optional runner exported from the user's `agent.mjs`:
    ```ts
    // at top of file, import the union from the server package (cli already depends on server)
    import type { RunnerLike, RunnerFactory } from "@agentic-patterns/server";

    export interface DiscoveredAgent {
      readonly id: string;
      readonly name: string;
      readonly description?: string;
      // biome-ignore lint/suspicious/noExplicitAny: ...
      readonly agent: any;
      /** Optional runner exported from the agent file. Playground prefers this over the shared runner. */
      readonly runner?: RunnerLike | RunnerFactory;
      readonly file: string;
    }
    ```
    Also widen the local `AgentExport` interface in the same file to include `runner?: unknown`.
  - **Update `loadAgentFile`** to propagate the field. After the existing destructuring and validation of `id/name/agent`, add:
    ```ts
    const { id, name, description, agent, runner } = exported as AgentExport;
    // ... existing validation ...
    // Accept runner only if it is an object with run/stream OR a RunnerFactory with forConversation.
    let discoveredRunner: RunnerLike | RunnerFactory | undefined;
    if (runner != null) {
      if (typeof runner !== "object") {
        throw new Error(`${file}: 'runner' must be a RunnerLike object or RunnerFactory`);
      }
      const r = runner as Partial<RunnerLike> & Partial<RunnerFactory>;
      const looksLikeFactory = typeof r.forConversation === "function";
      const looksLikeRunner = typeof r.run === "function";
      if (!looksLikeFactory && !looksLikeRunner) {
        throw new Error(
          `${file}: 'runner' must expose 'run' (RunnerLike) or 'forConversation' (RunnerFactory)`,
        );
      }
      discoveredRunner = runner as RunnerLike | RunnerFactory;
    }
    return { id, name, description, agent, runner: discoveredRunner, file };
    ```
    Factories that return `{ id, name, agent }` (no runner) continue to work; only new ones that include `runner` see the new behavior.
  - **Update the top-of-file docstring** that currently says "The `runner` field is NOT defined by the user" — it now *may* be defined by the user, and if so overrides the shared runner in `playground.ts`.

- `packages/agent-runtime/src/runner/claude-code-runner.ts`
  - Introduce one protected hook — pure refactor, default no-op:
    ```ts
    /** Called at most once per run() / stream() invocation with the first session_id seen in SDK messages. */
    protected _onSessionId(_sessionId: string): void {
      // no-op in base class
    }
    ```
  - **Concrete invocation point** — at the top of the `for await (const msg of query(...))` loop, BEFORE the existing `if (msg.type === "...")` type-dispatch, in BOTH `run()` and `stream()`:
    ```ts
    let capturedSessionId: string | null = null;
    for await (const msg of query({ prompt, options: sdkOpts })) {
      if (capturedSessionId == null && typeof (msg as { session_id?: unknown }).session_id === "string") {
        capturedSessionId = (msg as { session_id: string }).session_id;
        this._onSessionId(capturedSessionId);
      }
      // ... existing type dispatch unchanged ...
    }
    ```
    This fires exactly once per run on the first SDK message that carries a string `session_id` (every `SDKSystemMessage` / `SDKAssistantMessage` / `SDKResultMessage` does). The `capturedSessionId` guard prevents repeat calls even though every subsequent message also carries the same id.

- `packages/agent-runtime/src/runner/claude-code-api-runner.ts`
  - Per-conversation instances hold their own session. Add:
    1. A private `#sessionId: string | undefined` instance field.
    2. Override `_onSessionId` to store the id:
       ```ts
       protected override _onSessionId(sessionId: string): void {
         this.#sessionId = sessionId;
       }
       ```
       Because the registration's `forConversation(conversationId)` returns a fresh `ClaudeCodeAPIRunner` per conversation, the field is inherently per-conversation; no `Map` is needed. If a future use case shares one runner instance across conversations, the base hook can be re-implemented to take a correlation key — out of scope here.
    3. Override `_buildOptions` (still calling `super._buildOptions`) to set `sdkOpts.resume = this.#sessionId` when defined. Turn 1 has no resume; turn 2+ resumes the captured session.

- `packages/agent-runtime/src/runner/index.ts` (barrel)
  - Re-export `ClaudeCodeAPIRunner` if not already exported (verify — it may already be). No new symbols beyond that.

### Files intentionally NOT modified

- `hooks/emit.mjs` — correlation forwarding already in place, no change.
- `packages/agent-server/src/routes/hooks.ts` — handles `x-ap-runner-correlation-id` already, no change.
- `packages/agent-runtime/src/events/claude-code-mapper.ts` — no change.
- `packages/agent-dashboard/**` — the ChatPage already populates from `/agents` and sends to `/conversations/:id/messages`; Claude Code appears automatically once the registration is discovered.

## Step-ordered task list

1. **Runner extension point.** In `claude-code-runner.ts`, add the protected `_onSessionId` hook and call it from the SDK message loops in both `run` and `stream` at the concrete invocation point documented above. Keep behavior identical for subclasses that don't override it. Add a focused unit test that asserts `_onSessionId` is called exactly once per run with the SDK's `session_id` value (mock the `query()` generator).
2. **Session-aware API runner.** In `claude-code-api-runner.ts`, add the `#sessionId` field, override `_onSessionId` to store it, and override `_buildOptions` to set `resume` when present. Unit test: two back-to-back `run()` calls on the same instance assert the second call's `sdkOpts.resume` equals the first call's captured session id.
3. **Registration shape widening.** In `packages/agent-server/src/config.ts`, rename the existing runner shape to `RunnerLike`, introduce `RunnerFactory`, widen `AgentRegistration.runner` to the union (still required), add and export `isRunnerFactory`. Update `packages/agent-server/src/routes/conversations.ts` to resolve per-conversation via the guard.
3a. **Concurrency guard (409 busy).** In the same `conversations.ts` edit, add a module-scoped `const inFlight = new Set<string>();`. In the `POST /conversations/:id/messages` handler, if `inFlight.has(conversationId)` respond with HTTP 409 `{ error: "busy" }`. Otherwise add the id before invoking `conversation.stream(...)` and remove it in a `finally` that runs after the stream completes or errors. Test: two concurrent POSTs — second returns 409. Split from step 3 for reviewability; same file, different concern.
4. **Discovery + playground per-agent runner.** In `packages/agent-cli/src/helpers/discover.ts`, widen `DiscoveredAgent` with `runner?: RunnerLike | RunnerFactory`, widen `AgentExport` to include `runner?: unknown`, and update `loadAgentFile` to validate + forward the exported `runner` onto the returned `DiscoveredAgent` (see file-by-file section for the exact validation). Update the file-level docstring. Then in `packages/agent-cli/src/commands/playground.ts`, change the registrations map to `runner: reg.runner ?? runner`.
5. **Register the agent.** Add `agents/claude-code/agent.mjs` returning `{ id, name, description, agent, runner: { forConversation } }`. Smoke test: `bun run --filter=@agentic-patterns/cli build` + `ap playground` shows "Claude Code" in the dropdown.
6. **Integration test** (see below).
7. **Docs.** Inline comments only: a header comment on `agents/claude-code/agent.mjs` explaining auth inheritance + the default-deny tool list (`Read/Write/Edit/Bash/Glob/Grep/Agent/NotebookEdit/TodoRead/TodoWrite/WebFetch/WebSearch`, copied verbatim from `claude-code-api-runner.ts`); a short NOTE in `claude-code-api-runner.ts` pointing at `hooks.ts` for the correlation-forwarding story so the next reader doesn't reinvent it.

## Tests to add

- `packages/agent-runtime/src/runner/__tests__/claude-code-runner-session.test.ts`
  - Mock the `query()` async iterator to yield `{ type: "system", session_id: "abc" }` then a terminating result. Assert `_onSessionId("abc")` fired once.
- `packages/agent-runtime/src/runner/__tests__/claude-code-api-runner-resume.test.ts`
  - First `run()` captures `sessionId="abc"`. Mock the SDK to record the `SDKOptions` passed to the second `run()`; assert `resume === "abc"`.
- `packages/agent-server/src/__tests__/conversations-claude-code.integration.test.ts`
  - Real integration: register a `ClaudeCodeAPIRunner`-backed agent via the factory shape, POST `/conversations`, POST two messages ("my favorite color is periwinkle", then "what did I just say my favorite color was?"). Assert the second response text contains `periwinkle`. **Guard with vitest's `it.skipIf(!process.env.AP_E2E_CLAUDE_CODE)`** (or `describe.skipIf(...)` at the suite level) so `bun run check` stays green without the env var set — per CLAUDE.md, `bun run check` must pass in CI. A second test with the SDK mocked asserts the runner instance is reused and `resume` is set on turn 2; that test is NOT env-gated and runs in CI.
- `packages/agent-cli/src/commands/__tests__/playground-runner-override.test.ts`
  - A registration with an explicit `runner` survives `runPlaygroundCommand`'s mapping step; one without gets the shared default.

## Acceptance criteria

- [ ] `ap playground` in this repo shows a "Claude Code" entry in the agent dropdown.
- [ ] Selecting it and sending "hello" streams a response from a real local `claude` subprocess.
- [ ] Sending a second message (same conversation) demonstrates shared context: the integration test's "periwinkle" assertion passes locally.
- [ ] Two simultaneous conversations with the Claude Code agent have independent session ids (verified by the runner factory producing two instances — confirm via unit test that `forConversation` returns distinct objects).
- [ ] Registrations without an explicit `runner` (calculator/todo/writing-coach) still work unchanged — existing tests continue to pass.
- [ ] `claude_code.hook` events for the child claude's PreToolUse/PostToolUse arrive on the same conversation's SSE stream (checked by running the integration test with a tool-invoking prompt and inspecting the bus output).
- [ ] `bun run check` passes.

## Concurrency & edge cases (documented behavior, minimal code)

- **Two concurrent conversations** with the Claude Code agent — each gets its own `ClaudeCodeAPIRunner` via `forConversation`, each holds its own `sessionId`. No shared state between them. Confirmed by the factory approach.
- **User sends turn 2 while turn 1 is still streaming** — the server's conversation route calls `conversation.stream(content, ...)` synchronously per request. The existing route does not serialize two simultaneous messages for one conversation; today, concurrent requests would race on the same runner. **Recommended canonical behavior for this feature: reject with HTTP 409 "busy"**. Implement with a tiny per-conversation in-flight flag inside `conversations.ts` (a `Set<string>` of conversation ids currently streaming). Add this in step 3. Simpler than a queue, avoids unbounded memory, and matches most chat UIs. Dashboard already disables the composer while `streaming` is true, so this is defense-in-depth.
- **Session id never arrives** (SDK shape changes, corrupted run) — `_onSessionId` simply never fires, `#sessionId` stays undefined, turn 2 starts a fresh Claude Code session. Degrades to "no context carryover" rather than crashing. Acceptable.
- **User abandons a conversation** — runner instance is held by the `Conversation` which is held by the in-memory `conversations` Map on the server. On process exit everything goes away; Claude Code's on-disk session transcript at `~/.claude/projects/...` is not cleaned up. Out of scope for this spec.

## Out of scope (future work)

- PermissionRequest approval UI (rendering `PermissionRequest` hook events as interactive prompts in the dashboard).
- Persistent conversation history that survives server restart and can resume past Claude Code sessions (needs a `ConversationStoreProtocol` implementation that records `sessionId` alongside the exchange log).
- Retiring or merging the existing `/claude-code` page with `/chat`.
- Allowing users to toggle the tool allow-list from the UI (today: the `ClaudeCodeAPIRunner` default of MCP-only is hard-coded).

## Validator Response

All must-fix items from validator review resolved in-spec:

1. **Discovery plumbing fully specified.** File-by-file section now shows the concrete diff to `DiscoveredAgent` (new optional `runner?: RunnerLike | RunnerFactory` field imported from `@agentic-patterns/server`), the `AgentExport` widening, the `loadAgentFile` propagation with validation, the docstring update, and how `playground.ts` merges it with the shared runner via `reg.runner ?? runner`.

2. **`AgentRegistration.runner` widening — callsite inventory documented.** `runner` stays required; the type widens to `RunnerLike | RunnerFactory`. Only one call site actually reads `reg.runner` (`conversations.ts:40`) and it inlines the `isRunnerFactory` guard. All construction sites (`playground.ts`, `live-demo.ts:49`, `app.test.ts:27/289`) supply concrete runners and satisfy `RunnerLike` unchanged. Decision recorded: no `resolveRunner` helper — single read site, inline guard is clearer.

3. **`_onSessionId` trigger location concrete.** Spec now shows the exact code: `let capturedSessionId: string | null = null;` local to the run loop, and at the top of the `for await` body (before the existing type dispatch) check `if (capturedSessionId == null && typeof msg.session_id === "string")`, assign, and call `this._onSessionId(...)`. Present in both `run()` and `stream()`. Base class hook is a no-op; `ClaudeCodeAPIRunner` overrides to store `#sessionId`.

Minor fixes resolved:

- Step 3a split out of step 3 for the 409 busy-check (same file, distinct concern).
- Stale SDK line-number citations removed; type names only (`SDKSystemMessage`, `SDKAssistantMessage`, `SDKResultMessage`, `SDKOptions.resume`).
- Integration test now explicitly gated with `it.skipIf(!process.env.AP_E2E_CLAUDE_CODE)` so `bun run check` stays green; the mocked companion test is unguarded and runs in CI.
- `RunnerLike` naming clarified as a rename of the existing `Pick<RunnerProtocol, "run" | "stream"> & {...}` shape with zero behavior change.
- Default-deny tool list named verbatim in the task-list doc step for builder to copy into the `agent.mjs` header.

Items explicitly preserved (validator flagged as correct): SDK `resume` for session continuity; factory-shaped per-conversation runners; `reg.runner ?? sharedRunner` in playground; MCP-only tool surface via default deny-list; correlation-id plumbing description.

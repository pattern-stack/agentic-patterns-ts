# Codex review — harness-runners design (Gate 0)

**Reviewer:** Codex CLI, model gpt-5.6-sol, reasoning=high, read-only sandbox
**Date:** 2026-07-19
**Target:** design.md (v1 draft)

---

## 1. VERDICT: REVISE

The two-seam architecture is sound, and most repository inventory claims are accurate. However, the Codex model, adapter contract, decision vocabulary, and dependency ordering are not implementation-ready. The current plan would force a redesign during B-4 and would not satisfy the stated “interactive permission intercept on every harness” requirement.

No files were modified.

## 2. BLOCKERS

1. **The Codex enforcement assumption is stale.**

   Codex is not merely advisory. Current Codex has several pre-execution enforcement mechanisms:

   - App Server sends server-initiated JSON-RPC approval requests before command execution and file changes, then waits for the client’s decision.
   - `PreToolUse` hooks can deny or rewrite supported local tool calls before execution.
   - Exec-policy rules can mark command prefixes `forbidden`.
   - The sandbox independently blocks unauthorized filesystem/network access.

   App Server’s command decisions include `accept`, `acceptForSession`, `decline`, `cancel`, and `acceptWithExecpolicyAmendment`; file-change decisions are a smaller vocabulary. [App Server approvals](https://developers.openai.com/codex/app-server), [Codex hooks](https://developers.openai.com/codex/hooks), [Codex rules](https://developers.openai.com/codex/rules).

   The capability is not globally binary, though. `PreToolUse` covers shell, `apply_patch`, MCP, and most local function tools, but not hosted tools, and specialized paths can opt out. Therefore [`gates: "enforcing" | "advisory"`](</Users/dug/Projects/sandbox/agentic-patterns-ts/.ai-docs/stacks/harness-runners/design.md:149>) is too coarse. Enforcement must be declared per operation/tool class.

2. **`HarnessAdapter` is one-way, but both permission bridges are bidirectional.**

   [`start()` returning only an `AsyncIterable`](</Users/dug/Projects/sandbox/agentic-patterns-ts/.ai-docs/stacks/harness-runners/design.md:146>) cannot:

   - Respond to an App Server request by JSON-RPC request ID.
   - Resolve a Claude Code `canUseTool` promise.
   - Interrupt or cancel a turn.
   - Reject a timed-out request in the harness’s native protocol.
   - Close the subprocess and drain pending requests.
   - Support steering/resume without inventing out-of-band casts.

   `HarnessSession` needs explicit controls, approximately:

   ```ts
   interface HarnessSession extends AsyncIterable<HarnessEvent> {
     respond(requestId: string, decision: HarnessDecision): Promise<void>;
     interrupt(reason?: string): Promise<void>;
     close(): Promise<void>;
   }
   ```

   The event vocabulary also needs an explicit `approval-request` carrying native request/thread/turn/item IDs. A `tool-start` event is not a substitute because App Server can report a pending item before it is approved or executed.

3. **`AskDecision` cannot correctly represent either harness.**

   The proposed union at [design.md:225](</Users/dug/Projects/sandbox/agentic-patterns-ts/.ai-docs/stacks/harness-runners/design.md:225>) conflates unrelated operations:

   - Codex command approval supports session acceptance and exec-policy amendment, not generic `updatedInput`.
   - Codex file-change approval does not support command-rule amendment.
   - Codex permission requests return a granted subset of filesystem/network permissions with turn/session scope.
   - Codex distinguishes `decline` from `cancel`.
   - Codex App Server approval responses do not accept an arbitrary denial reason.
   - Claude Code `updatedPermissions` is a structured rule update, not merely `"session" | "always"`.
   - Claude Code also carries `decisionClassification`, which is telemetry, not policy state.

   “Emulate `always` in the bridge” would silently turn an approval click into durable policy mutation. That requires an explicit storage scope and separate authorization.

   Use a request-specific vocabulary, or at minimum capability-tagged decisions such as `allowOnce`, `allowSession`, `deny`, `cancel`, `rewriteInput`, `amendExecPolicy`, and `grantPermissions`. Validate requested decisions against `availableDecisions`.

4. **`CODEX_HOME` is not a complete isolation boundary.**

   `CODEX_HOME` holds user config, state, file-based credentials, history, skills, and similar data, but Codex still discovers repository `AGENTS.md` and trusted project `.codex` configuration below the working tree. An empty `CODEX_HOME` therefore does not mean an empty/fresh Codex configuration. [Codex config locations](https://developers.openai.com/codex/config-advanced), [AGENTS.md discovery](https://developers.openai.com/codex/guides/agents-md).

   Authentication also needs a separate design:

   - File-based credentials live in `CODEX_HOME/auth.json`.
   - Keyring credentials live outside `CODEX_HOME`.
   - ChatGPT subscription login is cached browser/device authentication.
   - `CODEX_ACCESS_TOKEN` is an enterprise automation path.
   - API-key login is the documented default recommendation for programmatic automation.

   There is no documented general-purpose ChatGPT OAuth-token environment injection analogous to `CLAUDE_CODE_OAUTH_TOKEN`. [Codex authentication](https://developers.openai.com/codex/auth).

   The `AGENTS.md` prompt-mount proposal also needs composition rules. A generated global `CODEX_HOME/AGENTS.md` loads before project instructions, and deeper project instructions can override it. It must not overwrite a profile’s existing `AGENTS.md`.

5. **Section 8 intentionally validates the abstraction too late.**

   The ordering at [design.md:311](</Users/dug/Projects/sandbox/agentic-patterns-ts/.ai-docs/stacks/harness-runners/design.md:311>) extracts a large base before resolving the second implementation’s protocol. That is exactly backwards for the known differences above.

   Required dependency corrections:

   - R-1 before finalizing B-2, not merely before B-4.
   - B-3 depends on R-1 because the permission-session API must represent Codex decisions.
   - B-4 depends on B-3; otherwise it ships without the cross-cutting permission requirement.
   - B-1 depends on F-1 because it consumes SDK message types changed by the upgrade.
   - If B-1 precedes B-2, acknowledge translator churn rather than calling B-2 behavior-preserving.
   - A-3 must depend on A-1 and the accepted A-2 strategy.

6. **Track A cannot be added to the current provider registry as an S-sized change.**

   `ProviderProtocol` assumes availability is detected through environment variables and its `name` is a closed `SupportedProvider` union. A Claude subscription is neither. See [providers/types.ts](</Users/dug/Projects/sandbox/agentic-patterns-ts/packages/agent-runtime/src/providers/types.ts:17>).

   Additionally, `createRunner()` currently classifies `claude-*` models as Anthropic and throws immediately when `ANTHROPIC_API_KEY` is absent, before reaching the CLI fallback. See [create-runner.ts](</Users/dug/Projects/sandbox/agentic-patterns-ts/packages/agent-runtime/src/runner/create-runner.ts:263>) and [model-resolver.ts](</Users/dug/Projects/sandbox/agentic-patterns-ts/packages/agent-runtime/src/providers/model-resolver.ts:205>). A subscription rung therefore needs an availability/auth probe and revised model/provider mismatch behavior, not simply a `PROVIDERS` entry.

## 3. NOTES

- **Existing human-input plumbing is real but only boolean.** The gate awaits an async callback, and the repository has `agent.input.request`, `PendingInputRegistry`, SSE delivery, and `POST /conversations/:id/input`. See [approval.ts](</Users/dug/Projects/sandbox/agentic-patterns-ts/packages/agent-runtime/src/gates/approval.ts:10>), [approval-gate.ts](</Users/dug/Projects/sandbox/agentic-patterns-ts/packages/agent-runtime/src/interaction/approval-gate.ts:52>), and [conversations.ts](</Users/dug/Projects/sandbox/agentic-patterns-ts/packages/agent-server/src/routes/conversations.ts:364>). But the transport only accepts approve/deny plus a string value. It cannot currently preserve edits, session rules, cancellation, granted permission subsets, native `availableDecisions`, or timeout-vs-decline through the whole stack.

- **The claimed gate order is wrong.** Section 5.3 says safety → approval → rate-limit → audit. Actual order is safety → rate-limit → approval → audit in [base.ts](</Users/dug/Projects/sandbox/agentic-patterns-ts/packages/agent-runtime/src/gates/base.ts:14>).

- **F-2 needs a public evaluation API.** `AgentEventBus.publish()` currently owns private gate-chain execution and returns subscriber results, not a gate outcome. See [agent-event-bus.ts](</Users/dug/Projects/sandbox/agentic-patterns-ts/packages/agent-runtime/src/events/agent-event-bus.ts:54>). Define something like `evaluateIntent(): GateEvaluation` and have `publish()` use it; do not let the runner inspect `bus.gates` and recreate ordering/modification logic.

- **Modified intents must affect execution.** If a gate rewrites arguments, the bridge must return the resulting intent to the adapter. Adding an optional decision payload while keeping `publish()`’s current shape risks approving one argument set and executing another.

- **“Native ask → gate chain” is insufficient for AP-defined policy.** App Server only requests approval when Codex’s own policy requires it. If an AP gate wants to inspect every supported call, the adapter needs a `PreToolUse` bridge or equivalent. Native approval requests alone do not expose every tool call before execution.

- **Capability probing needs diagnostics.** `probe(): Promise<boolean>` cannot distinguish missing binary, unsupported protocol version, unauthenticated state, API-key auth, ChatGPT auth, managed-policy rejection, or missing approval capability. Return a structured result including CLI version, auth mode, supported protocol revision, and per-feature capabilities.

- **The normalized event model is too lossy.** It lacks approval requests, output deltas, status/error/declined states, cancellation, thread/turn/item IDs, file-change semantics, permission requests, and parent-child relationships. Codex exposes command, file change, MCP, dynamic tool, collaboration/subagent, compaction, plan, diff, and token-usage events as distinct concepts. [App Server event model](https://developers.openai.com/codex/app-server).

- **Synthetic events need provenance.** A synthesized `llm.start` cannot truthfully claim input size or start time. Mark translated/synthetic events in metadata so downstream latency metrics do not treat reconstructed boundaries as causal measurements.

- **Correlation environment mutation is concurrency-unsafe.** `ClaudeCodeRunner` temporarily mutates global `process.env` in [claude-code-runner.ts](</Users/dug/Projects/sandbox/agentic-patterns-ts/packages/agent-runtime/src/runner/claude-code-runner.ts:86>). Parallel runs can restore each other’s values. Put correlation IDs directly in each subprocess’s `options.env`.

- **CC isolated mode currently fails open.** If no OAuth token resolves, `_buildOptions()` does not apply `CLAUDE_CONFIG_DIR` at all, inheriting host configuration despite “isolated” mode. See [claude-code-runner.ts](</Users/dug/Projects/sandbox/agentic-patterns-ts/packages/agent-runtime/src/runner/claude-code-runner.ts:552>). Track A must fail closed rather than reuse this behavior verbatim.

- **The SDK facts are otherwise correct.** The lockfile installs 0.2.141; `SDKAssistantMessage` contains a `BetaMessage`; results contain turn, duration, cost, usage, model-usage and denial fields; npm currently reports 0.3.215. The package is a hard dependency despite [docs/runners.md](</Users/dug/Projects/sandbox/agentic-patterns-ts/docs/runners.md:108>) describing it as an optional peer.

## 4. NITS

- “app-server/proto mode” should be replaced with “App Server.” The installed Codex CLI 0.144.6 has no `proto` command.
- The existing HTTP return leg is `POST /conversations/:id/input`, not an “admin POST.”
- `deferred_tool_use`’s installed type only proves `{id, name, input}` exists; it does not prove host-execution or resume semantics. F-3 remains necessary.
- “~90% event parity” is an unsupported percentage. Describe the concrete recoverable and irrecoverable fields instead.
- “Both cells already exist in `cc-config.ts`” only establishes the Claude Code matrix, not the proposed Codex profile semantics.
- `costUsd` has nowhere canonical to land in the current `RunResult` or event vocabulary.
- A floating `^0.3.x` dependency plus a host CLI is not reproducible. Record the tested SDK/CLI pair and protocol schema fixture.

## 5. CODEX FACT-CHECK

### Section 5.3 table

- **`codex exec`:** Correct that it is non-interactive and unsuitable for a live approval roundtrip. It does support `--json`, producing a JSONL event stream with `thread.started`, `turn.*`, `item.*`, and `error`, but this is output telemetry, not a bidirectional approval protocol. [Non-interactive mode](https://developers.openai.com/codex/noninteractive).
- **App Server:** This is the correct integration surface. It uses bidirectional JSON-RPC over stdio JSONL by default and supports server-initiated approval requests.
- **`proto`:** Stale/removed terminology. Do not target it.
- **Hard blocking:** Codex can hard-block before execution through App Server decisions, `PreToolUse` hooks, exec-policy rules, and sandbox policy. The design’s advisory fallback should apply only to uncovered tool classes, not to Codex as a whole.
- **Approve with edits:** Codex `PreToolUse` supports `updatedInput`; App Server approval replies do not expose generic updated input. These must remain separate mechanisms.

### OQ-2

Most of OQ-2 is answerable now:

- App Server approval shapes are documented and versioned.
- App Server stdio and `codex exec --json` are two different JSONL schemas.
- `CODEX_HOME` relocates user state but does not suppress repository instruction/config discovery.
- `AGENTS.md` loads globally from `CODEX_HOME`, then project-root-to-cwd, with closer files winning.
- ChatGPT subscription auth works through cached login/device login; file auth can be placed under `CODEX_HOME`, while keyring auth lives outside it.
- API-key login and enterprise `CODEX_ACCESS_TOKEN` are documented automation seams; raw ChatGPT OAuth env injection is not.

Keep R-1 for empirical isolation/auth and minimum-version tests, not basic protocol discovery.

### B-4

Revise B-4 to:

- Use only App Server’s stable JSON-RPC surface.
- Generate and pin TypeScript/JSON schemas from the validated Codex CLI version.
- Implement server-request correlation and exactly-once responses.
- Translate command, file-change, MCP, permission, subagent, compaction, usage, cancellation, and failure events explicitly.
- Declare enforcement coverage per operation type.
- Combine App Server native approvals with `PreToolUse` only if AP policy must inspect calls that Codex would otherwise auto-execute.
- Specify how generated role instructions compose with profile and repository `AGENTS.md`.
- Treat credentials separately from profile contents.

### R-1

R-1 should precede B-2 and produce executable contract tests for:

- Minimum supported CLI version and generated protocol schema.
- Command/file/permission approval roundtrips.
- Decline, cancel, timeout, and disconnect behavior.
- Concurrent server requests and exactly-once response handling.
- `PreToolUse` coverage and hosted-tool exclusions.
- Empty/custom `CODEX_HOME` with file auth versus keyring auth.
- Global and repository `AGENTS.md` composition.
- Fresh, resume, fork, and interrupted-session behavior.
- `codex exec --json` versus App Server event differences.

Until those revisions are reflected in the design, execution should not begin.
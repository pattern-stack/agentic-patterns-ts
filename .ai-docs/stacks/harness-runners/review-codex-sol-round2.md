# Codex review round 2 — harness-runners design v2

**Reviewer:** Codex CLI, model gpt-5.6-sol, reasoning=high, read-only sandbox
**Date:** 2026-07-19
**Target:** design.md v2

---

# VERDICT: REVISE

V2 genuinely closes the repository-isolation, dependency-ordering, provider-registry, gate-order, and terminology findings. However, it is still not implementation-ready. The revised permission contract cannot represent all current Claude Code and Codex outcomes, D13 conflicts with OQ-7, the proposed gate/audit flow does not support the promised decision semantics, and the Claude SDK availability model is factually wrong for the installed SDK.

No files were modified.

## ROUND-1 CLOSURE TABLE

| Round-1 finding | Status | Evidence |
|---|---|---|
| B1. Codex enforcement must be per operation | **Partially addressed** | V2 adds `OperationClass` and an enforcement matrix at [design.md:230](/Users/dug/Projects/sandbox/agentic-patterns-ts/.ai-docs/stacks/harness-runners/design.md:230). But `network` overlaps other classes, “advisory/unsupported” remains ambiguous, gates do not declare required coverage, and the document cannot yet implement its run-start compatibility check. |
| B2. Adapter must be bidirectional | **Partially addressed** | `HarnessSession.respond/interrupt/close` and explicit approval requests are present at [design.md:184](/Users/dug/Projects/sandbox/agentic-patterns-ts/.ai-docs/stacks/harness-runners/design.md:184). However, resume/steering is absent, the event-ID claim is not reflected by the union, and “exactly-once replies on disconnect” is not a realizable transport guarantee. |
| B3. `AskDecision` vocabulary was inadequate | **Partially addressed** | The tagged union at [design.md:295](/Users/dug/Projects/sandbox/agentic-patterns-ts/.ai-docs/stacks/harness-runners/design.md:295) is a substantial improvement. It still cannot encode Claude `updatedPermissions`, omits Codex network-policy amendments, and contradicts D13’s promised explicit storage scope. |
| B4. `CODEX_HOME`, auth, and `AGENTS.md` isolation | **Addressed** | Workspace discovery, file versus keyring credentials, and global/project instruction composition are explicitly covered at [design.md:366](/Users/dug/Projects/sandbox/agentic-patterns-ts/.ai-docs/stacks/harness-runners/design.md:366). |
| B5. Dependency ordering | **Addressed** | R-1 precedes B-2; B-3 and B-4 are ordered; B-1 follows F-1 with translator churn acknowledged; A-3 depends on A-1/A-2. See [design.md:435](/Users/dug/Projects/sandbox/agentic-patterns-ts/.ai-docs/stacks/harness-runners/design.md:435). |
| B6. Track A was not an S-sized provider entry | **Addressed** | A-3 is now M-sized, probe-backed, outside `PROVIDERS`, and explicitly revises `claude-*` mismatch behavior at [design.md:148](/Users/dug/Projects/sandbox/agentic-patterns-ts/.ai-docs/stacks/harness-runners/design.md:148). Its particular CLI-presence probe is nevertheless based on a newly discovered false SDK assumption; see blocker 6. |
| N1. Existing human-input plumbing is only boolean | **Partially addressed** | The widening is correctly scoped to `PendingInputRegistry`, SSE, and `POST /input` at [design.md:281](/Users/dug/Projects/sandbox/agentic-patterns-ts/.ai-docs/stacks/harness-runners/design.md:281). The rich gate-result contract required to drive it is still undefined. Current callbacks remain boolean at [approval.ts:10](/Users/dug/Projects/sandbox/agentic-patterns-ts/packages/agent-runtime/src/gates/approval.ts:10). |
| N2. Gate order was wrong | **Addressed** | V2 now uses safety → rate-limit → approval → audit, matching [base.ts:14](/Users/dug/Projects/sandbox/agentic-patterns-ts/packages/agent-runtime/src/gates/base.ts:14). |
| N3. Public `evaluateIntent` needed | **Partially addressed** | F-2 names the API and makes `publish()` delegate at [design.md:323](/Users/dug/Projects/sandbox/agentic-patterns-ts/.ai-docs/stacks/harness-runners/design.md:323), but `GateEvaluation` and its relationship to existing `GateResult` are not defined. |
| N4. Modified intents must affect execution | **Partially addressed** | Passthrough and unsupported-rewrite failure are stated at [design.md:328](/Users/dug/Projects/sandbox/agentic-patterns-ts/.ai-docs/stacks/harness-runners/design.md:328). Run-start validation is not implementable from the proposed gate or probe contracts. |
| N5. Native asks alone are insufficient | **Addressed** | V2 explicitly layers native approval requests with `PreToolUse` at [design.md:334](/Users/dug/Projects/sandbox/agentic-patterns-ts/.ai-docs/stacks/harness-runners/design.md:334). |
| N6. Probe needs structured diagnostics | **Partially addressed** | `HarnessProbeResult` includes version, auth, protocol, features, and enforcement at [design.md:235](/Users/dug/Projects/sandbox/agentic-patterns-ts/.ai-docs/stacks/harness-runners/design.md:235), but has no structured failure reasons for missing executable, incompatible schema, managed-policy rejection, or failed authentication. |
| N7. Normalized event model was lossy | **Partially addressed** | V2 adds most missing event kinds at [design.md:202](/Users/dug/Projects/sandbox/agentic-patterns-ts/.ai-docs/stacks/harness-runners/design.md:202). Native IDs and parent-child relationships are still absent from most variants despite the following prose claiming otherwise. |
| N8. Synthetic events need provenance | **Partially addressed** | D12 and B-1 require `synthetic: true`, but the design does not explicitly add metadata to `BaseEvent`, which currently has no metadata field at [events/types.ts:30](/Users/dug/Projects/sandbox/agentic-patterns-ts/packages/agent-runtime/src/events/types.ts:30). |
| N9. `process.env` correlation race | **Addressed** | B-2 moves correlation into the session environment at [design.md:466](/Users/dug/Projects/sandbox/agentic-patterns-ts/.ai-docs/stacks/harness-runners/design.md:466). |
| N10. CC isolated mode fails open | **Addressed** | A-1 and D11 make missing isolated authentication an error at [design.md:125](/Users/dug/Projects/sandbox/agentic-patterns-ts/.ai-docs/stacks/harness-runners/design.md:125). |
| N11. SDK facts/dependency-doc discrepancy | **Partially addressed** | Message/result fields, installed version, hard dependency, peer-dependency bump, and docs discrepancy remain correct. The new “SDK spawns host `claude` from PATH” claim is false for the installed SDK. |

## NEW BLOCKERS

1. **The capability-tagged decision contract is still incomplete.**

   - Claude Code’s native allow result can carry `updatedPermissions: PermissionUpdate[]`; the installed SDK explicitly says session “always allow” suggestions should be returned this way. `allowSession` has no rule payload, so it cannot implement that result ([installed sdk.d.ts:155](/Users/dug/Projects/sandbox/agentic-patterns-ts/packages/agent-runtime/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:155), [sdk.d.ts:1858](/Users/dug/Projects/sandbox/agentic-patterns-ts/packages/agent-runtime/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:1858)).
   - Current Codex command approvals also include `applyNetworkPolicyAmendment`, with proposed network amendments and `availableDecisions`. V2’s §5.5, `HarnessDecision`, R-1, and B-4 all omit it. This is documented in the [current App Server contract](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md).
   - D13 says persistent rules are “an explicit, separately-authorized decision kind with an explicit storage scope,” but no Claude permission-update kind exists, and `amendExecPolicy` has no scope field.
   - `DecisionKind` is undefined. A list of kind tags alone also cannot validate that a granted permission is a subset of the request or that an amendment matches a native proposed amendment.

2. **`evaluateIntent` does not connect the existing gate model to rich decisions or audit.**

   Current `GateResult` only supports allow, block, or modified event ([base.ts:34](/Users/dug/Projects/sandbox/agentic-patterns-ts/packages/agent-runtime/src/gates/base.ts:34)); `HumanApprovalGate` returns boolean approval ([approval.ts:31](/Users/dug/Projects/sandbox/agentic-patterns-ts/packages/agent-runtime/src/gates/approval.ts:31)). V2 says `GateEvaluation` returns a decision object but never specifies which component creates it or how existing gates migrate.

   D13’s audit guarantee is also impossible with current semantics: `publish()` returns immediately when a gate blocks, so the later audit gate is skipped ([agent-event-bus.ts:61](/Users/dug/Projects/sandbox/agentic-patterns-ts/packages/agent-runtime/src/events/agent-event-bus.ts:61)). The current `AuditGate` records the intent, not decision kind, actor, native request ID, storage scope, or resulting policy ([audit.ts:28](/Users/dug/Projects/sandbox/agentic-patterns-ts/packages/agent-runtime/src/gates/audit.ts:28)).

   F-2/B-3 need an explicit evaluation/result contract plus a post-decision audit event or equivalent guaranteed audit phase.

3. **D13 and OQ-7 contradict each other.**

   OQ-7 acknowledges that durable policy over the unauthenticated API is unsafe and “not solved here” ([design.md:422](/Users/dug/Projects/sandbox/agentic-patterns-ts/.ai-docs/stacks/harness-runners/design.md:422)). Yet B-3 includes D13 durable authorization, and the risk table claims durable decisions are gated on authenticated actors ([design.md:471](/Users/dug/Projects/sandbox/agentic-patterns-ts/.ai-docs/stacks/harness-runners/design.md:471), [design.md:498](/Users/dug/Projects/sandbox/agentic-patterns-ts/.ai-docs/stacks/harness-runners/design.md:498)).

   The existing return route resolves a globally keyed correlation ID and treats `:id` as addressing sugar; it does not bind the request to the conversation in the route itself ([conversations.ts:447](/Users/dug/Projects/sandbox/agentic-patterns-ts/packages/agent-server/src/routes/conversations.ts:447)).

   The plan must either:

   - make #307/authenticated actor identity a prerequisite for durable decisions;
   - scope a sufficient authorization mechanism into B-3; or
   - omit/disable all durable decision kinds until #307 lands.

4. **The enforcement matrix cannot support its promised run-start failure.**

   `network` is an effect that can occur inside shell, MCP, local tools, or subagents, not a mutually exclusive operation class. A single `Record<OperationClass, status>` loses those intersections.

   More importantly, the current `Gate` interface exposes neither required operation classes nor rewrite requirements ([base.ts:53](/Users/dug/Projects/sandbox/agentic-patterns-ts/packages/agent-runtime/src/gates/base.ts:53)). Therefore the base cannot know at run start that “a gate chain configured to require enforcement” is incompatible with an adapter. The design needs a gate-requirement/capability contract and configured probe context. “Claude Code enforcing across the board” should also be contract-tested rather than asserted.

5. **The event/session contract overclaims IDs, hierarchy, and disconnect replies.**

   The prose says events carry native thread/turn/item IDs and parent-child relationships, but only `approval-request` contains `nativeIds`, and no proposed variant contains a parent relationship ([design.md:202](/Users/dug/Projects/sandbox/agentic-patterns-ts/.ai-docs/stacks/harness-runners/design.md:202)). `permission-request` does not even contain an operation, native IDs, or normalized native payload.

   “Exactly-once replies on disconnect” is also impossible once the response transport is gone. The defensible contract is exactly-once local settlement and at-most-once wire response while connected, with fail-closed cleanup on disconnect. R-1 should test those separate properties.

6. **The Claude SDK executable/availability model is factually wrong.**

   The inventory says SDK 0.2.141 spawns host `claude` from PATH ([design.md:101](/Users/dug/Projects/sandbox/agentic-patterns-ts/.ai-docs/stacks/harness-runners/design.md:101)); D7 calls the CLI binary the true optional prerequisite, and A-3 requires “CLI present.”

   The installed SDK instead says it uses its built-in executable unless `pathToClaudeCodeExecutable` is supplied ([sdk.d.ts:1487](/Users/dug/Projects/sandbox/agentic-patterns-ts/packages/agent-runtime/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:1487)). Its package declares platform-specific executable packages as optional dependencies and records `claudeCodeVersion: 2.1.141` ([package.json:57](/Users/dug/Projects/sandbox/agentic-patterns-ts/packages/agent-runtime/node_modules/@anthropic-ai/claude-agent-sdk/package.json:57)). The lockfile includes that platform package family ([bun.lock:178](/Users/dug/Projects/sandbox/agentic-patterns-ts/bun.lock:178)).

   This matters because the current `hasClaudeCli()` rung can reject an otherwise runnable bundled SDK ([create-runner.ts:296](/Users/dug/Projects/sandbox/agentic-patterns-ts/packages/agent-runtime/src/runner/create-runner.ts:296)). F-1 must re-establish the 0.3.x executable contract, and A-3 should probe actual SDK launch/auth readiness rather than PATH presence.

## NOTES

- R-1 still omits two requested tests: a **minimum supported CLI-version threshold** and **forked-session behavior**. “Pinned validated version” is not the same as specifying a compatibility floor ([design.md:443](/Users/dug/Projects/sandbox/agentic-patterns-ts/.ai-docs/stacks/harness-runners/design.md:443)).
- B-4 otherwise reflects the round-1 correction well: App Server, generated schemas, correlation, explicit event translation, enforcement declaration, `AGENTS.md`, and credential separation are all present.
- Codex App Server/auth claims are broadly correct. Current App Server can initiate managed ChatGPT browser/device login through account RPCs, but there is still no documented general-purpose ChatGPT OAuth environment injection analogous to Claude’s token seam.
- `HarnessProbeResult.ok` needs structured errors/warnings. As written, consumers cannot distinguish “binary absent,” “auth absent,” “schema incompatible,” and “policy disabled this feature.”
- `start(req)` should likely be asynchronous, or the contract must specify how handshake/startup failures appear through the session.
- The cost landing spot is now properly specified for both `RunResult` and `agent.message.complete`.
- D7’s “pinned SDK” language remains imprecise while the manifest uses `^0.3.x`; the lockfile/fixture policy should be named as the actual pinning mechanism.

## NITS

- Replace `advisory/unsupported` prose with one exact matrix value per operation.
- Specify an exact default `askTimeout`, not “~5 min.”
- State whether R-1 pins stable-only App Server schemas or opts into experimental schemas; current schema generation defaults to stable.
- Define `close()` idempotency and whether it is legal before, during, and after terminal delivery.
- Six of the seven round-1 nits are substantively cleared. The remaining reproducibility nit is only partially closed because the SDK/binary pairing model is incorrect.
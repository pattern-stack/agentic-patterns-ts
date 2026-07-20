# Codex review round 3 — harness-runners design v3

**Reviewer:** Codex CLI, model gpt-5.6-sol, reasoning=high, read-only sandbox
**Date:** 2026-07-19
**Target:** design.md v3

---

# VERDICT: REVISE

V3 closes most round-2 findings and is substantially stronger. Repository and SDK claims are accurate, the Codex approach is broadly correct, and the remaining F-3/R-1 spikes are appropriately isolated.

It is not quite implementation-ready because the load-bearing permission contract still has two internal gaps: rich native ask context never reaches the gate callback/audit contract, and one Claude session-rule mapping is not implementable as written.

## ROUND-2 CLOSURE TABLE

| Round-2 finding | Status | Evidence |
|---|---|---|
| B1. Decision contract incomplete | **Partially addressed** | V3 adds `DecisionKind`, proposal references, permission-subset validation, Claude `updatedPermissions`, and both Codex amendment forms at [design.md:341](/Users/dug/Projects/sandbox/agentic-patterns-ts/.ai-docs/stacks/harness-runners/design.md:341). However, `NativeProposal`, `ProposalRef`, and `PermissionSet` remain undefined, request scope constraints are absent, and the Claude no-rule/session mapping is invalid. |
| B2. `GateEvaluation` and guaranteed audit phase undefined | **Partially addressed** | `GateEvaluation`, ordering, modified-intent passthrough, and the guaranteed audit phase are stated at [design.md:391](/Users/dug/Projects/sandbox/agentic-patterns-ts/.ai-docs/stacks/harness-runners/design.md:391). But neither the evaluation input nor the audit-phase interface carries actor, native request ID, proposals, available decisions, resulting policy, or timeout-vs-decline—the very fields the audit promise requires. |
| B3. D13 contradicted OQ-7 | **Addressed** | Durable rule/policy decisions are disabled on the unauthenticated transport until #307 supplies authenticated actor identity; ephemeral decisions remain shippable. See [design.md:379](/Users/dug/Projects/sandbox/agentic-patterns-ts/.ai-docs/stacks/harness-runners/design.md:379). |
| B4. Enforcement matrix/run-start check not implementable | **Addressed** | Network is correctly separated as a sandbox-policy dimension, the matrix has exact values, and `GateRequirements` enables a run-start comparison against enforcement and rewrite support at [design.md:260](/Users/dug/Projects/sandbox/agentic-patterns-ts/.ai-docs/stacks/harness-runners/design.md:260). Claims are now contract-test targets rather than assumptions. |
| B5. Event/session contract overclaimed | **Partially addressed** | Async startup, shared ID envelope, local-settlement versus wire-response semantics, disconnect cleanup, and idempotent close are all present at [design.md:194](/Users/dug/Projects/sandbox/agentic-patterns-ts/.ai-docs/stacks/harness-runners/design.md:194). Remaining defect: an ask’s `requestId` is optional even though `respond()` requires one. |
| B6. Claude SDK executable model wrong | **Addressed** | V3 correctly describes the built-in executable and replaces PATH presence with SDK launch/auth readiness. Installed `sdk.d.ts` says the built-in executable is used by default at [sdk.d.ts:1489](/Users/dug/Projects/sandbox/agentic-patterns-ts/packages/agent-runtime/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:1489); package/lock data confirms SDK 0.2.141 with bundled CC 2.1.141 at [package.json:57](/Users/dug/Projects/sandbox/agentic-patterns-ts/packages/agent-runtime/node_modules/@anthropic-ai/claude-agent-sdk/package.json:57) and [bun.lock:178](/Users/dug/Projects/sandbox/agentic-patterns-ts/bun.lock:178). |
| Note: R-1 lacked version floor and fork tests | **Addressed** | Both are explicit at [design.md:524](/Users/dug/Projects/sandbox/agentic-patterns-ts/.ai-docs/stacks/harness-runners/design.md:524). |
| Note: B-4’s broader Codex direction was sound | **Addressed** | App Server, generated schemas, approval correlation, event translation, credential separation, and instruction composition remain correctly scoped. |
| Note: Codex auth claims | **Addressed/verified** | File credentials versus keyring and the automation guidance match the [official authentication documentation](https://developers.openai.com/codex/auth). |
| Note: probe needed structured diagnostics | **Addressed** | `ProbeIssue[]` distinguishes binary, authentication, schema, policy, and launch failures at [design.md:271](/Users/dug/Projects/sandbox/agentic-patterns-ts/.ai-docs/stacks/harness-runners/design.md:271). |
| Note: `start()` should be async | **Addressed** | `start()` now returns `Promise<HarnessSession>` with structured startup errors at [design.md:197](/Users/dug/Projects/sandbox/agentic-patterns-ts/.ai-docs/stacks/harness-runners/design.md:197). |
| Note: cost landing spot | **Addressed** | `costUsd` is assigned to both `RunResult` and `agent.message.complete` at [design.md:256](/Users/dug/Projects/sandbox/agentic-patterns-ts/.ai-docs/stacks/harness-runners/design.md:256). |
| Note: D7 “pinned SDK” ambiguity | **Addressed** | V3 distinguishes manifest intake range from the lockfile/platform-executable pairing and committed schema fixtures. |
| Round-2 nits | **Addressed** | Exact enforcement values, 300-second timeout, stable-only schema generation, close legality/idempotency, version-floor testing, and reproducibility wording are all corrected. |

## NEW BLOCKERS

### 1. Native ask context is not connected to the gate, transport, audit, or responder

The adapter event contains proposals, available decisions, requested permissions, and native IDs, but `evaluateIntent` accepts only a `ToolCallIntent`. That type currently contains only tool ID/name/arguments at [events/types.ts:81](/Users/dug/Projects/sandbox/agentic-patterns-ts/packages/agent-runtime/src/events/types.ts:81). The proposed `GateEvaluation` does not add request context either.

Consequently:

- `HumanApprovalGate`’s widened callback still has no input from which to construct proposal-referencing or permission-grant decisions.
- The frontend transport cannot reliably receive `proposals`, `availableDecisions`, or requested permissions.
- Audit cannot obtain actor, native request ID, scope, resulting policy, or timeout-vs-decline from the defined contract.
- `HarnessSession.respond()` requires a request ID, while request-event `ids.requestId` remains optional at [design.md:228](/Users/dug/Projects/sandbox/agentic-patterns-ts/.ai-docs/stacks/harness-runners/design.md:228).

Define a typed `AskContext`/`GateRequest` carried into evaluation and the approval callback. It should make the local request ID mandatory for ask variants and contain native IDs, normalized payload, requested permissions, proposals, allowed scopes, available decisions, actor/resolution metadata, and durability-feature state.

The guaranteed audit phase also needs an explicit input contract—such as `audit(evaluation, context)`—because the current `Gate.check(BaseEvent)` signature cannot consume the promised full decision record. Current code confirms that limitation at [base.ts:53](/Users/dug/Projects/sandbox/agentic-patterns-ts/packages/agent-runtime/src/gates/base.ts:53) and [audit.ts:28](/Users/dug/Projects/sandbox/agentic-patterns-ts/packages/agent-runtime/src/gates/audit.ts:28).

### 2. The Claude “session, no rules” mapping violates the proposal-reference rule

The table maps:

> `allowWithRules` scope=session, no rules → allow (+ session-destination rule)

at [design.md:369](/Users/dug/Projects/sandbox/agentic-patterns-ts/.ai-docs/stacks/harness-runners/design.md:369).

Claude’s SDK instead says that an “always allow” choice should return the permission suggestions supplied with the request as `updatedPermissions`; those suggestions are the source of the rule ([sdk.d.ts:155](/Users/dug/Projects/sandbox/agentic-patterns-ts/packages/agent-runtime/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:155)). With no `ruleRefs`, the adapter cannot produce a session rule without inventing one, which D4 expressly forbids.

Codex `acceptForSession` genuinely requires no proposal, so these semantics should be separated:

- A proposal-free `allowSession` for native session caches such as Codex `acceptForSession`.
- `allowWithRules` requiring one or more compatible proposal references.
- Each proposal should carry its native kind and permitted storage scope. Claude `destination: "session"` is ephemeral; settings destinations are durable and must be rejected while D13’s feature flag is off.
- Validation must check kind, proposal compatibility, scope, and feature authorization—not merely that the proposal ID exists.

## NOTES

- Repository inventory was re-verified. The current bus skips audit on block at [agent-event-bus.ts:61](/Users/dug/Projects/sandbox/agentic-patterns-ts/packages/agent-runtime/src/events/agent-event-bus.ts:61); the input registry remains boolean/string and globally keyed; the conversation route confirms `:id` is currently addressing sugar at [conversations.ts:447](/Users/dug/Projects/sandbox/agentic-patterns-ts/packages/agent-server/src/routes/conversations.ts:447).
- The remaining §5.4 mappings are correct: allow/accept, deny/decline, cancel/interrupt, hook-only input rewrite, proposal-backed Claude permission updates, Codex exec/network amendments, and granted permission subsets.
- §5.5 is broadly accurate. Current App Server is bidirectional JSON-RPC over JSONL; permissions require a granted subset; `PreToolUse` rewrites supported local calls but excludes hosted tools. See the [App Server documentation](https://developers.openai.com/codex/app-server), [current upstream protocol README](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md), and [hooks coverage](https://developers.openai.com/codex/hooks).
- The public App Server page currently omits `applyNetworkPolicyAmendment` from one summary, while current upstream protocol documentation and the installed Codex 0.144.6 binary include it. This reinforces the decision to pin R-1 to a validated CLI/schema rather than ambient documentation.
- `CODEX_HOME`/`AGENTS.md` claims are correct: global instructions load first, followed root-to-CWD with closer files winning. See the [official AGENTS.md discovery rules](https://developers.openai.com/codex/guides/agents-md).
- The Anthropic subscription-policy statement is current and accurate: the June change was paused and SDK usage still draws from subscription limits. See the [Anthropic support article](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan).
- Consider adding a sandbox/network requirement to `GateRequirements`, or state explicitly that network-policy compatibility is exclusively a run configuration concern. Presently only intercept classes and rewriting participate in gate compatibility.
- `parentId` is underspecified for Codex’s cross-thread/subagent relationships. A discriminated parent reference would avoid ambiguity between thread, item, request, and Claude tool-use IDs.

## NITS

- The comment saying `scope` is “carried on the request” is attached to a field carried on the decision.
- `cliVersion` and `protocolRevision` should probably be optional when probing fails before either can be discovered.
- “SDK 0.3.0 breaking changes” would be clearer as “changes since installed 0.2.141 across the 0.3.x line”; several cited changes landed well after 0.3.0.
- R-1 should explicitly determine whether each Codex amendment is session-only or persisted and where mutation occurs; proposal scope validation depends on that result.

No files were modified.
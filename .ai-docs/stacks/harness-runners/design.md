# Harness Runners — design & delivery plan (v4)

**Status:** DRAFT v4 — revised per Codex review round 3 (`review-codex-sol-round3.md`, verdict REVISE w/ 2 blockers, both accepted); **awaiting final human read (Gate 0)**
**Date:** 2026-07-19
**Author:** Fable (session w/ Doug)
**Scope:** two product intents, one shared foundation
**Context:** builds on `docs/runners.md` (runner/provider ADR), ADR-0005 (SessionScope), #308 D13 deferral
**Review history:** round 1 (17 findings) → v2 → round 2 (6 blockers) → v3 → round 3 (2 blockers) → v4. All reviews in this directory.

**v4 changes:** `AskContext` defined and threaded through evaluation, the approval callback, the transport, and an explicit audit interface (round-3 blocker 1); `requestId` mandatory on ask events; discriminated `parent` reference; `allowSession` (proposal-free, Codex-native) split from `allowWithRules` (requires proposal refs) fixing the unimplementable CC session mapping (round-3 blocker 2); `NativeProposal`/`ProposalRef`/`PermissionSet` defined with per-proposal `allowedScopes` and kind/scope/authorization validation; network-policy compatibility declared a run-configuration concern (not gate compatibility); `GateEvaluation.settledBy` distinguishes human/gate/timeout for audit; probe fields optional on early failure; R-1 determines Codex amendment persistence; 0.3.x wording nit.

---

## 1. Product intents

**Intent A — subscription-powered standard agents.** Users build normal framework
agents (Role × Capabilities × framework tools) and power them with their Claude
Max/Pro subscription *as if it were an API key*. The framework's `AgentRunner`
owns the loop; Claude Code is reduced to a model endpoint. Full canonical event
telemetry.

**Intent B — interchangeable coding-agent harnesses.** Users assemble
CodingAgents for SDLC phases (the `/sdlc` agent structure) where the harness —
Claude Code first, Codex next — owns the tool loop with its native tools,
skills, and nested subagents intact. Harnesses are interchangeable per node/phase,
controlled from one place. Both fresh sessions and user-installed configs
(skills, subagents, settings) must work.

**Cross-cutting requirement — interactive permission intercept.** On every
harness, when policy says "ask the human," the run must suspend, surface the
request through the AP gate chain to the existing dashboard approval components,
and resume (or deny) on the human's decision.

### Policy context (why invest in subscription auth now)

Anthropic's June 15 2026 move of Agent SDK / `claude -p` usage to a separate
credit pool was **paused on its effective date**; the official position
([support article 15036540](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan))
is that SDK usage draws from normal plan limits, with advance notice promised
before any future change. On the Codex side, App Server exposes managed ChatGPT
browser/device login via account RPCs, but there is **no documented
OAuth-env-injection seam** (see §5.5) — API-key login is OpenAI's documented
automation recommendation. **Hedge:** every design below keeps an explicit-token
/ API-key swap seam so a policy reversal on either side is a config change, not
a rearchitecture.

---

## 2. Architecture doctrine — the two seams

This is the load-bearing decision; everything else follows from it.

| Who owns the tool loop? | Seam | Events are… | Used by |
|---|---|---|---|
| The framework (`AgentRunner`) | `LanguageModelV2` | **causal** — the runner decides each step | Intent A |
| The harness (CC, Codex) | `RunnerProtocol` | **testimony** — translated from the harness's native stream | Intent B |

**D1. No `LanguageModelV2` path for coding agents.** LMv2 is a pure
request→response contract where tool calls are *data for the caller to execute*.
A coding harness executes tools itself. The two forced embeddings both fail:
stripping native execution amputates the coding agent (that's Intent A's design,
not a bug); letting CC run a whole session inside one `doGenerate` makes the
"model" side-effecting — retries re-run file edits and the emitted event stream
describes a loop that never happened. False events are worse than sparse events.

**D2. The event gap on the harness side is a translator gap, not a wall.**
Verified against the installed SDK (0.2.141 `sdk.d.ts`): every
`SDKAssistantMessage.message` is a full API `BetaMessage` carrying per-call
`usage`, `model`, `stop_reason`; `SDKResultMessage` carries `num_turns`,
`duration_ms`, `duration_api_ms`, `total_cost_usd`, per-model `modelUsage`,
`permission_denials`, and typed error subtypes. Today's `ClaudeCodeRunner`
ignores all of it (hardcodes `iterations: 1`, `finishReason: "stop"`,
`durationMs: 0`).

Recoverable by translation: per-LLM-call tokens/model/stop_reason,
iteration boundaries, tool durations, true finish reason, run cost,
compaction/subagent/rate-limit visibility. **Not recoverable:** causal
mid-loop control (pause between iterations, mutate context, re-plan) — that
requires owning the loop — and true `llm.start` timing/input-size for
synthesized boundaries. Synthesized events carry `meta.synthetic: true`
(D12); `BaseEvent` currently has **no metadata field**
(`events/types.ts:30`) — F-2 adds an optional `meta` record to `BaseEvent`
as a non-breaking schema extension, and B-1 populates it.

---

## 3. Current state inventory (verified file:line)

| Piece | Where | State |
|---|---|---|
| `ClaudeCodeRunner` | `agent-runtime/src/runner/claude-code-runner.ts:157` | SDK `query()` subprocess; gates via PreToolUse deny hooks; `permissionMode: "bypassPermissions"`; capabilities → in-process MCP (`sdk-bridge.ts`) |
| `ClaudeCodeAPIRunner` | `runner/claude-code-api-runner.ts:42` | preset: isolated + no native tools; the keyless `createRunner()` fallback (`create-runner.ts:297`) |
| Config/auth seams | `runner/cc-config.ts` | free functions: `CCConfigSource` (host/isolated+profile), `NativeToolsSetting`, `resolveOAuthToken` (explicit → env → macOS Keychain), `applyIsolatedEnv` |
| **Isolated-mode fail-open bug** | `claude-code-runner.ts:556` | when no OAuth token resolves, `CLAUDE_CONFIG_DIR` is **not applied at all** — "isolated" silently inherits host config. Must fail closed (D11) |
| **Correlation env race** | `claude-code-runner.ts:86` (`setCorrelationEnv`) | temporarily mutates global `process.env`; parallel runs can restore each other's values. Fix: correlation id goes in each subprocess's `options.env` |
| **SDK executable model (corrected v3)** | installed SDK `package.json` (`claudeCodeVersion: 2.1.141`), `sdk.d.ts:1487`, `bun.lock:178` | The SDK ships **platform-specific executable packages** (`@anthropic-ai/claude-agent-sdk-darwin-arm64@0.2.141` etc., optionalDependencies, present in the lockfile) and "uses the built-in executable if `pathToClaudeCodeExecutable` is not specified." The SDK↔CC pair is therefore **lockfile-pinned** (SDK 0.2.141 ↔ CC 2.1.141). The host PATH `claude` (2.1.215) matters only to the hooks telemetry bridge and to `createRunner`'s `hasClaudeCli()` probe — which can **false-negative a perfectly runnable bundled SDK** (`create-runner.ts:296`) |
| `claudeCode()` provider | `providers/claude-code.ts:352` | LMv2 wrapper; single-turn query per `doGenerate`; history flattened to text (`renderConversation` :144); `canUseTool` deny+`interrupt:true` extracts tool calls; **not in `PROVIDERS` registry**; **no isolation/OAuth seams**; untouched since #75 + AI SDK v5 bump |
| Gate chain | `gates/base.ts:14` | category order **SAFETY → RATE_LIMIT → APPROVAL → AUDIT**; `GateResult` supports allow / block / modified-event only (`base.ts:34`); `Gate` interface declares **no requirements** (`base.ts:53`) |
| Approval gate | `gates/approval.ts:47` | `check()` awaits an arbitrary async `approvalFn` — but the callback is **boolean** (`approval.ts:10`) |
| Audit gate | `gates/audit.ts:28` | records the **intent** only — not decision kind, actor, native request id, scope, or resulting policy |
| **Bus early-return** | `events/agent-event-bus.ts:61` | `publish()` returns immediately when a gate blocks — **the audit gate is skipped on blocks** |
| **Existing human-input loop** | `interaction/approval-gate.ts`, `interaction/pending-input-registry.ts`, `agent-server/src/routes/conversations.ts:447` | `agent.input.request` → `PendingInputRegistry` → SSE → **`POST /conversations/:id/input`** return leg. Transport carries only approve/deny + a string; the route resolves a **globally keyed** correlation id and does not bind it to the conversation |
| Intent emission | `claude-code-runner.ts:209` (`emitIntent`) | boolean; infers "blocked" from bus-wide `agent.tool.rejected` — **#288** |
| Provider registry | `providers/types.ts:17`, `providers/model-resolver.ts:205` | `ProviderProtocol` detects availability via env vars; `SupportedProvider` closed union; `createRunner` **throws on `claude-*` ids with no `ANTHROPIC_API_KEY` before the CLI fallback** (`create-runner.ts:263`) |
| Hooks telemetry bridge | `hooks/emit.mjs` → `agent-server/src/routes/hooks.ts:27` | CLI-native, SDK-free; correlation-id suppression of double counting |
| SDK dependency | `agent-runtime/package.json:64` | `^0.2.0` hard dep (docs/runners.md §3.2 says optional peer — doc fix in F-1); installed 0.2.141; latest 0.3.215 |
| Scope asymmetry | `claude-code-runner.ts:226` (TODO #308/D13-scope) | prompt rendering IS scope-aware; tool execution on the CC loop is not |

SDK changes since installed 0.2.141 across the 0.3.x line
([changelog](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md)),
impact-assessed: TodoWrite→Task tools (not consumed), v2 session API removed
(not used — we use `query()`), MCP servers connect in background (mild timing
consideration for sdk-bridge servers), `@anthropic-ai/sdk` +
`@modelcontextprotocol/sdk` become **peerDependencies** (packaging change we
must absorb). The untyped `tools` option workaround (`cc-config.ts:55`) must be
re-checked against 0.3 typings. **F-1 additionally re-establishes the 0.3.x
executable contract** (does 0.3 still bundle platform executables? what
`claudeCodeVersion` does it pin?).

**Reproducibility (v3, corrected):** the actual pinning mechanism is the
**lockfile** (it pins the SDK version, whose platform packages pin the CC
executable) plus **schema fixtures** committed in-repo (SDK message types;
Codex App Server generated schema, **stable channel only**). CI asserts against
the fixtures so upstream drift surfaces as a failing test. The manifest range
(`^0.3.x`) is intake policy, not the pin — the doc no longer calls it one.

---

## 4. Track A — promote `claudeCode()` to the first-class subscription path

Target: `createRunner()` selects it when a subscription is present and no API
key is; users get standard agents + full causal telemetry on their Max plan.

**A-1. Port the cc-config seams into the provider.** `ClaudeCodeProviderOptions`
grows `config: CCConfigSource`, `oauthToken: OAuthTokenSource` — reusing the
existing free functions verbatim via SDK `options.env`. Isolated mode becomes
the default for the provider. **Fail closed (D11):** isolated mode with no
resolvable token is a construction-time error, not a silent fall-through to
host config — this also fixes the same fail-open in `ClaudeCodeRunner`.

**A-2. Session economics.** Today each tool-loop iteration = full history
re-flattened + fresh subprocess. The obvious fix (SDK `options.resume`) has a
real conflict with the `canUseTool` deny+`interrupt` trick: CC's session history
records a *denial*, not an executed tool call, so naive resume desynchronizes
histories. Options, in preference order:

  1. **`deferred_tool_use`** — `SDKResultSuccess` carries
     `deferred_tool_use?: SDKDeferredToolUse`. The installed type proves only
     that `{id, name, input}` exists — it does **not** prove host-execution or
     resume semantics. **F-3 spike required — do not design past it.**
  2. Resume + result-injection: keep deny, then resume the session with tool
     results delivered as a user message. Append-only history →
     prompt-cache friendly; semantics slightly odd.
  3. Status quo stateless flatten (v1 fallback; correct but expensive).

**A-3. Subscription rung + auth probe (M).** Verified obstacles shape this:

  - `ProviderProtocol` assumes env-var availability detection and a closed
    `SupportedProvider` union (`providers/types.ts:17`). The subscription path
    becomes a **`createRunner()` rung with its own availability probe**, not a
    forced `PROVIDERS` entry.
  - **The probe tests actual SDK launch/auth readiness, not PATH presence**
    (v3, per the corrected executable model): spawn a minimal SDK query (or the
    SDK's auth-status surface) against the bundled executable and classify the
    result (ready / auth-missing / launch-failed). `hasClaudeCli()`'s
    PATH-probe false-negative is retired for this rung; the PATH probe remains
    meaningful only for the hooks bridge and the legacy fallback rung.
  - `createRunner()` currently classifies `claude-*` ids as anthropic and
    **throws when `ANTHROPIC_API_KEY` is absent, before the CLI fallback**
    (`create-runner.ts:263`). Revised: a classified `claude-*` id with no API
    key but a probe-verified subscription resolves to the subscription rung;
    the fail-loud error remains for the no-key, no-subscription case.

  Ladder position: above `ClaudeCodeAPIRunner` (which demotes to last-resort
  zero-config), below API-key providers. Update `docs/runners.md` choice matrix
  + `ExecutionService` preflight messaging. Depends on A-1 and the accepted
  A-2 strategy.

---

## 5. Track B — `CodingAgentRunner` base + per-harness adapters

### 5.1 Split of responsibilities

**Base class `CodingAgentRunner` (implements `RunnerProtocol`)** — the
harness-agnostic AP half:
- run/stream lifecycle: `message.start/complete`, `agent.error`, run accounting
  (tokens, iterations, cost from the adapter's terminal summary)
- gate-chain intent evaluation via `evaluateIntent` (§5.4), span correlation,
  event-bus plumbing, per-subprocess correlation-id injection (via the
  session's env — never `process.env` mutation)
- the **permission bridge** orchestration (§5.4)
- translation of the normalized adapter stream → AP events (one place
  constructs AP events; adapters never touch the bus)

**`HarnessAdapter` / `HarnessSession`** — the per-CLI native half. Both real
permission bridges are **bidirectional**, so the session is not a bare stream:

```ts
interface HarnessAdapter {
  readonly name: string;                          // "claude-code" | "codex" | …
  probe(ctx: ProbeContext): Promise<HarnessProbeResult>;   // §5.2
  start(req: HarnessRunRequest): Promise<HarnessSession>;  // async — handshake/startup
                                                  // failures throw HarnessStartError
                                                  // (structured: binary-missing |
                                                  // auth-missing | schema-incompatible |
                                                  // launch-failed)
}

interface HarnessSession extends AsyncIterable<HarnessEvent> {
  respond(requestId: string, decision: HarnessDecision): Promise<void>;
  interrupt(reason?: string): Promise<void>;
  close(): Promise<void>;
  // close() is idempotent and legal at any time: before terminal it interrupts,
  // settles every pending ask fail-closed (native decline/cancel where the
  // protocol allows), and drains; after terminal delivery it is a no-op.
}
```

**Reply semantics (v3, honest):** the session guarantees **exactly-once local
settlement** of every ask (decision, timeout, interrupt, or close — whichever
comes first) and **at-most-once wire response while connected**. On transport
disconnect no wire guarantee is possible; the contract is fail-closed cleanup
(pending asks settle as denied/cancelled locally, the run errors). R-1 tests
these as separate properties.

**Event envelope (v3):** native ids and hierarchy are carried by *every* event,
not just approvals:

```ts
interface NativeIds { threadId?: string; turnId?: string; itemId?: string }

type ParentRef = { kind: "thread" | "turn" | "item" | "tool-use"; id: string };
// discriminated — a Codex item parent and a CC parent_tool_use_id are not the
// same namespace; consumers must not guess

type HarnessEvent = { ids: NativeIds; parent?: ParentRef } & (
  | { kind: "approval-request"; requestId: string;   // MANDATORY — respond() keys on it
      operation: OperationClass;
      payload: NormalizedAskPayload;
      proposals: NativeProposal[];                 // native rule/amendment suggestions (§5.4)
      availableDecisions: DecisionKind[] }
  | { kind: "permission-request"; requestId: string; // MANDATORY
      operation: OperationClass;
      payload: NormalizedAskPayload;               // normalized native payload
      requested: PermissionSet;
      availableDecisions: DecisionKind[] }
  | { kind: "llm-response"; usage: TokenUsage; model: string; stopReason: string }
  | { kind: "text-delta"; text: string }
  | { kind: "reasoning"; text: string }
  | { kind: "turn-start" } | { kind: "turn-end" }
  | { kind: "tool-start"; name: string; operation: OperationClass; args: unknown }
  | { kind: "tool-end"; result: unknown; durationMs: number;
      status: "ok" | "error" | "declined" | "cancelled" }
  | { kind: "file-change"; diff: NormalizedDiff }
  | { kind: "harness-native"; name: string; payload: unknown }
  | { kind: "terminal"; numTurns: number; usage: TokenUsage; costUsd?: number;
      finishReason: FinishReason }
);
```

Subagent nesting renders from `parent` chains (Codex: item hierarchy; CC:
`parent_tool_use_id` → `{ kind: "tool-use" }`). `costUsd` lands as an optional
field on `RunResult` and `agent.message.complete` (B-1).

### 5.2 Capability declaration — per operation class, plus sandbox policy

```ts
type OperationClass = "shell" | "file-change" | "mcp-tool" | "local-tool"
                    | "hosted-tool" | "subagent";

type Enforcement = "enforcing" | "advisory" | "unsupported";
// enforcing   — adapter can synchronously block/ask BEFORE execution
// advisory    — adapter observes (telemetry) but cannot block
// unsupported — operation class cannot occur on this harness

interface HarnessProbeResult {
  ok: boolean;
  issues: ProbeIssue[];       // structured: { code: "binary-missing" | "auth-missing"
                              //   | "schema-incompatible" | "policy-disabled"
                              //   | "launch-failed"; detail: string }
  cliVersion?: string;        // optional — a probe can fail before discovering either
  authMode: "subscription" | "api-key" | "enterprise-token" | "none";
  protocolRevision?: string;
  enforcement: Record<OperationClass, Enforcement>;   // exactly one value per class
  sandbox: { networkPolicy: "configurable" | "fixed" | "none" };
  features: { interactiveAsk: boolean; resume: boolean; partialStreaming: boolean;
              inputRewrite: boolean; durableRules: boolean };
}
```

**Network is not an operation class** (v3): network egress is an *effect* that
can occur inside shell, MCP, local tools, or subagents. It is governed by each
harness's sandbox/network policy (configured at session start, surfaced via
`sandbox`), and durable network-policy amendments are a decision kind (§5.4) —
it does not appear in the intercept matrix.

**Gate requirements make the run-start check implementable** (v3): the `Gate`
interface gains an optional declaration —

```ts
interface GateRequirements { interceptClasses?: OperationClass[]; rewrite?: boolean }
// absent → the gate imposes no adapter requirements (all existing gates)
```

At run start the base collects requirements from the configured chain and
compares them to the probe's enforcement matrix + `features.inputRewrite`;
any gap fails loud before the session starts. Existing gates are untouched
(no declaration = no requirements). **Network policy is explicitly a
run-configuration concern, not a gate-compatibility one:** the desired network
posture is set at session start against the probe's `sandbox` record, and a
harness whose sandbox can't express it fails there — gates neither declare nor
check network requirements.

Expected reality, **pinned by contract tests, not asserted**: CC contract tests
(B-2 acceptance) establish per-class enforcement for CC (`canUseTool`/hooks
expected to cover all classes); R-1 establishes Codex's (App Server approvals +
`PreToolUse` + exec-policy rules + sandbox → enforcing for shell /
`apply_patch` / MCP / most local tools; hosted tools not hook-covered).

### 5.3 Event translation parity (CC adapter)

Per §2/D2, upgrade the SDK-message translator:
- `llm.end` per `SDKAssistantMessage`; `llm.start` from stream `message_start`
  when streaming, else synthesized at the prior boundary with
  `meta.synthetic: true`
- `iteration.*` synthesized at turn boundaries (provenance-marked); reconciled
  against the result's `num_turns`
- tool `durationMs` via timestamping at tool-start
- `finishReason` mapped from result subtypes; cost on the terminal summary
- CC-specific richness (compaction, subagent/task progress, rate-limit events)
  rides `harness-native` → namespaced envelope event (precedent:
  `claude_code.hook`); canonical promotion only when a second harness emits the
  same concept

### 5.4 The permission bridge

**Substrate (D10): the existing `interaction/` layer, widened.**
`interaction/approval-gate.ts` + `PendingInputRegistry` + SSE +
`POST /conversations/:id/input` already round-trip human input; the transport
carries only approve/deny + a string. B-3 widens the payload to the decision
contract below, and **fixes the route to bind the correlation id to the
conversation id** (today `:id` is addressing sugar over a global registry —
`conversations.ts:447`).

**Flow:** adapter emits `approval-request`/`permission-request` → base
normalizes → `evaluateIntent` (safety → rate-limit → approval; audit phase
guaranteed after — below) → decision → `session.respond(requestId, decision)`
translated to the native reply.

**D4 (v4). The decision contract.** Decisions reference native proposals
rather than inventing free-form policy. Session acceptance and rule
installation are **separate kinds** — Codex has a proposal-free native session
cache (`acceptForSession`); Claude Code does not (its session rules must echo
the request's own `updatedPermissions` suggestions), and conflating them made
the CC mapping unimplementable:

```ts
type DecisionKind = HarnessDecision["kind"];

interface NativeProposal {
  id: string;                            // referenced by ProposalRef
  nativeKind: "cc-permission-update" | "codex-execpolicy-amendment"
            | "codex-networkpolicy-amendment";
  allowedScopes: ("session" | "durable")[];   // CC destination:"session" → ["session"];
                                              // CC settings destinations → ["durable"];
                                              // Codex amendments → per R-1's persistence findings
  payload: unknown;                      // the native suggestion, passed through opaquely
}
type ProposalRef = { proposalId: string };
type PermissionSet = ReadonlyArray<{ permission: string; detail?: unknown }>;
                                         // normalized; subset checks compare by permission id

type HarnessDecision =
  | { kind: "allowOnce" }
  | { kind: "allowSession" }                             // proposal-free NATIVE session cache —
                                                         // offered only where the harness has one
                                                         // (Codex); never in CC's availableDecisions
  | { kind: "allowWithRules"; ruleRefs: [ProposalRef, ...ProposalRef[]];  // ≥1, must reference
      scope: "session" | "durable" }                     //   the request's proposals
  | { kind: "deny"; reason?: string }    // reason surfaces in AP events; adapters
                                         // drop it where the native protocol can't carry it
  | { kind: "cancel" }                   // distinct from deny
  | { kind: "rewriteInput"; updatedInput: unknown }      // CC canUseTool / Codex PreToolUse
                                                         // only — never App Server replies
  | { kind: "grantPermissions"; granted: PermissionSet;  // validated ⊆ request.requested
      scope: "turn" | "session" };
```

Validation, enforced by the base before `respond()` — four checks, not one:
1. **kind** ∈ the request's `availableDecisions`;
2. **compatibility** — every `ruleRef` resolves to a proposal on *this* request
   whose `nativeKind` is applicable to the operation;
3. **scope** — the decision's scope ∈ each referenced proposal's
   `allowedScopes`;
4. **authorization** — `scope: "durable"` additionally requires the D13
   feature flag (and, once #307 lands, an authenticated actor).

Native mappings:

| Decision | Claude Code (`canUseTool` result) | Codex (App Server reply) |
|---|---|---|
| `allowOnce` | allow | `accept` |
| `allowSession` | **not offered** (absent from CC `availableDecisions` — CC has no rule-free session cache) | `acceptForSession` |
| `allowWithRules` scope=session | allow + `updatedPermissions` echoing the referenced `destination:"session"` suggestions (`sdk.d.ts:1858`) | amendment reply *iff* R-1 shows session-scoped amendments exist |
| `allowWithRules` scope=durable (flag-gated) | allow + `updatedPermissions` w/ settings destinations | `acceptWithExecpolicyAmendment` / `applyNetworkPolicyAmendment` |
| `deny` | deny (+ reason) | `decline` (reason dropped — not carried by the protocol) |
| `cancel` | deny + `interrupt` | `cancel` |
| `rewriteInput` | allow + `updatedInput` | `PreToolUse` hook path only |
| `grantPermissions` | n/a (CC has no separate permission-request) | permission-request reply (granted subset, turn/session scope) |

CC's `decisionClassification` (`user_temporary`/`user_permanent`/`user_reject`)
is **telemetry**, set truthfully from the decision taken — never policy state.

**D13 (v3). Durability split — resolves the v2 D13/OQ-7 contradiction.**
`scope: "durable"` rules and persisted policy amendments are real decision
kinds in the contract, but they are **feature-flagged off until #307 (server
auth seam) lands**: the unauthenticated `POST /input` transport may only carry
ephemeral decisions (`allowOnce`, `deny`, `cancel`, `rewriteInput`,
session/turn-scoped rules and grants — state that dies with the session).
Enabling durable kinds requires an authenticated actor identity from #307,
which becomes a **declared prerequisite of that feature flag**, not of the
bridge. Every decision — including blocks and timeouts — is audited (below)
with decision kind, actor (when available), native request id, scope, and
resulting policy.

**F-2 (v4). `evaluateIntent` — the defined contract, with the ask context
threaded through.** A `ToolCallIntent` alone (tool id/name/args,
`events/types.ts:81`) cannot carry proposals or available decisions — so the
native ask context is a first-class input that travels the whole path:
adapter → evaluation → approval callback → transport → audit.

```ts
interface AskContext {
  requestId: string;                     // mandatory local settlement key (respond())
  operation: OperationClass;
  payload: NormalizedAskPayload;         // what the frontend renders
  proposals: NativeProposal[];
  availableDecisions: DecisionKind[];
  requested?: PermissionSet;             // permission-requests only
  nativeIds: NativeIds;
  durableEnabled: boolean;               // D13 flag state — UI greys durable options
  actor?: ActorRef;                      // present once #307 authenticates the transport
}

interface GateEvaluation {
  outcome: "allow" | "block";
  intent: ToolCallIntent;                // post-modification intent — what executes
  decision?: HarnessDecision;            // present when an approval gate decided
  settledBy: "gate" | "human" | "timeout";   // audit + UI distinguish declined vs expired
  blockedBy?: string; reason?: string;
  trail: { gate: string; result: "allow" | "block" | "modified" }[];
}
```

- `AgentEventBus.evaluateIntent(intent, ctx?: AskContext): Promise<GateEvaluation>`
  runs safety → rate-limit → approval and **always runs the audit phase
  afterward** (fixing today's early return on block, `agent-event-bus.ts:61`,
  which skips audit exactly when it matters). `publish()` delegates to it.
  `ctx` is optional because `AgentRunner`'s own loop evaluates plain intents
  with no native ask.
- Migration: `GateResult` gains an optional `decision` payload;
  `HumanApprovalGate`'s callback widens from `(intent) => boolean` to
  `(intent, ctx?) => boolean | HarnessDecision` (booleans coerced to
  `allowOnce`/`deny` — all existing gates and callbacks work unchanged). The
  pending-input transport (D10) carries `AskContext` to the frontend, which is
  how proposals and `availableDecisions` reach the approval components.
- **The audit phase has its own interface** — `Gate.check(BaseEvent)` cannot
  consume a decision record (`base.ts:53`, `audit.ts:28`), so audit-category
  gates gain `recordDecision(evaluation: GateEvaluation, ctx?: AskContext)`,
  which the base invokes in the guaranteed phase. The record includes decision
  kind, actor, native request id, scope, resulting policy, and `settledBy`.
  A post-decision `agent.gate.decision` event is published for exporters.
- Modified intents affect execution: the bridge forwards
  `GateEvaluation.intent` to the adapter as `rewriteInput` where supported;
  a gate that declares `rewrite: true` against an adapter without
  `features.inputRewrite` fails at run start (§5.2). This replaces
  `emitIntent`'s rejection-subscription inference and fixes #288.

**Native asks alone don't implement AP policy.** App Server only requests
approval when *Codex's* policy requires it; CC's `canUseTool` only fires when
*CC's* permission system consults. If an AP gate requires inspection of an
operation class, the adapter wires the harness's `PreToolUse` mechanism as the
inspection seam, with native approval requests layered on top. The enforcement
matrix (§5.2) is derived from which seams are active.

**Timeout policy:** base-level `askTimeout`, **default 300s**, per-run
configurable → native decline (`deny` or `cancel` per protocol) plus
`agent.tool.rejected` with a distinct `timeout` reason, preserved end-to-end
(transport, audit record, UI).

**Ask payload for the frontend:** adapters normalize per-operation shapes
(shell → command string; file-change → `NormalizedDiff`; MCP tool → schema'd
args; permission request → requested set) so the dashboard renders N harnesses
with one component set.

### 5.5 Codex adapter reality

- **Integration surface: App Server** (bidirectional JSON-RPC over stdio
  JSONL, server-initiated approval requests). The `proto` command no longer
  exists. `codex exec --json` is output-only telemetry (JSONL: `thread.started`,
  `turn.*`, `item.*`, `error`) — a *different* schema, unusable for approval
  round-trips.
- **Decision vocabularies differ per request type:** command approvals support
  `accept` / `acceptForSession` / `decline` / `cancel` /
  `acceptWithExecpolicyAmendment` / **`applyNetworkPolicyAmendment`** (with
  proposed amendments and `availableDecisions` carried on the request);
  file-change approvals are a smaller set; permission requests return a granted
  subset with turn/session scope. App Server replies carry **no** arbitrary
  denial reasons and **no** updated input; `updatedInput` exists only on Codex
  `PreToolUse`.
- **`CODEX_HOME` is not a complete isolation boundary.** It relocates user
  config/state/file-credentials/history/skills, but Codex still discovers
  repository `AGENTS.md` and trusted project `.codex` config below the working
  tree. Fresh-session semantics require workspace control too (clean worktree,
  or explicitly accept+document repo-level config as part of the "session").
- **Auth:** file credentials at `CODEX_HOME/auth.json`; keyring credentials
  live *outside* `CODEX_HOME`; ChatGPT login is cached browser/device auth
  (App Server can initiate managed login via account RPCs) with no documented
  OAuth-env-injection seam; documented automation paths are API-key login and
  enterprise `CODEX_ACCESS_TOKEN`. Credentials are handled separately from
  profile contents — a profile directory never contains them.
- **`AGENTS.md` composition:** global `CODEX_HOME/AGENTS.md` loads first;
  project-root-to-cwd files load after, closer files winning. The rendered role
  prompt mounts as the global file and must **compose with, never overwrite**,
  a profile's existing `AGENTS.md`.
- **Request/response correlation** is by request id with exactly-once *local
  settlement* (reply semantics per §5.1).

### 5.6 Profiles

A **profile** is a directory in the harness's own config shape
(`.claude/`-shaped for CC; `CODEX_HOME`-shaped for Codex, credentials excluded)
— this is how "install your own skills/subagents" works. Fresh session = empty
isolated config **plus** the workspace caveat in §5.5 for Codex. The CC cells
exist today (`cc-config.ts`); the Codex cells are defined by R-1's contract
tests, not assumed. Profile authoring UX is deferred (B-5).

---

## 6. Decisions (v3)

- **D1** Two seams: LMv2 ⟷ framework-owned loop; RunnerProtocol ⟷ harness-owned loop. No LMv2 coding agents.
- **D2** Harness event parity via translation; enumerated recoverable/irrecoverable fields (§2); residual gap (mid-loop control) accepted.
- **D3** Adapter contract validated before base extraction: R-1 precedes B-2; base provisional until B-4 lands.
- **D4 (v4)** Proposal-referencing decision contract (§5.4): `allowSession` (native session cache) split from `allowWithRules` (≥1 proposal refs); four-step validation (kind / compatibility / scope / authorization); grants validated as subsets.
- **D5 (v4)** #288 + `evaluateIntent`/`GateEvaluation` with `AskContext` threaded adapter→gates→transport→audit, guaranteed audit phase via `recordDecision(evaluation, ctx)`, and modified-intent passthrough — prerequisite (F-2).
- **D6** Profiles = harness-native config directories, credentials excluded; fresh session = empty isolated config + workspace control where the harness reads repo config.
- **D7 (v3)** SDK bump to `^0.3.x`; absorb new peerDependencies; re-check `tools` typing; **re-establish the 0.3.x executable contract**; keep hard dep, fix `docs/runners.md`. Reproducibility = lockfile + committed schema fixtures (stable channel), asserted in CI.
- **D8** `claudeCode()` provider is Intent A's vehicle via a probe-backed `createRunner()` rung (probe = SDK launch/auth readiness, not PATH); `ClaudeCodeAPIRunner` demotes to zero-config fallback only.
- **D9** Subscription-policy hedge: every auth path keeps an explicit token/API-key seam (both vendors).
- **D10** The permission bridge extends the existing `interaction/` layer — widen the transport (and bind `:id` to the conversation), don't rebuild it.
- **D11** Isolation fails closed: isolated mode with unresolvable auth is an error, never a silent fall-through to host config.
- **D12** Synthesized/translated events carry `meta.synthetic: true`; F-2 adds the optional `meta` record to `BaseEvent`.
- **D13 (v3)** Durability split: ephemeral decisions ship on the current transport; durable decisions (persistent rules, policy amendments) are feature-flagged off until #307 provides authenticated actor identity. All decisions audited via the guaranteed audit phase.

## 7. Open questions

- **OQ-1 (F-3 spike):** `deferred_tool_use` semantics — the installed type proves
  only `{id, name, input}`. Does the host execute and resume? Gates A-2.
- **OQ-4:** Scope-aware tool execution on harness runners (#308 deferral) —
  out of scope here; revisit with the consumer migrations.
- **OQ-5:** Naming: `CodingAgentRunner` vs `HarnessRunner` — user call at review.
- **OQ-6:** Profile authoring UX — deferred to B-5's own design pass.

*(v1 OQ-2 answered in §5.5; v2 OQ-3 resolved: envelope now, canonical on second
harness; v2 OQ-7 resolved by D13 v3's durability split.)*

## 8. Delivery plan (v3)

Every item lands via PR to protected `main`. Sizes: S < 200 LoC, M < 600, L =
needs its own mini-plan.

**Foundations (parallel-friendly)**
- **F-1 (S):** SDK `^0.3.x` bump + new peer deps + `tools` typing re-check +
  **0.3.x executable-contract verification** + runners.md dependency-note fix +
  schema fixtures committed. *No behavior change intended; full `bun run check`.*
- **F-2 (M):** `evaluateIntent`/`GateEvaluation`/`AskContext` per §5.4 —
  guaranteed audit phase via `recordDecision`, `GateResult.decision` payload,
  boolean-callback coercion, `BaseEvent.meta`, `agent.gate.decision` event;
  fixes #288.
- **F-3 (S, spike):** `deferred_tool_use` semantics → findings note. Gates A-2.
- **R-1 (M, spike):** Codex App Server **contract tests**, pinned to a
  validated CLI version + generated **stable-channel** schema fixture, with an
  explicit **minimum supported CLI-version floor**: command / file-change /
  permission approval round-trips incl. proposal payloads
  (exec-policy **and network-policy** amendments — determining **whether each
  amendment kind is session-only or persisted, and where the mutation lands**;
  proposal `allowedScopes` derive from this); decline vs cancel vs timeout
  vs disconnect (local-settlement vs wire-response properties separately);
  concurrent server requests; `PreToolUse` coverage + hosted-tool exclusions;
  empty/custom `CODEX_HOME` with file auth vs keyring; global + repo
  `AGENTS.md` composition; fresh / resume / **forked** / interrupted sessions;
  `exec --json` vs App Server schema differences.

**Track A** (F-1 → A-1 → A-2(after F-3) → A-3)
- **A-1 (M):** cc-config seams into `claudeCode()` (isolated default, OAuth
  injection, fail-closed incl. the runner-side fix).
- **A-2 (M/L):** session economics per F-3's outcome.
- **A-3 (M):** subscription rung with **SDK launch/auth-readiness probe** +
  `claude-*` mismatch-behavior revision + docs/preflight updates.

**Track B** (F-1 → B-1; F-2 + R-1 → B-2 → B-3 → B-4)
- **B-1 (M, after F-1):** CC event-translation parity (per-call `llm.end`,
  iteration synthesis w/ `meta.synthetic`, durations, finishReason, `costUsd`
  on `RunResult`/`message.complete`, `harness-native` envelope). *Standalone
  dashboard value. B-2 is a structural refactor over B-1's behavior.*
- **B-2 (L, after F-2 + R-1):** Extract `CodingAgentRunner` base +
  `HarnessAdapter`/`HarnessSession` (async `start`, reply-semantics contract,
  event envelope w/ native ids + `parentId`); refactor `ClaudeCodeRunner` onto
  it. Per-operation enforcement matrix + `GateRequirements` run-start check;
  structured `probe()`; correlation id via session env. **Acceptance includes
  CC contract tests** establishing the per-class enforcement claims.
- **B-3 (M, after B-2):** Permission bridge — `canUseTool` seam +
  permissionMode switch when interactive; widen the `interaction/` transport to
  carry `AskContext` + the §5.4 decision contract (timeout-vs-decline via
  `settledBy`); **conversation-binding fix on
  `POST /conversations/:id/input`**; `askTimeout` (300s default); dashboard
  components for rewrite / allow-with-rules / grant flows; durable kinds
  feature-flagged off (D13).
- **B-4 (L, after B-3):** `CodexRunner` adapter — App Server only, pinned
  schemas from R-1, request-id correlation with local-settlement semantics,
  explicit translation for command / file-change / MCP / permission / subagent
  / compaction / usage / cancellation / failure events, per-class enforcement
  declaration from contract tests, `AGENTS.md` composition rules, credentials
  separate from profiles.
- **B-5 (deferred):** Profile authoring UX.

**Review gates:** Gate 0 = this doc (round 3 in progress). F-3 and R-1 findings
each get a human look before dependents start. Per-issue strategies via
`/sdlc:design` after plan→issue sync.

## 9. Risks

| Risk | Mitigation |
|---|---|
| Subscription policy shifts (either vendor) | D9 seams; Track A degrades to API-key with zero code change |
| Upstream SDK/CLI drift | D7: lockfile + committed schema fixtures asserted in CI; bundled-executable pairing means runtime drift is an *upgrade-time* event, not ambient |
| `deferred_tool_use` isn't host-execution | A-2 falls back to resume+inject or flatten; F-3 is cheap |
| Codex hosted-tool class can't be enforced | per-class matrix + `GateRequirements` run-start fail-loud + dashboard badge |
| Approval click silently becomes durable policy | D4 proposal-referencing + D13 durability split + guaranteed audit phase |
| Durable decisions over unauthenticated transport | D13: feature-flagged off until #307; flag's prerequisite is declared |
| Base abstraction wrong on first extraction | D3: R-1's contract facts land before B-2; residual breaks in B-4 folded back deliberately |
| Long-held approval suspends subprocesses | `askTimeout` (300s) fail-closed with distinct timeout reason, preserved end-to-end |

## 10. Out of scope

- Scope-aware tool execution on harness runners (OQ-4 → consumer-migration arc)
- Profile authoring/marketplace UX (B-5 placeholder)
- Additional harnesses beyond CC + Codex (the adapter seam is the extension point)
- Server multi-tenancy/auth (#307's territory; D13's durable-decision flag is
  the only declared coupling)

# R-1: Codex App Server contract — pinned facts (#321)

**Spike date:** 2026-07-19 · **CLI:** `codex-cli 0.144.6` (macOS arm64, ChatGPT
subscription auth) · **Branch:** `hr/r1-codex-contract-tests`

Everything below is *evidence*, not assumption. Live experiments drove a real
`codex app-server` over stdio JSONL (isolated `CODEX_HOME` per scenario, host
auth copied — never mutated) plus `codex exec` batteries for hooks/AGENTS.md/
auth. Executable form: `packages/agent-runtime/contract-tests/codex/*.contract.test.ts`.

```bash
# NOT in default test/CI — needs codex binary + logged-in ~/.codex/auth.json
bun run --filter=@agentic-patterns/runtime test:contract:codex
```

## 1. Pinned version + floor

| | |
|---|---|
| Pinned CLI | `codex-cli 0.144.6` |
| Minimum floor | **0.144.6 — same as pin.** No older binary was validated; the v2 thread/turn API, `generate-json-schema` subcommand, and the granular-approval vocabulary are all moving surfaces (schema gen is itself flagged experimental). Raise the floor only by validating a specific older/newer version against the fixtures. |
| Schema fixtures | `contract-tests/codex/__fixtures__/schema-stable/` — root-level STABLE-channel bundle from `codex app-server generate-json-schema` (no `--experimental`); aggregate bundles + v1/v2 dirs pinned by sha256 in `__fixtures__/manifest.json` |
| Reproducibility | `pinned-schema.contract.test.ts` regenerates and diffs byte-for-byte. **Caveat (D7):** the aggregate `codex_app_server_protocol.v2.schemas.json` is NON-deterministic across generator runs (definition inclusion varies) — the per-type root files are deterministic and are the fixture of record; only the v1 aggregate is hash-pinned. |

Protocol shape: bidirectional JSON-RPC 2.0 over stdio JSONL. Handshake =
`initialize` (clientInfo required, optional `capabilities.experimentalApi`) +
`initialized` notification. Server-initiated requests (client must respond by
id): `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`,
`item/permissions/requestApproval`, `item/tool/requestUserInput`,
`item/tool/call`, `mcpServer/elicitation/request`,
`account/chatgptAuthTokens/refresh`, `attestation/generate`, plus legacy v1
`execCommandApproval` / `applyPatchApproval`.

## 2. Enforcement matrix (§5.2, filled from evidence)

| OperationClass | Enforcement | Evidence |
|---|---|---|
| `shell` | **enforcing** | Live: `approvalPolicy:"untrusted"` → `item/commandExecution/requestApproval` blocks pre-exec; accept ran the command, decline didn't (item status `declined`), cancel interrupted the turn. Independently: PreToolUse (`Bash`) deny blocked before execution; allow+`updatedInput` rewrote the command. |
| `file-change` | **enforcing** | Live: `sandbox:"read-only"` + apply_patch → `item/fileChange/requestApproval`; accept applied the patch. PreToolUse fires for `apply_patch` (deny verified on the same seam for Bash; docs state parity). |
| `mcp-tool` | **enforcing** *(docs+schema; live round-trip → R1b)* | Hook docs: MCP tools match `mcp__server__tool` in PreToolUse (deny/rewrite supported). Schema: `mcpServer/elicitation/request` + granular `approvalPolicy.granular.mcp_elicitations`. No MCP server was configured in the timebox. |
| `local-tool` | **enforcing** | Live: PreToolUse/PostToolUse fired for `update_plan` with JSON args. Deny path is the same verified seam. |
| `hosted-tool` | **advisory** *(version-fragile — see contradiction C3)* | Live: `web_search` item (hosted on the wire) fired PreToolUse/PostToolUse as local tool `webrun` in 0.144.6. Deny on `webrun` untested; official docs still say hosted tools bypass hooks. Treat as observe-only; do NOT promise blocking. |
| `subagent` | **enforcing** *(docs; live → R1b)* | Docs: `spawn_agent` matches `Agent` in PreToolUse (blockable); `SubagentStart` hook explicitly canNOT stop a subagent (`continue:false` ignored). Multi-agent not exercised in the timebox. |

Sandbox record (§5.2 `sandbox`): `networkPolicy: "configurable"` — modes
`read-only` / `workspace-write` / `danger-full-access`; workspace-write denies
egress by default (live: `curl` exit 6, DNS blocked by seatbelt) and a failed
egress does **not** auto-raise an approval; the managed-network prompt path
(`networkApprovalContext`, `proposedNetworkPolicyAmendments`) sits behind the
`network_proxy` feature, **experimental and default-off in 0.144.6**.

`features` for the probe result: `interactiveAsk: true`, `resume: true`
(thread/resume, thread/fork exist — untested, R1b), `partialStreaming: true`
(delta notifications), `inputRewrite: true` (**PreToolUse only** — never App
Server replies), `durableRules: true` (execpolicy amendments, see §3).

## 3. Amendment persistence → proposal `allowedScopes` (feeds D4)

| Native decision | Persistence | Where | `allowedScopes` |
|---|---|---|---|
| `accept` | this call only | — | n/a |
| `acceptForSession` | **per-thread** cache | in-memory (nothing home-written) | n/a (proposal-free `allowSession`) |
| `acceptWithExecpolicyAmendment` | **durable** — survives full process restart; new process + new thread ran the command with **zero** prompts | `CODEX_HOME/rules/default.rules`, e.g. `prefix_rule(pattern=["touch", "/tmp/..."], decision="allow")` | `["durable"]` **only** |
| `applyNetworkPolicyAmendment` | schema: "persistent network policy rule (allow/deny) for this host" — could not live-trigger (needs `network_proxy` feature) | expected durable | `["durable"]` (schema wording; verify when feature enables — R1b) |

Consequences for §5.4:
- **There are NO session-scoped amendments.** `allowWithRules scope:"session"`
  has no Codex mapping — the design's "amendment reply *iff* R-1 shows
  session-scoped amendments exist" resolves to **not offered**. Session-level
  allow is only the proposal-free `allowSession` → `acceptForSession`, and its
  scope is the **thread**, not the app-server connection.
- `allowWithRules scope:"durable"` → `acceptWithExecpolicyAmendment` /
  `applyNetworkPolicyAmendment`, D13 flag-gated as designed. The execpolicy
  amendment writes into the profile directory (`CODEX_HOME/rules/`) — profile
  authors get durable rules "for free", which is exactly why D13's gating
  matters.

## 4. Contradictions / corrections vs design §5.5 (READ THIS)

- **C1 — `availableDecisions` is NOT a stable-schema field and NOT an
  enforcement whitelist.** §5.5 says approvals arrive "with proposed amendments
  and `availableDecisions` carried on the request". Reality: the field exists
  only in the `--experimental` schema ("Ordered list of decisions the client
  may present for this prompt" — a UI ordering hint), though it IS emitted even
  without the `experimentalApi` capability. Live, a request offered
  `["accept", {acceptWithExecpolicyAmendment...}, "cancel"]` — no `decline`,
  no `acceptForSession` — yet the server honored **both** unlisted replies.
  ⇒ D4 validation step 1 ("kind ∈ availableDecisions") must validate against
  the per-request-type schema vocabulary, and treat the wire hint as
  presentation metadata only — otherwise the bridge would wrongly reject
  legitimate `deny`/`allowSession` decisions.
- **C2 — file-change approvals carry NO payload to render.** Params are only
  `{threadId, turnId, itemId, startedAtMs, reason, grantRoot}` — no diff, no
  availableDecisions. The §5.4 ask-payload (`NormalizedDiff`) must be built by
  correlating `itemId` against the `fileChange` item notifications
  (`item.changes[].{path, kind, diff}`). Same for command approvals if the
  item-level view is wanted (`commandActions` is best-effort parse only).
- **C3 — hosted-tool hook exclusion did not hold in 0.144.6.** Web search ran
  as a hosted-looking `web_search` item but was hook-covered via local tool
  `webrun`. §5.2's expectation "hosted tools not hook-covered" is too strong
  AND the docs are stale in the other direction — the safe adapter posture is
  hosted-tool = advisory, never enforcing.
- **C4 — "session" in `acceptForSession` = thread.** Two turns on the same
  thread: one prompt. New thread on the same connection: prompted again.
  `allowSession` semantics must be documented as per-thread.
- **C5 — new protocol facts** (absent from §5.5, useful for B-3):
  - `turn/interrupt` params are `{threadId, turnId}` — turnId required
    (-32600 without it).
  - Interrupt with a pending approval settles it **server-side**: the server
    emits `serverRequest/resolved {threadId, requestId}`, rejects the exec
    itself ("Rejected(\"rejected by user\")"), turn ends `interrupted`. The
    bridge must treat `serverRequest/resolved` as ask-withdrawal.
  - The wire does NOT enforce exactly-once settlement: duplicate replies and
    late replies (post-resolution) are silently ignored — no error, no crash.
    §5.1's exactly-once *local* settlement is necessary and client-owned.
  - Requests from server and client live in separate id namespaces (server
    ids restart at 0).
- **C6 — fresh `CODEX_HOME` is not a blank profile.** On first thread start,
  Codex auto-fetched curated remote plugins (openai-templates + notion, incl.
  an MCP server and skills) into `CODEX_HOME/plugins/cache/` and seeded
  state/goals/memories sqlites. "Fresh session" isolation needs the plugin
  fetch disabled (config knob hunt → R1b) or documented as present.

Confirmed as designed (no change): replies carry no denial reasons and no
updatedInput (rewrite is PreToolUse-only, verified live); decline continues
the turn while cancel interrupts it (distinct decisions, verified);
`PermissionsRequestApprovalResponse` returns a granted subset with
`scope: turn|session` (+`strictAutoReview`) per schema; `exec --json` is a
different, output-only schema (see §6); AGENTS.md composition and the
CODEX_HOME isolation caveat (see §5).

## 5. Behavioral facts

**Auth.** File credentials at `CODEX_HOME/auth.json`
(`{auth_mode, OPENAI_API_KEY, tokens, last_refresh}`). Empty CODEX_HOME →
hard 401 against `api.openai.com` after retries, exit ≠ 0: no keyring
fallback, no host-config fall-through (D11 fail-closed is implementable by
construction). Copying `auth.json` into an isolated home works for ChatGPT
subscription auth.

**AGENTS.md composition** (live, deterministic via the thread rollout file —
`thread.path` from `thread/start`, `world_state.payload.state.agents_md`):
global `CODEX_HOME/AGENTS.md` first, then `--- project-doc ---`, then
repo-root → cwd (closer = later). Repo AGENTS.md files are picked up even with
a fully isolated CODEX_HOME — workspace control is part of session isolation,
as §5.5 says.

**Hooks.** Config at `CODEX_HOME/hooks.json` (user layer) or inline
`[hooks]` in config.toml; project `.codex/hooks.json` requires project trust.
Events: `preToolUse, permissionRequest, postToolUse, preCompact, postCompact,
sessionStart, userPromptSubmit, subagentStart, subagentStop, stop`; only
`type:"command"` handlers run today. Non-managed hooks need interactive trust;
`codex exec --dangerously-bypass-hook-trust` is the automation seam — **the
app-server binary does not accept that flag**, so programmatic app-server hook
use needs pre-established trust (hash-keyed; mechanism hunt → R1b). Hooks are a
guardrail, not a boundary ("some specialized tool paths can opt out").

**`exec --json` vs App Server** (different schemas, as §5.5 says):

| | `codex exec --json` | App Server |
|---|---|---|
| framing | flat JSONL events, `type` field | JSON-RPC 2.0 (method/id/params) |
| event names | dotted snake: `thread.started`, `turn.completed`, `item.*`, `error` | slashed: `thread/started`, `turn/completed`, `item/*` + ~60 more |
| item types | snake_case: `command_execution`, `agent_message`, `file_change`, `todo_list`, `web_search` | camelCase: `commandExecution`, `agentMessage`, `fileChange`, ... |
| approvals | none (output-only) | server-initiated requests |

## 6. Harness layout

```
packages/agent-runtime/
  vitest.contract.codex.config.ts     # separate config; sequential; 300s timeouts
  package.json                        #   "test:contract:codex"
  vitest.config.ts                    # default run now EXCLUDES contract-tests/**
  contract-tests/codex/
    driver.ts                         # minimal JSON-RPC/JSONL stdio client (test infra, not shipped)
    helpers.ts                        # isolated CODEX_HOME/workspace factories
    __fixtures__/manifest.json            # pinned version + aggregate sha256
    __fixtures__/schema-stable/*.json     # committed stable schema bundle (35 files)
    __fixtures__/wire-samples.json        # curated live captures
    pinned-schema.contract.test.ts    # version pin + regen determinism + vocab
    command-approvals.contract.test.ts# accept/decline/cancel/session/execpolicy
    file-change-approvals.contract.test.ts
    settlement.contract.test.ts       # interrupt/duplicate/late-reply semantics
    hooks.contract.test.ts            # PreToolUse coverage/deny/rewrite (via exec)
    agents-md.contract.test.ts        # composition order via rollout world_state
    exec-json.contract.test.ts        # exec schema + empty-home 401
```

Costs: a full run drives ~12 short live turns (low reasoning effort via the
isolated homes' config.toml).

## 7. Split to R1b (timebox per #321)

- Permission-request round-trip (`item/permissions/requestApproval` — grant
  subsets, turn vs session scope, `strictAutoReview`) — schema pinned, not
  live-triggered.
- MCP-tool live approval/elicitation round-trip (needs a fixture MCP server).
- Network-policy amendment live round-trip + persistence location (enable
  experimental `network_proxy`).
- Concurrent approval requests (zsh-exec-bridge `approvalId` fan-out is in the
  schema: multiple callbacks per parent `itemId`).
- Fresh/resume/forked/interrupted session matrix (`thread/resume`,
  `thread/fork`, `thread/rollback`).
- App-server hook-trust mechanism (pre-trusting hooks without the TUI, so the
  PreToolUse seam works under app-server programmatically).
- Plugin auto-fetch disable knob for true fresh-profile isolation (C6).
- Client-side ask-timeout behavior at scale (server waits indefinitely — no
  server-side approval timeout observed within the timebox).

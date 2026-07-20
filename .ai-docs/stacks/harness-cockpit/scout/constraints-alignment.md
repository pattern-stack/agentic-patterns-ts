# Harness Cockpit — Constraints & Alignment Dossier

**Scout:** constraints + harness alignment (evidence pass, 2026-07-19)
**Strategy (locked, not relitigated here):** revive the Go chat-patterns TUI as the harness
cockpit speaking the TS server's live contract. Rounds: pre-work (N5 + cancellation) → R1 (Go
wire fixes, abort, no-allowlist flip, scope/preset on create, new consumer cmd) → R2 (HITL
approval e2e) → R3 (picker/replay + TS history shim, display_type, token footer).
**Inputs read in full:** `.ai-docs/research/cli-chat-parity/gap-analysis.md` (rev 2),
`/Users/dug/Projects/sandbox/agentic-patterns-ts/.ai-docs/stacks/harness-runners/design.md`
(v4, 652 lines), `.ai-docs/plans/harness-runners.yaml` (rev 2, synced).
**Every file:line below was re-read at today's HEADs** (agentic-patterns-ts `10d5c0b` main;
chat-patterns `187411b` = origin/main). Where a gap-analysis anchor had drifted, the corrected
path is given and flagged.

---

## 0. Two facts discovered during this scan that the plan must absorb

1. **The harness-runners plan is not a future — it is synced and OPEN.** Issues #317 (epic)
   through #332 exist on pattern-stack/agentic-patterns-ts, matching
   `.ai-docs/plans/harness-runners.yaml` keys 1:1 (f1→#318 … rel1→#332; verified via
   `gh issue list` 2026-07-19). The cockpit plan is therefore coordinating with a **live
   in-flight arc**, not anticipating a draft. The specific issues that touch cockpit surfaces
   are #319 (F2: `AskContext`/`BaseEvent.meta`), #328 (B3: permission-bridge transport widening
   + input-route conversation binding), #324 (E1: SSE union sync), #323 (B1: new event
   richness). §1 maps each to cockpit rounds.
2. **The chat-patterns clone was 5 commits behind origin and was fast-forwarded mid-scan**
   (reflog: `187411b HEAD@{0}: merge origin/main: Fast-forward`, from `0c93dd1`). Someone or
   something else is touching this clone concurrently. All chat-patterns evidence below was
   (re-)verified at `187411b`, which is `origin/main` and the true 12-commit history
   (2026-04-10 → 2026-04-12) the gap-analysis describes. **Plan hygiene:** the cockpit plan
   must pin the revival base commit (`187411b`) explicitly and treat the sandbox clone as
   disposable — work from a fresh clone of `github.com/pattern-stack/chat-patterns`.

---

## 1. (a) Harness-runners contract changes the cockpit must anticipate

Design of record: `.ai-docs/stacks/harness-runners/design.md` v4 (DRAFT awaiting Gate 0 human
read per its header line 3, but its plan is already synced to open issues — treat the shapes
below as committed direction). Delivery order (design §8 / plan `waves`): wave 1 = F1+F2+F3+R1
→ wave 2 = A1,B1 → wave 3 = A2,B2,E1 → wave 4 = A3,**B3** → wave 5 = B4,U1.

### 1.1 The five contract changes, with current-state evidence

| # | Change | Design ref | Current state (verified) | Lands in |
|---|---|---|---|---|
| C1 | `BaseEvent` gains optional `meta` record; synthesized/translated events carry `meta.synthetic: true` | §2 D2/D12, F-2 | `BaseEvent` today = `{type, traceId, runId, spanId, parentSpanId?, timestamp}` — **no meta** (`packages/agent-runtime/src/events/types.ts:29-36`) | F2 / #319 (wave 1 — **imminent**) |
| C2 | Ask events get **mandatory `requestId`**; the pending-input transport widens to carry **`AskContext`** `{requestId, operation, payload, proposals, availableDecisions, requested?, nativeIds, durableEnabled, actor?}` and replies widen from `{decision\|value}` to the `HarnessDecision` union (`allowOnce`/`allowSession`/`allowWithRules`/`deny`/`cancel`/`rewriteInput`/`grantPermissions`) with 4-step server-side validation | §5.4 D4/D5/F-2, B-3 | Today's `agent.input.request` payload is `{correlationId, toolName, arguments, prompt}` built at `packages/agent-runtime/src/interaction/approval-gate.ts:59-76` (correlationId = `intent.toolCallId`); return leg `POST /conversations/:id/input` body is `{correlation_id, decision?: "approve"\|"deny", value?}` (`packages/agent-server/src/routes/conversations.ts:465-489`) | B3 / #328 (wave 4) |
| C3 | **Conversation-binding fix** on `POST /conversations/:id/input` — today `:id` is "addressing sugar, not a second key" over a globally-keyed registry (comment verbatim at `conversations.ts:449-456`); B3 makes `:id` bind | §5.4 D10, B-3 | Registry is a global `Map` keyed by correlationId (`interaction/pending-input-registry.ts:50`) | B3 / #328 |
| C4 | New/enriched event kinds on the wire: `agent.gate.decision` (post-decision, for exporters), `harness-native` namespaced envelope events, `costUsd` on `agent.message.complete`, per-call `llm.end`, synthesized `llm.start`/`iteration.*` (marked `meta.synthetic`), `agent.tool.rejected` with `reason: "timeout"` and `settledBy` preserved end-to-end | §5.3, §5.4 (timeout policy: `askTimeout` default 300s), F-2 | Dashboard union already 5 names adrift (#286); E1/#324 adds a drift check | F2+B1 / #319+#323 (waves 1-2), E1 / #324 (wave 3) |
| C5 | Gate-chain extensions: `GateRequirements`, guaranteed audit phase, `GateResult.decision`, `evaluateIntent`/`GateEvaluation` (`settledBy: "gate"\|"human"\|"timeout"`) | §5.2, §5.4 | Gate chain order SAFETY→RATE_LIMIT→APPROVAL→AUDIT (`gates/base.ts:6-9`); bus early-returns on block skipping audit (`events/agent-event-bus.ts:61-70`, the `return []` after `_emitRejection`); approval callback is boolean (`gates/approval.ts:10-11`) | F2 / #319 |

C5 is server/runtime-internal — no wire shape reaches the cockpit except through C2 and C4.

### 1.2 Forward-compatibility obligations per cockpit work item

**R1 — no-allowlist flip (`internal/sse/parse.go`)** ← C1, C4.
This is the single most load-bearing forward-compat move. The parser today drops unknown event
names (default case) and parses only the legacy `agent.tool.rejected` (`internal/sse/parse.go:119`,
verified — canonical `tool.rejected` missing). Obligations:
- Unknown event **names** pass through to the reducer/render layer as a generic event (never
  `nil`) — this is precisely gap-analysis §2.6.3 and it is what makes `agent.gate.decision`,
  `harness-native`, and future kinds non-breaking.
- Unknown **fields** in known payloads must be ignored, and known structs must never use
  `json.Decoder.DisallowUnknownFields` — Go's default lenient decode already satisfies this;
  make it an explicit test (decode a `message.complete` payload with extra `costUsd` + `meta`
  keys; assert no error).
- Add `case "tool.rejected"` alongside the legacy alias, and parse an optional
  `reason` field now — C4 will start sending `reason: "timeout"`; rendering "denied (timeout)"
  vs "denied" is a one-line switch later if the field is already captured.

**R1 — wire fixes / new consumer cmd** ← C1.
When defining Go-side event payload structs, include an optional
`Meta map[string]any \`json:"meta,omitempty"\`` on the base envelope from day one. Cost: one
field. Benefit: when F2/#319 ships `meta.synthetic`, the cockpit can badge synthesized events
(harness-runners plan E1/#324 explicitly warns: "badge synthesized events; never chart them as
causal latency" — the cockpit's future trace/footer views inherit the same rule).

**R2 — HITL approval e2e** ← C2, C3. This is the round with real coupling. Design decisions:
- **Build against today's contract** (`{correlationId, toolName, arguments, prompt}` request;
  `{correlation_id, decision}` reply — both live-verified per gap-analysis §2.1 and re-read at
  `conversations.ts:465-489`). Do NOT wait for B3/#328 (wave 4, behind B2 which is behind R1's
  Codex spike — realistically weeks out).
- **Shape the Go types for the widening now:**
  ```go
  // internal/sse — request side
  type InputRequest struct {
      CorrelationID      string          `json:"correlationId"`
      RequestID          string          `json:"requestId,omitempty"`      // C2: alias, wins when present
      ToolName           string          `json:"toolName"`
      Arguments          json.RawMessage `json:"arguments"`
      Prompt             string          `json:"prompt"`
      AvailableDecisions []string        `json:"availableDecisions,omitempty"` // C2: absent today
      Payload            json.RawMessage `json:"payload,omitempty"`            // C2: AskContext passthrough
  }
  // internal/httpclient — reply side
  type InputDecision struct {
      CorrelationID string `json:"correlation_id"`
      Decision      string `json:"decision,omitempty"` // "approve" | "deny" today; HarnessDecision.kind later
      Value         string `json:"value,omitempty"`
  }
  ```
  Settlement key = `RequestID` if non-empty else `CorrelationID`. Decision buttons render from
  `AvailableDecisions` when present, else the approve/deny pair. When B3 lands, the server's
  4-step validation will reject unknown kinds — offering only what `availableDecisions` lists
  makes the cockpit automatically correct on both sides of the transition.
- **Always POST the input to the same `:id` the stream belongs to.** The cockpit naturally
  does this, but C3 turns "wrong :id still resolves" into a 404 — never rely on the global-key
  behavior (e.g., no "reply from the session list" shortcut that posts to a stale id).
- **Fail-closed awareness:** stream teardown auto-denies pending requests
  (`conversations.ts:440-447`: on stream close, `inputRegistry.resolve(correlationId,
  {decision:"deny"})`). The cockpit's abort path (R1) must therefore expect a deny/rejected
  event race when the user cancels mid-approval — render it as cancelled, not as a server error.

**R3 — token footer** ← C4. `message.complete` today carries
`{content, input_tokens, output_tokens}` — the Go struct already exists and is dead
(`internal/sse/types.go:11-16`, `SSEMessageCompleteData`, verified). Wire it, and add
`CostUsd *float64 \`json:"costUsd,omitempty"\`` in the same change — B1/#323 puts `costUsd` on
`agent.message.complete` and the SSE mapping forwards payload fields. Footer renders cost only
when present.

**R3 — picker/replay + TS history shim** ← no direct harness-runners coupling (the read routes
are untouched by that arc), but the shim PR edits `packages/agent-server/src/routes/conversations.ts`,
which B3/#328 and #296 also edit — see §4.3 collision protocol.

**R3 — display_type** ← none. The server-side field option touches
`packages/agent-runtime/src/transport/sse-formatter.ts:151-159` (the `agent.tool.end` case —
verified; note the gap-analysis calls this file `sse-formatter.ts` and it lives in
**runtime/transport**, not agent-server; agent-server's `src/sse.ts` is a 40-line wrapper that
delegates to `toSSEMapping`, `sse.ts:22,36-37`). The established optional-field idiom is right
there: `if (event.display !== undefined) payload.display = event.display` at
`sse-formatter.ts:270,283,299` (backpack events). Harness-runners does not touch this case.

### 1.3 Sequencing stance (recommendation)

The cockpit plan should declare, in writing, per round:
- **R1/R3: no dependency on harness-runners.** Pure additive lenient-decode rules above are
  sufficient.
- **R2: build on today's transport; state disposition vs #328.** Concretely: "R2 implements
  approve/deny against the current `interaction/` transport; #328 (B3) later widens the same
  transport — the cockpit's `availableDecisions`-driven rendering and requestId aliasing are
  the declared forward-compat seam; when #328 lands, the cockpit needs only new decision-kind
  strings, no structural change." This mirrors exactly how harness-runners B3 itself declares
  dispositions vs #296/#234 (plan YAML b3 description, "COLLISION" paragraph).
- **Do not** implement any part of `AskContext`/proposals/durable decisions ahead of #319/#328
  — D13 feature-flags durable kinds off until #307 (auth), and the shapes may still shift in
  Gate 0 review (design header says "awaiting final human read").

---

## 2. (b) Repo & process constraints — agentic-patterns-ts

### 2.1 Landing changes

- **Every commit lands via PR to protected `main`; required status is `check`** (CLAUDE.md
  "Landing changes"; docs included — even this dossier's eventual home lands via PR).
- `bun run check` = build + typecheck + lint + test (CLAUDE.md Development). Budget CI time in
  each slice's acceptance.
- **Versioning:** runtime/server/cli bump in lockstep, core floats. Recipes verified at
  `Justfile:89` (`bump-lockstep level="patch"`), `:93` (`bump-core`), `:97`
  (`bump-both lockstep="minor" core="minor"`). Publish fires on merge to `main` when versions
  changed.
- **Publish gate (memory, proven on eval-surface ship):** `rm bun.lock && bun install` must be
  in the **same commit** as the version bump.
- Version impact per cockpit slice:
  - N5 fix, history shim, cancellation route (if chosen): **server only** → `just bump-lockstep`
    at the release tail.
  - `display_type` server field (R3, optional path): touches **core** (`ToolDefinition`/
    `ToolSchema`) + runtime + server → `just bump-both` (gap-analysis §2.5 already prices this).
  - Go-side work: no TS version impact.
- Decision records go to `docs/adr/NNNN-*.md` (CLAUDE.md); the license/relicense call in §3.1
  and the cancellation-ownership call in §5 are ADR-worthy if decided.

### 2.2 chat-patterns repo process (contrast — this is the gap)

`github.com/pattern-stack/chat-patterns`: **no `.github/` directory at all** (verified —
`NO-.github`), so no CI, and no evidence of branch protection; all 12 commits are direct to
`main`. The revival plan must state the process explicitly. Recommendation for R1's first PR:
add a minimal GitHub Actions workflow (`go build ./... && go vet ./... && go test ./...` on
push/PR, Go 1.25.x + 1.26.x matrix) and adopt PR-to-main discipline mirroring the TS repo.
Cheap, and it makes every subsequent wire-fix PR self-verifying.

### 2.3 Plan YAML schema for the plan author

Two generations exist under `.ai-docs/plans/` — **do not copy the wrong one**:

- `playground-upgrades.yaml` is the **older stack-oriented schema** (`plan_key`, `repo`,
  `tracker: none`, `gate_policy`, `phase_models`, `stack: [branch names]`, lines 1-25) — it was
  driven from spec paths with PRs as the only artifact, never synced to the tracker.
- `harness-runners.yaml` is the **canonical `/sdlc:plan` → `/sdlc:sync-issues` schema**, and it
  is proven: its sync produced epic #317 + leaf issues #318–#332 exactly (idempotent by
  plan-key marker per the sync-issues skill). **Use this schema.**

Schema, exactly as exercised by `harness-runners.yaml`:

```yaml
# Header comment block (free-form, load-bearing by convention):
#   gate-0 provenance, plan revision + review trail, spec-of-record path.

plan:
  slug: <kebab-slug>            # plan key; sync idempotency marker
  summary: "<one sentence>"
  milestone: null               # repo has no milestone discipline; epic carries rollup
  auto_approve: false           # gate1 strict → every leaf gets gate:human
  epic_title: "<epic issue title>"
  epic_body: |                  # markdown; states spec of record, tracks, waves,
    ...                         # and cross-issue coordination/disposition notes

issues:                         # one entry per leaf issue, dependency-ordered
  - key: <short-key>            # e.g. f1, b3 — referenced by depends_on
    title: "<package-prefixed issue title>"   # e.g. "runtime+server: ..."
    depends_on: [<keys>]        # other keys in this file, [] for roots
    labels: [runtime, server]   # repo labels; [] allowed
    description: |
      **Size S|M|L · branch `<prefix>/<key>-<slug>` · packages: ... · spec: <doc §refs>**

      <body: change description, blast radius, collision/disposition notes>

      **Acceptance:** <testable criteria; disposition-stated requirements>

# --- Auxiliary metadata (NOT consumed by /sync-issues; source of truth for execution) ---
execution_policy:               # list of prose invariants (merge barriers, shared-surface
  - >-                          #   serialization, verified file-disjointness claims)
waves:                          # merge-barrier groupings
  - id: wave1
    slices: [f1, f2]
    human_gate: <optional prose gate>
locked_decisions:               # curated design decisions implementers must not relitigate
  - <one-liner each>
```

Conventions worth copying verbatim (they carry process weight in this repo):
size taxonomy S < 200 LoC / M < 600 / L = own mini-plan (design.md §8); branch names embedded
in the description header; **collision issues named in ALL-CAPS "COLLISION:" paragraphs with a
"disposition stated in the spec" acceptance line**; spikes marked `SPIKE:` in the title with
"HUMAN READ before <dependent> starts" gates.

**Cross-repo wrinkle:** `/sdlc:sync-issues` syncs to one tracker; chat-patterns is a separate
GitHub repo. Recommendation: track ALL cockpit issues (Go and TS alike) in
pattern-stack/agentic-patterns-ts (the epic's home, where the reviewers live), with Go issues'
descriptions naming the chat-patterns branch they land on. Avoids a split board; the plan YAML's
`labels` can carry a `cockpit` or `go` marker for filtering.

---

## 3. (c) chat-patterns constraints

### 3.1 License — BSL 1.1 (verified, LICENSE at repo root)

- Licensor: **Doug**; Licensed Work: **"agentic-tui"** (c) 2026 Doug — note the name predates
  the chat-patterns rename; a cleanup commit should fix the Licensed Work name.
- **Additional Use Grant:** production use permitted **unless** offering the Licensed Work to
  third parties as a commercial product or hosted/managed service.
- **Change Date: 2030-04-10 → Apache 2.0.**
- Implications for the cockpit: using the TUI as the internal harness cockpit is squarely
  inside the Additional Use Grant — **no blocker**. Two decisions the plan should still record
  (one ADR or a LICENSE-note commit):
  1. Whether to keep BSL 1.1 or relicense (sole author = Doug, so relicensing is a signature,
     not a negotiation — gap-analysis §3 flags the same for any code flowing toward MIT
     tui-patterns).
  2. If cockpit code is ever vendored INTO agentic-patterns-ts (e.g., docs, fixtures, the
     contracttest harness), the direction BSL→(whatever agentic-patterns-ts uses) needs the
     same explicit note. Keep Go code in the Go repo and this never arises.

### 3.2 Revival hygiene — build/test status (commands run 2026-07-19)

- Pinned base: `187411b` (`feat: agenti-kit providers, team conversations, surface theme, and
  stable tool args`, 2026-04-12) = `origin/main`, 12 commits total, dormant ~3 months —
  matches gap-analysis §3.
- **`go build ./...` at 187411b: PASS (exit 0). `go test ./...`: PASS** — 7 packages with
  tests all `ok` (`contracttest`, `internal/chat`, `internal/sse`, `internal/stdioclient`,
  `internal/ui`, `internal/ui/components/atoms`, `internal/ui/components/molecules`); 13
  packages have no test files (notably **`internal/httpclient`, `internal/cliclient`,
  `internal/app`, `internal/command` are untested** — the httpclient gap is exactly where all
  the R1 wire fixes land; every R1 fix must arrive with the package's first tests).
- Toolchain: local `go1.26.1 darwin/arm64` against `go.mod` `go 1.25.0` — builds and tests
  green; no toolchain directive issues. Recommendation: leave `go 1.25.0` in go.mod (no
  language-version need), add the 1.25/1.26 CI matrix per §2.2.
- No CI, no `.github/` (§2.2). `CLAUDE.md`, `Justfile`, `PROTOCOL.md` exist at root; consumer
  app at `cmd/agenti-kit`; public Go API at root (`client.go`, `tui.go`, `service.go`,
  `config.go`, `types.go`) delegating into `internal/`.

### 3.3 Dependency currency (queried via Go module proxy 2026-07-19)

| Module | Pinned | Latest | Delta |
|---|---|---|---|
| `charm.land/bubbletea/v2` | v2.0.2 | **v2.0.8** | 6 patch releases |
| `charm.land/bubbles/v2` | v2.0.0 | **v2.1.1** | minor + patches |
| `charm.land/lipgloss/v2` | v2.0.2 | **v2.0.5** | 3 patches |
| `github.com/alecthomas/chroma/v2` | v2.23.1 | (not checked) | — |
| `github.com/yuin/goldmark` | v1.7.17 | (not checked) | — |

The repo is already on the Bubble Tea **v2 line** (`charm.land/*` module paths) — the hard v1→v2
migration is behind it; currency is patch/minor-grade. Recommendation: `go get -u` the three
charm modules in a dedicated early-R1 PR with the full test suite + a manual TUI smoke
(`cmd/`), before behavioral fixes stack on top. Risk: low; Bubble Tea v2 patch releases have
occasionally adjusted key/mouse event details — the repo's mouse-wheel and click-to-expand
handling (`internal/chat/model.go:175-204` area per gap-analysis) is the thing to smoke.

### 3.4 R1 change sites at HEAD — corrected anchors + proposed diffs

The gap-analysis cites several paths without the `internal/` prefix; all resolved at `187411b`:

| Fix (gap §2.2 #) | Exact site at HEAD | Proposed change |
|---|---|---|
| #1 send path | `internal/httpclient/client.go:32` — default `sendMessage: "/conversations/{id}/send"` | change default to `"/conversations/{id}/messages"`; **N6 doc drift confirmed the other way around**: the comment at `internal/types/types.go:178` already documents `// default: "/conversations/{id}/messages"` — the CODE is what's wrong; fixing the code also resolves N6 |
| #1 send body | `internal/types/types.go:112-114` — `SendMessageRequest{ Message string \`json:"message"\` }`, marshalled at `internal/httpclient/client.go:204` | rename field tag to `json:"content"` (keep Go field name `Content`); server requires `content` (`agent-server/src/routes/conversations.ts` messages handler; live-verified 400 `content is required` per gap-analysis) |
| #2 create body | `internal/types/types.go:106-107` — `CreateConversationRequest{ AgentName string \`json:"agent_name"\` }` | add/rename to `AgentID string \`json:"agent_id"\``; server reads `body.agent_id` and 404s "Agent not found" otherwise (`conversations.ts:64-70`, verified — it looks up `undefined`, N2's misleading-404 shape) |
| #3 role decode ×2 | `internal/httpclient/client.go:110-168` region AND `contracttest/validate.go:53` — `Role string \`json:"role"\`` (verified) | decode as `struct{ ID, Name string }` pointer (server emits `role: {id, name} \| null`, `agent-server/src/routes/agents.ts:81`, verified) — **fix both places** or contracttest aborts at step 2 forever |
| #4 tool.rejected | `internal/sse/parse.go:119` — only `case "agent.tool.rejected":` (verified) | add `case "tool.rejected":` same arm; capture optional `reason` (C4 timeout prep, §1.2) |
| #5 tokens/run_id | `internal/sse/types.go:11-16` — `SSEMessageCompleteData{Content, InputTokens, OutputTokens}` exists, unused (verified) | wire into the model for the R3 footer; capture `done.run_id`; add `CostUsd *float64` (§1.2) |
| #9 abort | `internal/chat/model.go:568` — `client.SendMessage(context.Background(), convID, text)` (verified) | hold a per-turn `context.CancelFunc` on the model; Esc cancels; render aborted ≠ error (see §5 cancellation decision for the server half) |
| no-allowlist flip | `internal/sse/parse.go` default case | pass unknown events through as a generic `{Name string; Payload json.RawMessage}` chunk (§1.2) |
| scope/preset on create | `internal/types/types.go:106-108` + create call path | add `Scope map[string]any \`json:"scope,omitempty"\``; presets come from `GET /agents` `instantiation.presets` (`agent-server/src/routes/agents.ts:89-93`, verified: `{available, defaults, schema, presets}`) — client-side materialization, same as React |

**Test plan for R1 (Go side):** (1) first-ever `internal/httpclient` unit tests — table-driven
encode/decode against recorded JSON fixtures captured from a live `ap playground` (the
gap-analysis notes the reusable smoke harness at `(scratchpad)/contract-live/`); (2)
`contracttest.ValidateBackend` run against a live server becomes the acceptance gate: it
currently fails at step 2 (ListAgents role decode) — after R1 all four checks must pass, and a
fifth check should be added asserting the stream contains ≥1 `event:` line before `done`
(catches N5-class torn streams, which the current status/content-type-only assertions cannot —
gap-analysis §2.2); (3) lenient-decode tests (unknown fields + unknown event names) per §1.2;
(4) abort test: cancel mid-stream, assert UI state "aborted" and no error banner.

---

## 4. (d) GitHub issue overlap verdicts

All three viewed via `gh issue view` 2026-07-19; plus two adjacent collisions found.

### #306 — "Chat organism package-ization (transport injection + token fallbacks)" — **NO OVERLAP**

OPEN, labels enhancement/audit. It extracts the **React** chat (`packages/agent-dashboard`
`chat/`) into an injectable-transport organism, explicitly "gate[d] on a second consumer
becoming real, e.g. the dealbrain chat migration." The cockpit is a Go client of the **server
wire contract**, not a consumer of the React organism — it neither advances nor blocks #306,
and it does **not** count as #306's "second consumer" (that gate means a second *React-organism*
consumer). Plan disposition: exclude; one sentence in the epic body to preempt the confusion
("the cockpit consumes the HTTP/SSE contract, not the chat organism — #306 unaffected").

### #304 — "Split ChatPage.tsx (1,267 lines, …)" — **NO OVERLAP**

OPEN, label audit, requires #290 first. Pure dashboard-internal refactor of
`packages/agent-dashboard/src/pages/ChatPage.tsx`. No cockpit slice touches any dashboard
file (the only dashboard-adjacent cockpit concern is reading `ChatPage` as the parity
*reference*, which is read-only). Plan disposition: exclude.

### #234 — "server: conversation SSE stream stalls after ~14 bytes when the CLI runs under bun" — **DIRECT OVERLAP with pre-work N5, but they are two distinct defects**

OPEN, no labels. This is the critical one to get right, because **#234 and N5 share the exact
observable signature** — exactly 14 bytes, `data: {"conver`, no `event:` line — but different
causes and different fixes:

- **#234 (transport bug):** under **bun 1.3.9** the stream stalls at 14 bytes **even when the
  run succeeds server-side** ("the run row closes with `status: ok`"); identical build under
  node 22/25 streams fully. Suspect: `@hono/node-server` `streamSSE` write path under bun's
  node-compat layer. Fixing the drain loop will NOT fix this.
- **N5 (robustness bug):** on any **pre-token runner failure** (model-resolution reject,
  missing API key) no `error` frame and no `done` are ever written. Verified at HEAD: the drain
  loop at `packages/agent-server/src/routes/conversations.ts:392-406` is `try { for await … ;
  writeSSE(done) } finally { … }` — **there is no `catch` that writes an SSE error frame.**
  Fixing bun will NOT fix this.
- **Corollary the plan must state:** the gap-analysis's N5 live repro (14 bytes) was produced
  under whatever runtime the playground ran on; if that was bun, part of the observed 14-byte
  truncation may have been #234's stall *compounding* N5's missing frame. The pre-work item
  must therefore verify under **both** runtimes.

**Pre-work item shape (proposed):**
1. Add `catch` to the drain loop: `catch (err) { await stream.writeSSE({event: "error",
   data: JSON.stringify({message: String(err?.message ?? err), recoverable: false})});
   }` then always write `done` (existing `finally` keeps the run-metadata stamp). Note the
   teardown deny-sweep (`conversations.ts:440-447`) already lives on close — the catch must not
   bypass it.
2. Test: vitest in `agent-server/__tests__` with a conversation whose runner rejects before the
   first event → assert the response body contains an `error` frame and a `done` frame (this is
   the missing branch coverage #293 "Server test backfill: the failure-mode branches" also
   wants — cite it).
3. Manual verify under node **and** bun using #234's exact curl repro. If bun still stalls,
   #234 stays open with a stated disposition ("N5 fixed; #234 is the bun/hono transport half,
   tracked separately") — do not silently subsume it.
4. **Plan disposition line:** "Pre-work fixes N5 (missing error frame) and *references* #234;
   it closes #234 only if the bun repro passes post-fix."

### Adjacent collisions the plan must also name (found while verifying)

- **#296 "Consolidate server SSE fan-out onto the runtime SSEExporter"** and **#328 (B3)** both
  edit `routes/conversations.ts` — the same file as the N5 fix, the cancellation work (if a
  route is added), and the R3 history shim. The harness-runners plan already declares "#296 +
  #234 share conversations.ts — spec declares subsume-or-sequence before implementation" (b3
  description). The cockpit plan must add itself to that protocol: recommend **pre-work lands
  first** (it is small and everyone benefits — gap-analysis §2.6.4), and the R3 shim states its
  ordering vs whatever of #296/#328 has landed by then.
- **#287 "SendMessageBody doc schema disagrees with the conversations handler"** — relevant to
  R1 fix #1: the recommendation above fixes the **Go client** to send `content` (no server-side
  `message` alias), which keeps #287 a pure docs fix and avoids widening the server contract.
  State this disposition in the R1 issue.
- **#300 "Docs staleness: cockpit-port marked 'Ready to start' but shipped"** — naming
  collision only: an existing doc uses "cockpit-port" for something already shipped
  (dashboard-side). The new arc's name "harness cockpit" risks confusion; the epic body should
  disambiguate, and #300's cleanup should not sweep up the new stack directory.

---

## 5. Open decisions (with recommendations)

| # | Decision | Options | Recommendation |
|---|---|---|---|
| OD-1 | **Cancellation ownership** (pre-work) | (a) bless connection-drop (React's stance, gap §2.6.2); (b) add `POST /conversations/:id/cancel` | **(a) for pre-work, (b) deferred with a stated trigger.** Go's `context` cancellation aborts the POST cleanly, matching React semantics; the teardown deny-sweep already fail-closes pending approvals on drop (`conversations.ts:440-447`). Pre-work then only needs to *verify* server-side behavior on client disconnect (does the runner abort? is the run row closed?) and document it. Add the cancel route only if that verification shows the runner keeps burning tokens after drop — in which case it becomes a small server slice (`agent.message.cancel` emission per gap §2.6.2) and must join the conversations.ts collision protocol (§4.3). |
| OD-2 | **display_type sequencing** (R3) | heuristic-first vs server-field-first | **Heuristic first** (~30 Go lines, zero server cost, works today), server field later as an independent core+runtime slice (`bump-both`) that overrides the heuristic when non-empty — gap §2.5 shows they compose. Caveat carried from the gap-analysis: chat-patterns promotes only **string** results; keep that limit documented in the R3 issue. |
| OD-3 | **License posture** (R1) | keep BSL 1.1 (+fix Licensed Work name) vs relicense | **Keep BSL 1.1, fix the "agentic-tui" name, record a one-paragraph note** (ADR or LICENSE commit). Cockpit use is inside the Additional Use Grant; relicensing can wait until code actually needs to cross into an MIT repo. |
| OD-4 | **Charm dep bump timing** (R1) | bump-first vs fix-first | **Bump first** in a dedicated PR (tests + TUI smoke), so behavioral fixes are never entangled with dependency behavior changes. |
| OD-5 | **Tracker home for Go issues** | chat-patterns repo vs agentic-patterns-ts | **agentic-patterns-ts** (single board, single epic rollup, `/sdlc:sync-issues` compatible); Go issues name their chat-patterns branch. §2.3. |
| OD-6 | **R2 timing vs #328** | wait for B3 vs build on today's transport | **Build now on today's transport** with the §1.2 forward-compat seam; state the disposition in the R2 issue exactly as harness-runners b3 does for its collisions. B3 is wave-4 of a six-wave arc — waiting couples the cockpit's critical path to a Codex spike (#321) it has nothing to do with. |
| OD-7 | **contracttest hardening scope** | minimal (fix role decode) vs add stream-content assertion | **Add the ≥1-`event:`-line-before-`done` assertion** (§3.4 test plan) — it is ~10 lines and turns the suite into a genuine N5/#234 tripwire for every future revival of any Go client. |

---

## 6. Evidence index (what was run/read)

- Read in full: gap-analysis.md rev 2 (worktree copy); harness-runners design.md v4 (652
  lines, main-repo copy); harness-runners.yaml (358 lines); playground-upgrades.yaml header.
- Commands: `go version` / `go build ./...` / `go test ./...` at chat-patterns `187411b`
  (PASS/PASS, output in §3.2); `go list -m -versions` for bubbletea/bubbles/lipgloss v2;
  `gh issue view 306 304 234`; `gh issue list` (open, first 40); git reflog/log/branch/remote
  on the chat-patterns clone.
- TS anchors re-verified at main `10d5c0b`: `events/types.ts:29-36` (BaseEvent, no meta),
  `gates/base.ts:6-9`, `gates/approval.ts:10-11`, `events/agent-event-bus.ts:61-70`,
  `interaction/approval-gate.ts:59-76`, `interaction/pending-input-registry.ts:50`,
  `routes/conversations.ts:64-70` (create), `:228-241` (/admin list, camelCase), `:246`/`:279`
  (detail/messages routes; no bare list route), `:392-406` (drain loop, no catch), `:440-456`
  (teardown deny + addressing-sugar comment), `:465-489` (input body),
  `routes/agents.ts:81,89-93`, `transport/sse-formatter.ts:74,151-159,270-299`,
  `storage/conversation-store.ts:42` (StoredMessage.parts inline — gap-analysis cited
  "store.ts:42"; corrected path), `agent-server/src/sse.ts:22,36`, `Justfile:89-97`.
- Go anchors re-verified at `187411b`: `internal/httpclient/client.go:32,82-85,204,209,262`,
  `internal/types/types.go:106-114,145-160,178`, `internal/chat/model.go:568`,
  `internal/sse/parse.go:119`, `internal/sse/types.go:11-16`, `contracttest/validate.go:53`,
  `LICENSE` (BSL 1.1 parameters), `go.mod`, absence of `.github/`.

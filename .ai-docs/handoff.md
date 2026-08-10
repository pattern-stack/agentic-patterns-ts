# Handoff — 2026-08-10 (overnight session)

**Branch:** `main` (clean). Everything in agentic-patterns is merged; **the provider fix is NOT published**.
**Last action:** Merged #474 (bundled AI-SDK providers) — `main` green. Before that: released core 0.18.0 / lockstep 0.39.0, shipped three sdlc-plugin versions, and proved the ambient morning-brief loop end to end including a reply that the agent actually remembers.

**Next action — in order:**
1. **Cut a release** (`just bump-both`). #474 is on `main` but npm is still core 0.18.0 / runtime 0.39.0, so **no consumer can get the provider fix yet**. Everything downstream waits on this.
2. **Decide gateway vs direct key for swe-brain** — see "The gateway decision" below. It is blocked on one fact, not on design.
3. **Merge the two swe-brain branches** (below) — both green, both unmerged.
4. **Point the morning brief at real data.** It currently reports, correctly, that the workspace is empty. That proves the machinery, not the value.

**Obstacles:**
- **`bump.sh` re-resolves `bun.lock` and will trip `sdk-contract.test.ts`** whenever `@anthropic-ai/claude-agent-sdk` has moved (hit this session: 0.3.225 → 0.3.226). The test is working as designed. Fix: review the lock diff, then re-pin `packages/agent-runtime/src/runner/__fixtures__/claude-agent-sdk-contract.json` — **only** if the platform-package *set* and `peerDependencies` are unchanged. If either moved, that is real upstream repackaging. Already filed as **#379**.
- **`gh` CLI cannot resolve `api.github.com` on this machine.** `dig` resolves it; `curl`/`gh` return "could not resolve host" (`github.com` itself is fine — it is a stale negative cache for that one hostname). Fix is a DNS flush (needs sudo). Workaround used all session: `curl --resolve api.github.com:443:$(dig +short api.github.com | head -1)` with `$(gh auth token)`.
- **`agent_runs.final_answer` is empty** — and the cause is now known: **nothing in swe-brain ever writes it**. `RunFinalizePatch` omits it and no writer exists. That reframes sdlc-patterns#363 as an app-side gap, not a claude-CLI quirk.

---

## Shipped

| What | Where | State |
|---|---|---|
| core 0.18.0 / runtime+server+cli 0.39.0 | #468 | **published**, dist-tags verified |
| Walkthrough §A4 corrected (two false claims) | #467 | merged |
| Bundled AI-SDK providers + loud failure | #474 | **merged, unpublished** |
| sdlc plugin **0.2.23** — `mcpServers` hoisted out of `components` | claudecode-patterns#114 | released |
| sdlc plugin **0.2.24** — `guided-tour` | claudecode-patterns#115 | released |
| sdlc plugin **0.2.25** — `driving-mode` | claudecode-patterns | released |

## Filed

- **#470** — `TRIGGER_KINDS` has no member for an internal domain event. **Decision recorded: add `event`, with a subkind.** Open design question inside: does the subkind reuse `label` (zero schema change, renders correctly today) or get an explicit field? Reuse `label` unless hosts need to *route* on it.
- **#472** — provider packaging. **Closed by #474**, decision recorded (anthropic/openai/google).
- **#473** — `RunResult` must carry the model actually used. Doug's requirement: *"every single run should be able to store the model that it ran with"*, and a fallback must be **resolved and written**, never dropped.
- Design principle + adoption correction on **#438**; measured evidence on **#456**.

---

## The four bugs — three of them silent

1. **The framework never shipped its provider packages.** `@ai-sdk/anthropic` was a **devDependency** — so workspace tests passed while every published consumer got nothing. *The tests were lying by construction.* Consequence: any consumer fell through to `ClaudeCodeAPIRunner`, **the one runner that never reads `options.messageHistory`**, so every multi-turn conversation silently lost all context. Fixed in #474: all three are real deps, a present credential now **stops the ladder** with a fix-naming error rather than degrading, and a packaging-contract test fails if a provider is ever demoted again. Also found: **a provider env var set to empty string is falsy**, so detection skips it exactly as if unset.
2. **`components` wrapper in the plugin manifest** — not a valid field, so the three browser MCP servers had never registered in any project. Invisible because `skills/`, `agents/`, `commands/` have *default directory scans*; `mcpServers` has no default location, so it alone was fatal. `claude plugin validate` catches it outright and is now wired into that repo's CI.
3. **Ambient runs created no conversation** — one literal `null` for `conversationId` in `runTriggered`. 292 runs invisible. Fixed on branch.
4. **Per-run `seq` collisions** — `agent_run_events.seq` restarts at 1 per run, so a multi-run thread had many rows keyed `1`; React dropped/duplicated them. 198 console errors → 0. Latent before; replying to an ambient thread makes it routine.

---

## The ambient demo — works, unmerged

**Branch `feat/ambient-morning-brief`, draft PR sdlc-patterns#365, three commits.** Verified live, not just typechecked: shadow DB, real dispatcher, real CAS claim.

- A scheduled run creates `Morning brief — <date>` with both turns (user seq 0, assistant seq 1) and a non-null `conversation_id`.
- The console composer is **enabled** on it; a reply threads into the same conversation (seq 2, 3) and starts a second run carrying the same `conversation_id`.
- **The agent remembers.** Passphrase `ZEBRA-7741-MARLIN` recalled two turns later; brief recalled as `emails=0, meetings=0`; input tokens grew monotonically 563 → 854. (Two *negative* probes — asking the model about its own transcript — were answered wrongly by `gpt-5.4-nano`; its self-report is not trustworthy either way, so the conclusion rests on the passphrase and the token arithmetic.)
- **Reversibility proven live:** stripped the flag, re-fired, `conversation_id` back to NULL, byte-identical. No migration, no framework change; the on/off switch is a directive step param — a **database row**.

⚠️ **Never enable the thread flag on `demo-minutely`.** The console seeds from the first page only — 50 messages, `created_at desc`, across ALL conversations. At one run/minute that window blows in ~25 minutes and the brief vanishes from the UI while still in Postgres. 9am cadence is safe.

**Second swe-brain branch:** `deps/ap-core-0.18-runtime-0.39` — the core 0.18/runtime 0.39 adoption. 617 → 620 tests pass, green, pushed, **no PR** (the agent's `gh auth` reported an invalid token).

---

## How model selection actually works (this cost a cycle — read it)

- `runTriggered` calls `createRunner()` with **no arguments**, so the model comes from **`process.env.AGENT_MODEL`**. An agent's `model_override` **never reaches runner selection**; `AgentRunner` pins the model *"regardless of what the agent declares."* The DB pin only labels the persisted rows and the console chip.
- Therefore, whenever `AGENT_MODEL` disagrees with the agent's pin, **the row names a model that was never called.** That is the audit-honesty defect behind #473.
- **With a gateway configured this inverts.** `AP_GATEWAY_BASE_URL` triggers rung 2.5 — the resolver — which resolves *each agent's declared model per run*. So declared == used, and #473 largely dissolves on that path. But `AGENT_MODEL` stops being the lever entirely (open issue **#243**, override-vs-gateway precedence), and **an agent with no declared model fails loud** under a gateway.

## The gateway decision — blocked on one fact, not on design

Doug's preference is the gateway, *"provided that gateway also runs through agentic patterns"* and that model choice stays defined the same way. Status:

- **Clean:** one env var routes every agent through it, no code change.
- **Presidio has a designed seam already:** `AP_GATEWAY_GUARDRAIL_IDS` → Bifrost `x-bf-guardrail-ids`, and **#407** covers typed guardrail violations + redaction events.
- ❌ **The blocker:** the gateway configured in `.env.local` (`https://bifrost-development.findtempo.co/v1`) carries **188 models — 130 openai, 58 gemini, ZERO anthropic**. swe-brain's `workspace-analyst` declares `claude-sonnet-5`, and under a gateway the *declared* model is used. **So pointing swe-brain at that gateway fails on the first run.**
- **There are two gateways, and they are genuinely different machines.** The credentials in `.env.local` point at `https://bifrost-development.findtempo.co/v1`, which resolves to `bifrost-alb-…us-east-1.elb.amazonaws.com` — an **AWS-hosted** deployment. Doug's own box is `http://10.88.111.51:8080` (Tailscale, ~44ms), and **Bifrost + Presidio both live there**. So the gateway the repo is configured against is *not* the one with Presidio on it. Untangle that before wiring swe-brain to either.
- **The local box is a *governed* Bifrost instance and needs a virtual key.** Basic auth (`admin` / password in 1Password → OAuthPass) succeeds, and the request then fails at the Bifrost layer:
  ```
  GET http://10.88.111.51:8080/v1/models
  401 {"type":"virtual_key_required",
       "error":{"message":"virtual key is required. Provide a virtual key via the x-bf-vk header."}}
  ```
  **Nothing needs building** — `createRunner` already supports this via `AP_GATEWAY_VIRTUAL_KEY` → `x-bf-vk`, and its own doc comment says *"governed instances 401 without it."* It just needs a VK minted in the Bifrost UI. **So the local catalog is still unread, and whether it carries Claude is still unknown — but for a precise, fixable reason.**
  - Base URL for that box is **`/v1`** (`/api/v1` returns the UI's HTML — the SPA catches unknown routes, so a wrong base URL fails confusingly rather than 404ing).
  - ⚠️ An earlier draft of this handoff said the API was at `/api/v1`. That was probed against `10.88.111.**52**`, the wrong host. Corrected.
- **Cheapest unblock:** point the agent at a Gemini or OpenAI id the gateway actually has.

## Two open decisions

1. **Gateway vs direct key for swe-brain** — see above.
2. **Model requirement.** Doug: *"every single run should be able to store the model that it ran with"* — a fallback is fine, but it must be resolved and written. `agent_runs.model` is nullable while `agent_conversations.model` is `NOT NULL`, so an agent with no model pinned anywhere now **fails outright** once thread-mode is on. Framework half is #473; the app half needs a call.

---

## Notes

**`driving-mode` (plugin 0.2.25).** Doug drives for hours and cannot read the screen. Two rules learned live: **one voice message at a time** (three overlapped and he understood none — the script now holds a playback mutex; do not "simplify" it away), and **announce then wait** before any long report. Key resolution is `OPENAI_API_KEY` → `TTS_KEY_FILE` → `~/.config/claude-tts/key`; a symlink from there to `~/.config/dealbrain-tts/key` was added so the shipped skill finds his existing key instead of silently falling back to the macOS voice.

**`guided-tour` (plugin 0.2.24).** One tour file, two modes: `narrate` drives the real browser over raw CDP (Playwright's `connectOverCDP` **hangs on Arc**; raw CDP is fine), `--verify` asserts and writes `report.json`. Tours live in the consuming project at `.claude/tours/`. Uncommitted tours exist for swe-brain (`ambient-loop.mjs`, with a deliberate red check on the run surface) and agentic-patterns (`playground-inventory.mjs`).

**The dashboard already has the surfaces.** A 12-route inventory tour passed: Dashboard, Agents (6 agents, readiness badges), Roles, Capabilities, Tools, Run (constellation + full trace: setup → iterations → finish, per-step timings, tool calls, tokens), Graph, Live, Conversations, Eval, Tokens, Claude Code. **They are empty, not missing** — nothing had run into them. Two agent roots disagree: `agents/` (calculator, companion, todo, writing-coach — what `ap run` reads) vs `examples/agents/` (what `ap playground examples` reads). The memory-wired `companion` lives in the former.

**Still running / left behind:** swe-brain api :3100, worker, vite :8338; playground backend :3456 + dashboard :5173. `demo-minutely` is **disabled**. Untracked, pre-existing: `docs-site/`, `.ai-docs/patternstack/next-session-prompt.md`, `.ai-docs/research/memory-recall-retrieval-quality.md`.

## Where the program stands

M1 Phase 1 and M2 are done and published. What exists is a **working vertical slice** of ambient — and as of tonight it also *speaks and remembers*: a schedule wakes an agent, it writes a brief into a thread, and a reply hours later reaches the same agent with the brief in context. What it still cannot do is **reach you where you are** (no channel — M4 #439, deliberately deferred) and **run unattended without asking** (the autonomy story: #328 permission bridge, #329 approval components, #443 blast radius, #456 chunk 4 — all specified, all unbuilt). M3 AgencyHost (#438) is unblocked and one of its six checkboxes shipped this session. Memory Phase B (#434) remains the next *framework* arc and now ships as 0.19 / 0.40, not 0.18 / 0.39.

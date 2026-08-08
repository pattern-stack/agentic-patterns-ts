# Ambient Platform — program brief (multi-repo)

> Cold-start context for any session working on the ambient-agent program. Written 2026-08-07
> after the memory Phase 1 stack shipped. Tracker: pattern-stack/agentic-patterns-ts #414 (program)
> / #415 (memory epic). Durable cross-session map also lives in Claude's memory
> (`ambient-platform-program`).

## The goal

Make the pattern-stack ecosystem able to produce **ambient, always-on agent systems** —
OpenClaw / Hermes-Agent class — *anywhere*: a central coordinator agent wrapping domain agents,
running as a persistent daemon, triggered by schedules and external events, with cross-session
memory and messaging-channel ingress. **Platform-first**: capabilities land in the framework and
codegen substrate; apps (swe-brain, dealbrain) are first adopters, never the home. The MVP
competitor is a Slack-first ambient work-brain built by *generating* the product around a domain,
not configuring a monolith.

## Competitive conclusions (Aug 2026 investigation)

- **OpenClaw** (200k★, foundation-run): Gateway daemon + 30+ channel adapters + file-first memory
  (`MEMORY.md`, dreaming) + SQLite automations. Weaknesses we exploit: security disaster (512-vuln
  audit, CVSS 9.9 RCE, ClawHavoc supply chain), no durable substrate, no real multi-agent.
- **Hermes Agent** (Nous, 140k★): Python daemon, 25+ adapters, SQLite FTS5 recall (indexed recall
  beats context-stuffing ~100×), NL-cron, ephemeral `delegate_task` workers, autonomous skill
  creation (its moat). Marketed safe-by-default against OpenClaw.
- **Neither has**: a persistent coordinator-of-domain-agents topology (our `AgencyRuntime`),
  typed composition, gates/HITL, evals, or line-level memory attribution. Our stack approaches the
  same destination from the durable/product side; they approach from the channel/UX side. Their
  structural lead: channel breadth. Ours: everything else, once the ambient pillars close.

## Repo map & roles

| Repo | Role | State |
|---|---|---|
| `pattern-stack/agentic-patterns-ts` | **The platform.** Protocols + reference backends (SQLite), composition core, runtime, server, dashboard | Memory Phase 1 stack #425–#431 awaiting review; core 0.16 / runtime 0.37 |
| `pattern-stack/codegen-patterns` | **Production substrate.** Entity YAML → NestJS+Drizzle+Postgres; subsystems: outbox events, jobs (SKIP LOCKED + drain), bridge, interval scheduler | v0.28.3; future `memory` (pgvector) + `agents` subsystems consume the framework's conformance kits |
| `pattern-stack/sdlc-patterns` (= **swe-brain**, renamed) | **First adopter app.** api/worker daemon split, cron/rrule `schedule`+`directive`, Slack/Google webhook ingress, JWT auth + consent lattice, agents via `buildAgentFromConfig` | Triggers are observe-only (the "ignition wire" gap); pinned to core 0.13/runtime 0.28 — upgrade before M2 |
| `pattern-stack/agent-patterns` | **Retired lab.** Proved job→agent ignition (`run-pm-agent.job.ts`) + declarative agents (RFC-0007 Phase 0/1, upstreamed) | Harvest-only — severe version skew (core 0.1.x, codegen 0.6.x); do not resume |
| `dugshub/stack` (`st`) | Stacked-PR CLI (first-class tool for delivery) | Installed here via `bun link` from `/tmp/st-cli` |

**Tiering principle (agreed, load-bearing):** protocol + reference backend in `@agentic-patterns/*`
· production backend as a codegen-patterns subsystem · policy in the app. Parity enforced by
**exported conformance test kits**, never convention. Framework tier = contract + reference, never
a second production path.

## Decisions of record

- **ADR-0007 — MemoryStore** (merged, PR #416): scoped (flat string map, subset-match),
  invalidation-first store; six-method protocol; SQLite/FTS5 reference; conformance kit = the
  SQLite↔Postgres portability contract; two recall surfaces (budget-capped turn-1 injection +
  toolbox); explicit writes only in v1.
- **ADR-0008 — Compositional memory** (merged, same PR): memories carry typed `target`s into the
  agent anatomy (Background/Judgment/Example/Awareness/recovery) and **compile into the
  composition** via pure `applyMemoryOverlay` at the instantiate seam — not a context appendix.
  Tiered gated promotion (auto/earned/guarded/locked); store-resident evolution ledger
  (promote/demote/corroborate rows; events mirror); rollback = invalidation; **the bar to remove a
  learning equals the bar that added it** — guarded demotion is agent-proposal + human confirmation
  (rides the existing HITL input round-trip); candidates earn promotion via recall pinning +
  `supports` corroboration, N = distinct conversations ("lab-notebook discipline"); reserved
  `agent` scope key with runtime post-filter; conflicts resolve supersede-first, newest-renders
  residual surfaced in a dashboard conflicts panel.
- **Method finding worth reusing:** writing docs *as if the feature shipped* before building
  (docs/memory/guide.md + evolution-cookbook.md) surfaced 33 design questions; the 8 ADR-blocking
  ones were resolved pre-build. Doug loved this loop.

## Current state (2026-08-07)

- **Shipped awaiting review:** 7 stacked PRs #425→#431 (branches `dugshub/memory-store/1..7-*`),
  all CI-green, `Closes #417–#423`, per-issue specs committed on-branch. Built overnight by an
  ultracode workflow (spec→critique→implement→2-lens review→validate per issue, sonnet impl / opus
  review per sdlc.yml phase_models); a mid-run process restart was bridged by a second agent that
  finished #423 and submitted; Gate 2.5 closure reviews for #430/#431 posted as PR comments.
- **Phase 1 delivered:** memory-record molecules (core) · MemoryStore protocol + InMemory +
  conformance kit · SqliteMemoryStore FTS5 + `loadMemoryStore()` · `agent.memory.*` events through
  the four SSE guards + dashboard union · MemoryToolbox (scope-bound, supersede nudge, no delete)
  + `memoryCapability()` · RenderContext.recall + `Awareness.fromRecall` + `assembleRecall`
  (4000-char default, marked truncation, agent-key post-filter) · docs refreshed.

## Roadmap

- **M1 memory** — Phase 1 ✅ (pending merge). Next: **m8 eval issue** (playground memory wiring +
  memory-behavior eval sets — these later become ADR-0008's promotion gates); then **Phase B**
  (MemoryTarget schema, applyMemoryOverlay, promotion rows + store ops, auto tier, `"memory"`
  attribution), **Phase C** (earned/guarded tiers, lintComposition, gardening), **Phase D**
  (codegen pgvector subsystem via the conformance kit; evolution lens UI: conflicts panel +
  pending-review queue — Doug explicitly wants the visual surface).
- **M2 ignition** — swe-brain: upgrade core 0.13→0.16 / runtime 0.28→0.37 first; port the
  agent-patterns job-handler pattern as a directive/schedule action that enqueues agent runs;
  prototype → extract as codegen `agents` subsystem (agent-patterns RFC-0007 Phase 2/3).
- **M3 AgencyHost** — persistent daemon mode in runtime (no idle-timeout nodes, conversation
  rehydration, `runFromTrigger()`).
- **M4 channels** — ChannelAdapter protocol; Slack conformance case graduates codegen-messaging
  from provisional (write path currently ships dark).
- **M5 identity** — generalize swe-brain's auth entities into a reusable subsystem.
- **MVP bar:** swe-brain running the coordinator topology ambiently — schedule/webhook → consent-
  gated agent run → Slack announce, with cross-session memory and the evolution ledger visible in
  the dashboard. Differentiators vs OpenClaw/Hermes: durable substrate, gates + approval UI,
  measurable (eval-gated) self-improvement, line-level memory attribution.

## Session tooling notes

- `st` on PATH via `export PATH="$HOME/.bun/bin:$PATH"`; `st --ai` prints LLM docs; stack state in
  `~/.claude/stacks/` (shared across worktrees). This box's st state predates PR creation — run
  `st stack get` / `st sync` to reconcile.
- LAN docs viewer: http://10.88.111.45:8899 (docsify over this worktree's `docs/`; restart:
  `cd /tmp/apdocs && python3 -m http.server 8899 --bind 0.0.0.0 &`).
- Ultracode workflow script (reusable delivery harness shape):
  `~/.claude/projects/…/workflows/scripts/memory-store-stack-wf_16b239ec-c9b.js`.

---
title: "ADR 0002 — Primitive knowledge in typed slots: camelCase keys, wired Tone/Methodology/Recovery, one prompt contract"
description: "Renames 21 atom keys to camelCase, wires Tone/Methodology/Recovery into Role, and retires getSystemPrompt for a single renderInitialPrompt contract."
sidebar:
  label: "ADR 0002 — Primitive Knowledge Rework"
---

- **Status:** Accepted (2026-07-09) — shipped as the PK stack
  [#216](https://github.com/pattern-stack/agentic-patterns-ts/pull/216) →
  [#217](https://github.com/pattern-stack/agentic-patterns-ts/pull/217) →
  [#218](https://github.com/pattern-stack/agentic-patterns-ts/pull/218)
  (core **0.9.0**, lockstep runtime/server/cli **0.21.0**).
- **Date:** 2026-07-09
- **Context owner:** Doug
- **Scope:** `@pattern-stack/agentic-core` (atoms, molecules, rendering, organisms) +
  the runner contract in `@pattern-stack/agentic-runtime` (`AgentLike`) + every
  consumer that constructs atoms (presets, `ap init` scaffold, skills, READMEs).

## Context

Three defects had accumulated in how the framework captures "primitive
knowledge" — the typed slots an agent is composed from:

1. **Orphaned knowledge atoms.** `Tone`, `Methodology`, and `Recovery` were
   defined, exported, and unit-tested from the start — but referenced by
   nothing. A Role could not carry a reusable voice, a work protocol, or a
   failure policy; that knowledge leaked into fat mission strings, exactly the
   anti-pattern the framework exists to prevent.
2. **Python-legacy key casing.** Atom Zod schemas used snake_case keys
   (`success_criteria`, `escalation_triggers`, `max_turns`, …) in an otherwise
   camelCase TypeScript API — 21 keys across 10 atoms, taught to users by the
   `ap init` scaffold and the skills.
3. **Two prompt paths.** `Agent.getSystemPrompt()` (inline, `## Current
   Mission`, role-name heading) and the `PromptRenderer` section path
   (`renderInitialPrompt()`/`renderSections()`, used by server previews since
   #91) rendered *different text* for the same agent. Which one an agent
   actually received depended on the runner. Worse, `getSystemPrompt` had
   become a structural duck-typing contract (CLI discovery, `asAgent`
   promotion, eval targets) that new code kept accreting onto.

A fix existed: PR #90 (cut 2026-07-02, parked as "HOLD — decide disposition").
By the time the disposition was decided (2026-07-09) the branch was dead: 122
commits behind main, 16-file merge conflicts, its CLI/server halves superseded
by the 0.15–0.18 releases, and — critically — it predated #179, so merging it
would have silently **resurrected the hardcoded default model** (`defaultModel:
z.string().default("claude-sonnet-...")`) that #179 deliberately removed, and
reverted `getModel()` to non-optional.

## Decision

**Close #90 and re-implement its live delta from current main as a three-slice
stack**, using the old branch only as reference material:

1. **#216 — mechanical camelCase** (`feat/pk-1-camelcase`): rename the 21 atom
   schema keys + every consumer, via a purpose-built codemod
   (`scripts/migrate-to-camelcase.ts`) that was **dogfooded** — the slice's own
   sweep is the script's output. Also: `WorkflowStep*` →
   `WorkflowStepDefinition*` (collision avoidance), transport `type` tightened
   to `z.enum(["in_process","nats"])`.
2. **#217 — knowledge wiring + unified rendering**
   (`feat/pk-2-knowledge-wiring`): Role/RoleBuilder/AgentConfig gain the three
   knowledge slots; sections render them; `Persona`/`Mission`/`Example`
   `toPrompt()` become the single formatting sources; `Role.toPrompt()` is
   section-composed so previews and runner prompts match. Legacy methods kept
   as thin delegates for one slice.
3. **#218 — contract retirement + release**
   (`feat/pk-3-retire-legacy-prompt`): delete
   `getSystemPrompt`/`renderSystemPrompt`, drop them from
   `AgentLike`/`AgentLikeForBridge`, migrate all duck-type fingerprints to
   `renderInitialPrompt` (which old-core agents also expose — discovery of
   older projects keeps working), bump core 0.9.0 + lockstep 0.21.0.

### Options considered

- **Merge/rebase #90 directly** — rejected: conflict volume, superseded halves,
  and the two #179/#91 regression traps made hand re-application both safer and
  faster.
- **Deprecated `getSystemPrompt` alias for a release** — rejected: we are
  effectively the sole consumer; the codemod migrates call sites in seconds, so
  the alias would only prolong the two-contract ambiguity.
- **Ship the codemod as an `ap` CLI subcommand** — rejected as overkill for one
  consumer; a repo script (`scripts/migrate-to-camelcase.ts`, dry-run default,
  `--keys`/`--methods`/`--write`) meets the bar.

### Deliberately kept

- `input_schema` in `molecules/tool-schema.ts` — Anthropic Messages API wire
  format, not an atom key.
- The server composition route's dual-casing tolerance
  (`d.accessMethod ?? d.access_method`) — introspection stays agnostic to the
  atom casing of agents built against pre-0.9 cores across the dist boundary.

## Consequences

- **Breaking for atom constructors** (Zod rejects old keys) and for
  `getSystemPrompt()`/`renderSystemPrompt()` callers. Migration is one command:
  `bun scripts/migrate-to-camelcase.ts --keys --methods --write <dir>`.
  Known downstream repos (swe-brain, query-agent-poc, retrieval-agent) pin old
  versions, so breakage is opt-in at upgrade time. The full rename map:

  | old | new | old | new |
  |---|---|---|---|
  | `nats_url` | `natsUrl` | `access_method` | `accessMethod` |
  | `agent_definition_id` | `agentDefinitionId` | `exploration_capabilities` | `explorationCapabilities` |
  | `max_turns` | `maxTurns` | `team_context` | `teamContext` |
  | `is_coordinator` | `isCoordinator` | `project_context` | `projectContext` |
  | `env_vars` | `envVars` | `current_state` | `currentState` |
  | `success_criteria` | `successCriteria` | `resource_profile` | `resourceProfile` |
  | `output_schema` | `outputSchema` | `workspace_id` | `workspaceId` |
  | `strict_output` | `strictOutput` | `inter_agency_transport` | `interAgencyTransport` |
  | `escalation_triggers` | `escalationTriggers` | `accumulated_context` | `accumulatedContext` |
  | `anti_patterns` | `antiPatterns` | `last_action` | `lastAction` |
  | `max_attempts` | `maxAttempts` | *(methods)* `getSystemPrompt`→`renderInitialPrompt` | `renderSystemPrompt`→`toPrompt` |
- **Every agent's rendered prompt changed shape** (intentional): `### Tone /
  ### Priorities / ### Principles` under Identity; `## Mission / ### Objective`
  subsections; `### Recovery` under Boundaries; Methodology block first;
  Example as a nested list; empty Boundaries omitted; the section path now
  includes the mission `outputSchema` injection; runner prompts drop the
  `# <RoleName>` heading (matching what server previews always showed).
  Prompt-sensitive evals/baselines should expect drift.
- Runner prompts (`renderInitialPrompt()`) and the composition endpoint's
  section list are the same text by construction (the endpoint joins
  `renderSections()`); role previews (`role.toPrompt()`) share the same
  section formatters but render only the role half, under a `# <RoleName>`
  heading, without Context/Mission. Verified live against
  `GET /agents/:id/composition` on the key-free playground.
- The `build-on-agentic-patterns` skill (repo + plugin-template copies) now
  teaches the three knowledge slots and the single prompt path.
- Follow-up candidates: `as-agent.ts`'s `DEFAULT_MODEL = "sonnet"` for promoted
  agents still brushes against the #179 no-framework-default philosophy;
  `State`/`Roster` remain unwired (keys renamed only) — wiring them is its own
  decision.

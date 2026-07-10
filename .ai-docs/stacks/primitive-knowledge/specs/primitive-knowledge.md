# Spec of record — primitive-knowledge rework

> Provenance: this is the plan approved in-session on 2026-07-09 (plan file
> `abstract-giggling-pumpkin`), materialized post-implementation as the stack's
> spec of record for Gate 2.5 review. The stack: PR #216 → #217 → #218.
> Decision record: `docs/adr/0002-primitive-knowledge-rework.md` (rides #218).

# Primitive-knowledge rework: rebuild PR #90 from main

## Context

PR #90 (July 2, parked as HOLD) overhauls how primitive knowledge is captured and rendered: it wires the **orphaned Tone/Methodology/Recovery atoms** into Role/rendering/AgentConfig, renames all atom schema keys **snake_case → camelCase**, and retires the legacy prompt methods (`Agent.getSystemPrompt`, `Role.renderSystemPrompt`) in favor of the section-composed rendering system. The branch is unmergeable (122 commits behind, 16 conflicts, CLI/server halves superseded by 0.15–0.18; #91 already landed `renderSections`). We rebuild it from `main` as **three stacked PRs**, each independently green, plus a **lightweight migration script** (user's ask — confirmed feasible: ~80-line bun script, dogfooded on our own repo in slice 1).

**Two traps, verified — never port these lines from the reference branch:**
- `main`'s #179 made models optional (`defaultModel`/`model` `.optional()`, `getModel(): string | undefined`, guarded `withDefaultModel` at `build-agent-from-config.ts:81-82`). Reference code predates it and would resurrect `default("claude-sonnet-4-20250514")`.
- `renderSections`/`AgentPromptSectionData` are already on main (#91); IdentitySection already accepts `tone` and MissionSection already emits the target `## Mission/### Objective` format — slice 2's section work is largely a *delegation refactor*, not new formatting.

Reference diffs: `git diff 5fca4c9..origin/feat/composition-introspection-spine -- <path>`.

---

## Slice 1 — `feat/pk-1-camelcase`: migration script + mechanical rename

**1a. Write `scripts/migrate-to-camelcase.ts`** (bun script, the "upgrade helper"):
- Word-boundary regex rename over `*.ts`, `*.tsx`, `*.mjs`, `*.md` in a target dir.
- Two modes: `--keys` (21 schema keys) and `--methods` (`getSystemPrompt`→`renderInitialPrompt`, `renderSystemPrompt`→`toPrompt`); `--write` to apply (dry-run diff by default).
- Rename map (from verified inventory): `nats_url→natsUrl`, `agent_definition_id→agentDefinitionId`, `max_turns→maxTurns`, `is_coordinator→isCoordinator`, `env_vars→envVars`, `success_criteria→successCriteria`, `output_schema→outputSchema`, `strict_output→strictOutput`, `escalation_triggers→escalationTriggers`, `anti_patterns→antiPatterns`, `access_method→accessMethod`, `exploration_capabilities→explorationCapabilities`, `team_context→teamContext`, `project_context→projectContext`, `current_state→currentState`, `resource_profile→resourceProfile`, `workspace_id→workspaceId`, `inter_agency_transport→interAgencyTransport`, `accumulated_context→accumulatedContext`, `last_action→lastAction`, `max_attempts→maxAttempts`.
- **Never rename** `input_schema` (`molecules/tool-schema.ts:26,142` — Anthropic wire format).

**1b. Run it with `--keys --write` on our repo** (dogfood), then hand-fix what regex can't do:
- Atom schemas + internal `.data.` readers + `with*()` mutators: `atoms/{agency,mission,judgment,tone,awareness,background,roster,state,recovery}.ts` (state.ts also gets the PR's `replace({...})` one-liner refactor of `withPhase/withIteration/withAction`).
- Consumers: `runtime/src/presets/agents/{calculator,todo-manager,writing-coach}.ts`, `presets/judgments.ts`, `runtime/src/runtime/agency-runtime.ts:270`, `cli/src/commands/init.ts:447` (scaffold template), `runtime/scripts/smoke-*.ts`, `scripts/runner-side-by-side.mjs:152`, ~25 test files.
- Docs: root `README.md:90,109`, `skills/build-on-agentic-patterns/SKILL.md:121` + plugin-template mirror (`cli/assets/plugin-template/skills/.../SKILL.md:121`).
- **Exclude** `docs/runners.md:146` (`max_turns` there is a runner finish-reason, false positive).
- **Do NOT touch** `server/routes/composition.ts:397` `?? d.access_method` fallback — deliberate cross-version tolerance; revisit in slice 3.

**1c. Also in this slice** (mechanical, from the PR):
- `molecules/definitions.ts` + `molecules/index.ts`: `WorkflowStepSchema→WorkflowStepDefinitionSchema`, `WorkflowStep→WorkflowStepDefinition` (zero external importers, verified). Targeted edit on index.ts — main added ToolEvent exports there.
- `atoms/agency.ts`: `TransportConfigSchema.type` → `z.enum(["in_process", "nats"])` (only those two values exist anywhere).

## Slice 2 — `feat/pk-2-knowledge-wiring`: wire tone/methodology/recovery + unify rendering

Port from reference (camelCase applies cleanly now), **keeping** `getSystemPrompt`/`renderSystemPrompt` as thin delegates so the contract survives until slice 3:

- `organisms/role.ts`: RoleSchema gains `tone/methodology/recovery` (`.nullable().default(null)`), readonly props, constructor pass-through (`data.x?.data ?? null`); `RoleBuilder.withTone/withMethodology/withRecovery`; `toPrompt()` becomes section-composed (`# ${name}` + Identity/Boundaries/Capabilities/Methodology, filter-empty, join `\n\n`); `renderSystemPrompt()` body becomes `return this.toPrompt()`. Keep main's optional-model lines untouched.
- `organisms/agent.ts`: `_buildRenderer()` passes `this.role.tone/recovery/methodology` into the sections; `getSystemPrompt()` body becomes `return this.renderInitialPrompt()`; `toPrompt()` delegates to `renderInitialPrompt()`.
- `atoms/persona.ts`: `toPrompt(opts?: {tone?: Tone})` with `### Tone/### Priorities/### Principles`; new `withPriorities()/withPrinciples()`.
- `atoms/mission.ts`: `toPrompt()` reformat to `## Mission/### Objective/### Success Criteria/### Constraints/### Rationale` (+ outputSchema injection kept).
- `atoms/example.ts`: unified list-style `toPrompt()` format (literal ✓/✗).
- `rendering/sections/identity.ts`: `render()` delegates to `persona.toPrompt({tone})`. `boundaries.ts`: gains `recovery?` param, renders `### Recovery`, returns `""` when fully empty (no bare heading). `methodology.ts`: gains `methodology?` param rendered first, examples delegate to `Example.toPrompt()`, renders even with zero judgments when methodology present. `mission.ts`: gutted to `return this.mission.toPrompt()` — **behavior delta**: continuation/initial prompts now include the outputSchema injection the section previously omitted; call out in PR body.
- `atoms/agent-config.ts`: `RoleTemplateConfigSchema` gains the three nullable slots; `AgentConfig.toPrompt()` injects them after persona. Keep main's optional model.
- `organisms/build-agent-from-config.ts`: wire `rt.tone/methodology/recovery` into RoleBuilder (three `if` lines before `.build()`). Keep the #179 guard.
- `molecules/playbook.ts`: `PlayDefinition.returns?: ZodTypeAny` passed as 4th arg to `ToolSchema.fromZod` (already supported, `tool-schema.ts:78-84`).

**Tests**: regenerate the 4 snapshots (`organisms/__tests__/__snapshots__/{role,agent}.test.ts.snap`, `rendering/__tests__/__snapshots__/{renderer,sections}.test.ts.snap`); update format assertions in `atoms/__tests__/atoms.test.ts:139` ("## Current Mission"), `organisms/__tests__/agent.test.ts`, `role.test.ts`, `rendering/__tests__/sections.test.ts:134-142`; port the PR's new wiring tests (role/agent/sections/build-agent-from-config). **Add a full-Role `asAgent` promoted-prompt test** in `runtime/src/workflows/__tests__/as-agent.test.ts` — coverage gap: only the minimal-role path is asserted today, and promoted prompts change format via delegation.

## Slice 3 — `feat/pk-3-retire-legacy-prompt`: contract removal + release

Hard removal, no deprecated alias (sole consumer, deliberate migration via script):

- Delete `Agent.getSystemPrompt()` and `Role.renderSystemPrompt()`; update `agent-core/README.md:193,198`, root README, `docs/playground-redesign.md:217`.
- Drop `getSystemPrompt(): string` from `runner/types.ts` `AgentLike` and `sdk-bridge.ts` `AgentLikeForBridge`.
- Migrate call/duck-type sites: `runner/claude-code-runner.ts:498` → `renderInitialPrompt()`; `workflows/base.ts:175` shim; `workflows/as-agent.ts` (typeof checks L38/L155, call L118, synthetic alias L125) → `renderInitialPrompt`/`toPrompt`; `eval/target.ts:50`; `eval/scorers/judge.ts:317`; `cli/helpers/discover.ts:122-133` fingerprint → `renderInitialPrompt`-only (stays backward-compatible with old-core agents); `runner/message-utils.ts:86` comment.
- Test sweep: ~32 files with `AgentLike`-annotated literals fail typecheck loudly (excess-property) — drop the stub member / rename per file; run the script's `--methods --write` mode on `packages/` to do the bulk, hand-fix residue. `tsc` enumerates every site.
- Optionally simplify `composition.ts:397` dual-casing fallback here (breaking release is the right moment) — or keep it as tolerance; either is fine.
- **Release**: `just bump-both` → core 0.8.0→**0.9.0**, lockstep 0.20.0→**0.21.0** (bump.sh refreshes the lockfile). CHANGELOG entries with a BREAKING note + the key-rename table + pointer to `scripts/migrate-to-camelcase.ts`. No dashboard bump.
- Close PR #90 with a comment linking the new stack.

## Migrating your other projects (post-release)

Run `bun scripts/migrate-to-camelcase.ts --keys --methods --write <dir>` against consumers when they upgrade (swe-brain, query-agent-poc, retrieval-agent construct old keys; all pin old versions so no urgency). Configs are TS modules only — no YAML/JSON path exists, so the script is the whole story.

## Verification

- Each slice: `bun run check` (build + typecheck + lint + test) green at repo root before opening its PR.
- Slice 1: migration script dry-run output reviewed before `--write`; `git diff` eyeballed for false positives.
- Slice 2: snapshot diffs reviewed by hand — the *only* intended prompt deltas are: `### Tone/### Priorities/### Principles` structure, `## Mission` subsections, `### Recovery`/methodology blocks, Example list format, empty-Boundaries omission, outputSchema injection in section path.
- Slice 3: `bun run typecheck` is the sweep-completeness proof (zero residual references); `grep -rn "getSystemPrompt\|renderSystemPrompt" packages/*/src` returns nothing.
- End-to-end: `ap playground examples` (key-free deterministic pipeline) + dashboard spot-check that role previews/run replay render the new prompt shape.

## Decisions made (flagging, per usual)

- **Renames first** — the reference diffs are camelCase; they apply cleanly only after slice 1.
- **Hard removal over deprecated alias** — you're effectively the sole consumer; the script covers the rename in seconds.
- **Migration helper = repo script, not an `ap` subcommand** — meets your "lightweight mechanical" bar; an CLI-shipped codemod would need its own tests/packaging for one user.
- **State/Roster/Example**: keys renamed in the sweep, but NOT newly wired anywhere — wiring them is a separate feature, out of scope.
- **`as-agent.ts:88` `DEFAULT_MODEL = "sonnet"`** for promoted agents brushes against the #179 philosophy — deliberately untouched here; candidate follow-up issue.

## Diff Review — Adherence
<!-- written by: reviewer · gate 2.5 · /sdlc:critique · lens=adherence -->

**Target:** `git diff main...feat/pk-3-retire-legacy-prompt` (5 commits: `074af6e` camelCase · `9cbe318` knowledge wiring · `1954873` contract retirement + bump · `a9850b0` docs/ADR) @ `a9850b0`
**Against:** `.ai-docs/stacks/primitive-knowledge/specs/primitive-knowledge.md` (approved plan, materialized as spec of record)
**Verdict:** PASS_WITH_NOTES

The stack faithfully executes all four slices. Every enumerated plan item landed; both explicitly-flagged traps were honored; the three implementer-flagged deviations are acceptable. Verified live: `bun run typecheck` green across all 5 packages (the plan's slice-3 sweep-completeness proof), core suite 347/347 green.

**Trap verification (both honored):**
- No resurrected default model. `getModel(): string \| undefined` survives (`agent.ts:91`); `defaultModel: z.string().optional()` and the `#179` guard (`build-agent-from-config.ts` `if (rt.defaultModel !== undefined)`) are context-only (untouched). No `default("claude-sonnet-…")` anywhere in `packages/*/src` — the only `claude-sonnet-4-20250514` hits are explicit test fixtures/comments.
- `input_schema` (`molecules/tool-schema.ts:26,142`) and the `d.accessMethod ?? d.access_method` tolerance (`agent-server/src/routes/composition.ts:397`, with the `access_method?` field at :115) are byte-for-byte untouched — the diff touches neither file's fallback.

**Slice-by-slice adherence (all faithful):**
- **Slice 1** — `scripts/migrate-to-camelcase.ts` present with `--keys`/`--methods`/`--write`, the 21-key map matching the plan's list exactly, `input_schema` excluded, and self-exclusion. Atom renames + `definitions.ts` (`WorkflowStep→WorkflowStepDefinition`), `agency.ts` (`type: z.enum(["in_process","nats"])`), `state.ts` (`replace({...})` refactor of `withPhase/withIteration/withAction`) all correct. `docs/runners.md:146` `max_turns` correctly left snake_case (finish-reason false positive).
- **Slice 2** — `role.ts`/`agent.ts`/`agent-config.ts`/`build-agent-from-config.ts`/`persona.ts`/`mission.ts`/`example.ts` + all four sections match the plan; optional-model lines preserved; `playbook.ts` `returns?` passed as 4th `fromZod` arg; the promised full-Role `asAgent` promoted-prompt test was added (`as-agent.test.ts`).
- **Slice 3** — `getSystemPrompt`/`renderSystemPrompt` deleted; `AgentLike`/`AgentLikeForBridge` cleaned; every named call site migrated (`claude-code-runner:495`, `base.ts`, `as-agent.ts` typeof/call/alias, `eval/target.ts`, `eval/scorers/judge.ts`, `discover.ts` fingerprint → `renderInitialPrompt`-only, `message-utils.ts` comment). Version bumps exact: core `0.8.0→0.9.0`, lockstep `0.20.0→0.21.0`, dashboard unbumped. `as-agent.ts` `DEFAULT_MODEL = "sonnet"` deliberately untouched per the plan's decision log.
- **Slice 4** — ADR 0002 present and substantive; `SKILL.md` (both root + plugin-template mirror) teach `withTone/withMethodology/withRecovery` and the single `renderInitialPrompt()` path.

**Flagged deviations — all judged acceptable:** CHANGELOG omission (convention dead at 0.6.2; BREAKING record lives in the slice-3 commit trailer + ADR 0002 + PR bodies); PR #90 closed-before-merge (immaterial ordering); slice-2 alias tests deleted in slice-3 (consistent with the staged keep-then-remove design).

**Blockers (0):**
- _None._

**Notes (2):**
- [`docs/adr/0002-primitive-knowledge-rework.md`] The plan promised a "key-rename table" in the release notes (§ Slice 3). With CHANGELOG retired, the ADR is the natural durable home, but it only says "21 keys across 10 atoms" and points to the script rather than rendering the mapping. Migrators upgrading sibling projects (swe-brain, query-agent-poc) must open `scripts/migrate-to-camelcase.ts` to see the map. Non-gating; consider inlining the table into the ADR.
- [`.ai-docs/stacks/primitive-knowledge/specs/primitive-knowledge.md:78`] The plan's slice-3 verification states `grep -rn "getSystemPrompt\|renderSystemPrompt" packages/*/src` returns nothing, but 3 backward-compat fixtures under `agent-cli/.../discover` `__fixtures__` legitimately retain `getSystemPrompt` (they simulate old-core agents the fingerprint must still tolerate). The production sweep IS complete; only the verification command as written would surface fixture hits. Precision note.

**Nits (2):**
- [`packages/agent-core/src/organisms/__tests__/__snapshots__/`] The plan predicted 4 snapshot regenerations (role/agent/renderer/sections); only `role.test.ts.snap` actually changed, because the section-path `## Mission / ### Objective` format predated this stack (#91) — wiring the atom to match produced no section-snapshot churn. Harmless over-estimate; tests green, no stale `## Current Mission` remains.
- [`packages/agent-runtime/src/workflows/as-agent.ts:90`] Minor line drift between plan citations and final code (plan says `DEFAULT_MODEL` :88 → actual :90; `claude-code-runner` :498 → :495). Expected from staged edits; zero behavioral impact.

**Reviewed by:** reviewer agent · 2026-07-09T21:00:00Z

## Diff Review — Quality
<!-- written by: reviewer · gate 2.5 · /sdlc:critique · lens=quality -->

**Target:** `git diff main...feat/pk-3-retire-legacy-prompt` (a9850b0; 5 commits: 074af6e, 9cbe318, 1954873, a9850b0)
**Against:** quality-checks/categories.yaml (strict profile) + repo conventions (CLAUDE.md)
**Verdict:** PASS_WITH_NOTES

This is a well-built rework. Verified mechanically: the 21-key snake→camel rename is
complete in source (no residual snake_case atom keys outside the migration script and the
one documented `access_method` compat shim); no dangling `getSystemPrompt`/`renderSystemPrompt`
references survive outside the codemod and two vestigial fixtures; `renderInitialPrompt` is
defined and consistently threaded through every duck-type fingerprint; `ToolSchema.fromZod`'s
`returnsSchema?` param matches the new `PlayDefinition.returns` call; `State.replace()`
simplification is correct and immutability-safe; the new section behaviors (empty Boundaries
omitted, `### Recovery`, Methodology-first) have direct unit coverage; the ADR is accurate on
the deliberately-kept items. No `convention_workaround`, `convenient_fallback`, or repeated
`magic_constants` in scope — the composition `?? d.access_method` is a documented
cross-dist-boundary shim (canvas counter-example), not a fallback.

**Blockers (0):**
- None.

**Notes (2):**
- [`packages/agent-core/src/atoms/agent-config.ts:99-108`] `AgentConfig.toPrompt()` is a
  fourth, unreconciled render path that undercuts the rework's "single formatting source"
  goal: it emits Tone/Methodology/Recovery as bare `atom.toPrompt()` blocks (no `### Tone` /
  `## Methodology` / `### Recovery` headings, unlike the section system), and calls
  `new Persona(rt.persona).toPrompt()` *without* `{ tone }`. Because `PersonaSchema.tone` is a
  required string, a config carrying both a non-empty `persona.tone` and an `rt.tone` slot
  renders tone **twice** — once inline under the persona's `### Tone`, once as the separate
  Tone block. Preview-only (no non-test runtime call sites for `AgentConfig.toPrompt`), so not
  gate-blocking, but it is exactly the divergence the rework set out to kill. _Suggested:_ pass
  `{ tone: rt.tone ? new Tone(rt.tone) : undefined }` into the persona render and drop the
  standalone Tone block, or route the preview through the shared sections.
- [`docs/adr/0002-primitive-knowledge-rework.md:102-105`] Docs accuracy: "Role previews
  (`role.toPrompt()`), runner prompts (`renderInitialPrompt()`), and the composition endpoint's
  section list are now the same text by construction" overstates and internally contradicts the
  bullet two lines above. `role.toPrompt()` keeps the `# <RoleName>` heading and composes only
  4 sections (Identity/Boundaries/Capabilities/Methodology); `renderInitialPrompt()` drops the
  heading and adds Context+Mission (6 sections). They share the section *formatters*, not
  identical *text*. _Suggested:_ scope the "same text" claim to `renderInitialPrompt()` ≡ the
  composition section list, and describe `role.toPrompt()` as sharing the formatting system.

**Nits (2):**
- [`packages/agent-cli/src/helpers/__tests__/__fixtures__/agents/promoted/agent.mjs:7`,
  `promoted-wrapped/agent.mjs:6`] Now-dead `getSystemPrompt` keys survive in the two promoted
  fixtures after the method was dropped from every fingerprint; `near-miss/agent.mjs:2`'s
  comment still lists `getSystemPrompt` as part of the `isAgentLikeShape` fingerprint (no
  longer checked). Harmless leftovers; the retirement is otherwise clean.
- [`packages/agent-core/src/atoms/persona.ts:33`] `Persona.toPrompt(opts?: { tone?: Tone })` is
  the only atom whose `toPrompt` takes an argument, a small break from the uniform
  `abstract toPrompt(): string` contract. Pragmatic and typechecks; taste-level.

**Reviewed by:** reviewer agent · 2026-07-09T21:30:00Z

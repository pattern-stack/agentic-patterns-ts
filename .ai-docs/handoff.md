# Handoff — 2026-07-26

**Branch:** `docs/handoff-2026-07-26` (this file only). Work branches: `fix/cjs-import-meta-url-shim` (**merged**, #374), `refactor/adopt-definetool` (**open**, #382).

**Last action:** Session started as one question — "do we support decorator-based tool definition?" — and turned into two shipped fixes plus a design investigation. Answer to the original question: **no, and `@tool()` would be a downgrade** — TS decorators cannot contextually type the signature they decorate, so `@tool({parameters})` on `async greet(args)` leaves `args` implicitly `any` under strict mode. `defineTool` gives inference that a decorator structurally cannot.

---

## Shipped and merged

**#374 — publish pipeline unbroken.** `providers/cc-shim.ts:49` called `createRequire(import.meta.url)`; esbuild emitted `var import_meta = {}` for the cjs bundle, so the published artifact threw `ERR_INVALID_ARG_VALUE` on first `require()`. Fix: `shims: true` in `packages/agent-runtime/tsup.config.ts`.

This had blocked **every** publish since ~2026-07-23 (#361, #366, #369, #371, #372, #373 all red on the publish job). `check` stayed green the whole time because branch protection only requires `check`, and **nothing in `check` ever loaded the build output** — the only thing that imported a built artifact was the tarball smoke, which runs in the *publish* job, after merge.

Same PR closed that hole: `tools/check-dist-contract.ts` loads every built entry in both formats (~2s, no pack/install/network) and now gates every PR; `check:model-facing-schemas` was also wired into ci.yml, where it had been missing entirely despite being in the root `check` script — the #265 linter was unenforced on PRs.

**Verified in production:** npm went `0.28.1 → 0.29.3`; merges #375 and #376 published green. Clean before/after boundary at #374.

**Correction worth keeping:** a relayed claim said "there's no release workflow and `just publish` needs interactive OTP, so an automation-token release workflow is a prerequisite." That was **false**. `.github/workflows/ci.yml:51` is a publish job on push to `main` using **npm trusted publishing (OIDC)** — `ci.yml:49-50` says "no NPM_TOKEN secret". An automation token would be a *downgrade*. The OTP path is only the manual local one. **Do not build release infrastructure; it exists and is better than what was proposed.**

---

## Open — needs review

**#382 — `defineTool` adoption sweep.** CI green. All 7 producer sites migrated (`examples/agents/{toolsmith,support-desk,workspace}`, `examples/live-demo.ts`, `presets/{calculator,todo-manager}`, `agent-cli/src/commands/init.ts`). Every `args as { … }` in a tool body gone; every tool declares `returns`, so outputs are validated not just described. Adds `requireScopeAs<T>` to runtime (the missing fail-loud+typed corner of `scope-host.ts`'s claimed trio) plus 3 tests.

Two deliberate non-uniformities, both load-bearing:
- `CalculatorToolbox`/`TodoToolbox` **stay classes** — exported from the runtime barrel and present in the published `.d.ts`, so a `toolbox()` literal would be a breaking change. They adopt `defineTool` internally.
- `workspace`'s ambient toolbox became a **factory function** taking `scope`, proving the literal handles constructor-injected state (the closure is the constructor). That was the one case where the class looked structurally necessary.

**Open review question on #382 — the diff is net +43 and it was pitched as a cleanup.** Honest breakdown of the sweep's +300/−257: `returns:` schemas +27 (unavoidable — `defineTool` requires `returns`), `.describe()` prose +38 (**discretionary, added unprompted**), comments +32 (discretionary); removed 22 hand-casts and 26 lines of class boilerplate. **Without the describes and comments it would have been roughly −27, a real reduction.** The `.describe()` calls do buy something (they feed `ToolSchema.returns`, which the dashboard tool-workbench renders and the model sees), but they were an unflagged bundled improvement, not the stated goal. Decide before merge: keep, or strip them to make #382 a pure refactor and file schema enrichment separately.

---

## Next-action queue

### 1. Resolve #382 (above) — keep or strip the describes, then merge.

### 2. #266 playbook parity — investigated, not yet specced
Full findings in-session; the load-bearing ones:

- **The producer side is vestigial.** 7 `extends Playbook` in the repo: 1 docs snippet, 5 test fixtures, and `ToolsmithPlaybook` — whose own comment says it exists so the dashboard's Playbook section has something to render. **Zero shipped agents or presets define a playbook.** Consumer plumbing (runtime dispatch, SDK bridge, server payloads, dashboard) is real and complete. So the change has near-zero blast radius *and* near-zero real-world validation.
- **The crux.** A mechanically-copied `definePlay` throws from inside `play.execute` at `playbook.ts:92`, which is *inside* the try — so `:94` catches it, `:95` reduces it to `err.message`, and it returns `{ error: … }`. The violation becomes indistinguishable from a business failure, an unknown play, and a param-validation failure (all four collapse to one untagged string), and the `ZodError` cause is destroyed. `Toolbox.execute:253` preserves it.
- **Recommendation: Option B — envelope-preserving but discriminated.** Tag with the same `Symbol.for("agentic-patterns.core.returns-violation")`, add an `isReturnsViolation` branch in `Playbook.execute` *before* the generic catch, emit `{ error: "play '<name>' output violated its returns schema: …" }`. Needs the symbol + guard hoisted out of `toolbox.ts` (both module-private today) into a shared module — **do not duplicate the `Symbol.for` string**.
- **Ruled out: throwing.** `toolbox-executor.ts:16-19` says routing plays through `playbook.execute` is the entire point (stops a bad play aborting the runner loop); `toolbox-executor.test.ts:120-124` pins it.
- **Two traps for the spec.** (a) Serialization order is a real fork: `playbook.ts:93` does a `JSON.parse(JSON.stringify(…))` round-trip *after* execute, so parse-then-serialize means "validated" ≠ "what the host receives matches `returns`" (a `z.date()` validates, then becomes a string). (b) `playbook.test.ts:18-23` declares an object `returns` for a play returning a plain **string** — proving `returns` is metadata-only today, so any `Playbook`-level validation of plain `PlayDefinition`s breaks that fixture.
- **Incidental:** `toolbox-executor.ts:17` cites "ADR 0002 D3" for the never-throw rule, but ADR 0002 contains **no mention of playbooks or plays**. The rule is documented only in that header comment. Worth fixing regardless.

### 3. Lint rule contribution — 5th killer construct for #265
**Relayed from another agent; evidence is in the other repo, unverified here.** #265 catches four constructs; the fifth is a **two-level `z.union`** (4-branch `anyOf` whose arms hold arrays of another 4-branch `anyOf`). Compiles, typechecks, and makes **Gemini return zero tokens with no error**. Reported at 6/186 case-runs, deterministic at temperature 0, survived a retry designed to catch degenerate decisions; before/after measurement exists. File against #265's line — get the measurement from the originating agent to attach.

### 4. ParallelAgent / fan-out chain
**Relayed, cross-repo, unverified here.** Stated order: `tune organs (other repo) → ParallelAgent parity in agentic-patterns-ts → retrieval as a closed workflow (cutover design step 5) → coordinator shells out, N lanes`. Its stated prerequisite (release automation) **does not exist as a blocker** — see the #374 correction above.

### 5. Carried over, still open
- Consumer migrations — canvas-workstation (declare a `SessionScope`, kill the `ORG_ID` env pin), then dealbrain `dugshub/workspace-agent-v0`. Both pressure-test whether an async `resolveScope` hook gets promoted from ADR-0005's deferral.
- **#234** — duplicate `Transfer-Encoding: chunked` on SSE under bun; root cause already on the issue.
- **#281** — menu polish sweep.
- **#285** — justfile recipes call `pnpm` in a bun-only workspace.

---

## Obstacles / notes

- **Tests in this container:** 2 `claude-code-runner.test.ts` integration tests fail locally with `--dangerously-skip-permissions cannot be used with root/sudo privileges`. Environmental — we run as root. CI runs `SKIP_SDK_TESTS=true`; use that locally too and the suite is green (2697 tests).
- **Fresh worktrees need `bun install`** before any build (`tsup: command not found` otherwise), and `git fetch` before trusting local `main` — this worktree was 11 commits stale at session start.
- Port 5173 is held by the user's `~/Projects/dealbrain-sdc-fix` Vite; demos run on **5174** (`cd packages/agent-dashboard && bun x vite --port 5174 --strictPort`, backend `… playground examples/agents --port 3456 --no-dashboard`).
- Keyless-chat limitation unchanged; `scope-echo` (`examples/agents/`) sidesteps it via a FunctionStep echo, zero tokens — the e2e regression probe.
- Untracked leftovers, deliberate: `.ai-docs/design/playground-menus/iterations/` (regenerable) and `.ai-docs/unruliness-audit.md` (provenance unknown, overlaps #285 — skim before deleting).
- Still untracked: `_renderCtx` duplicated in `AgentRunner` + `ClaudeCodeRunner`; DX doc comment on `SessionScope` defaults; scope-form nits.

## Provenance

- **Verified in-repo this session:** everything on #374 and #382, the #266 investigation, version/npm/CI state, the decorator analysis.
- **Relayed, NOT verified here:** the `z.union` lint finding (item 3) and the ParallelAgent chain (item 4). A third relayed claim — "no release workflow, `just publish` needs OTP" — was checked and is **false**; see above.

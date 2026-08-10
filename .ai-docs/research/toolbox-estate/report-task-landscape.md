# Task / PM tooling across `pattern-stack` + `dugshub`

**Question:** what task-management tools already exist that a general-purpose assistant agent (built on `pattern-stack/agentic-patterns-ts`) could use, and is there an existing "gh task management" implementation that could be extended to a local version?

**Status: sweep complete, not blocked.** All `gh repo list` / `gh search code` / clones succeeded.

**Bottom line up front:** yes, a gh-backed task manager already exists — two of them, at different layers. The one worth extending is `pattern-stack/agent-patterns`, which already terminates in an `@agentic-patterns/core` `Toolbox`. The "local version" is a ~150-LOC adapter behind an existing 6-method port.

---

## 1. Repo landscape

| Repo | Vis | Last push | What it is | Task-mgmt relevance |
|---|---|---|---|---|
| **`pattern-stack/agent-patterns`** ("dugs-agents") | private | 2026-06-13 | TS/Bun hexagonal dogfood monorepo on `@agentic-patterns/*` | ★★★★★ **Complete PM stack: domain → ports → GitHub + Linear adapters → surface → `TaskManagementToolbox extends Toolbox`** |
| **`pattern-stack/agentic-patterns`** (Python original) | private | 2026-07-07 | Python predecessor of agentic-patterns-ts | ★★★★ `extensions/task_management/` — 851-LOC `TaskManagementToolbox`, 226-LOC slim `AgentTaskToolbox`, 4 manuals (~1790 LOC prose), 3 playbooks, + `extensions/linear/` adapter |
| **`pattern-stack/claudecode-patterns`** (the `sdlc` plugin) | public | 2026-07-27 | Claude Code plugin | ★★★★ **This is the "gh task management" Doug remembers** — `plugin/primitives/task-management/` port README + `github.md` + `linear.md` + `bootstrap.sh` + `discover.sh`. Prose port, not code |
| **`pattern-stack/task-patterns`** (`tp` CLI) | public | 2026-04-27 | npm `@pattern-stack/task-patterns@0.1.2`, 14k LOC TS | ★★★ Linear-only CLI + `IssueAPI` facade (32 methods). Stale (single commit Apr 2026), Jest/eslint/CJS-era |
| `pattern-stack/agentic-patterns-ts` (**the framework repo**) | public | current | The framework | ★★★ `TaskProtocol` (15 methods) exists in `packages/agent-core/src/protocols/task.ts` — **interface only, zero implementations**. `TodoToolbox` preset = in-memory demo |
| `pattern-stack/sdlc-patterns` (= *swe-brain*) | private | 2026-07-23 | codegen+NestJS app ("alignment brain for our SDLC") | ★ Consumes task systems as *integration sources*; no reusable task toolbox. Scaffold-stage (W0) |
| `dugshub/linear-mcp` | private | 2025-08-27 | Linear MCP server (TS) + `LINEAR_MCP_EVALUATION.md` | ★★ MCP-shaped, superseded by the official Linear MCP already in the plugin set |
| `dugshub/todo` | public | 2026-03-24 | Demo repo for the `st` CLI | ✗ not a task tool |
| `pattern-stack/stack-bench`, `dugshub/stack` | public | — | Stacked-PR tooling | ✗ PR-flow, not task-mgmt |

**Skipped** (checked by name/description, no clone): `cli-patterns`, `tui-patterns`, `chat-patterns`, `context-caddy`, `dbtagent-patterns`, `claude-standards`, `dugshub/agent-patterns` (private duplicate/earlier fork of the pattern-stack one), all analytics/finance/geo repos.

**Clones:** `/Users/dug/.claude/jobs/94af14d6/tmp/` — cloned 2 (`task-patterns`, `sdlc-patterns`); reused 2 already present from a sibling teammate (`agent-patterns`, `agentic-patterns-py`).

---

## 2. Per-candidate detail

### A. `pattern-stack/agent-patterns` — the real answer ⭐

Hexagonal TS/Bun monorepo, `bun` workspaces, zod, **no runtime deps beyond `fetch`**.

| Package | LOC | Contents |
|---|---|---|
| `packages/domain/pm/src/task.ts` | 176 (w/ project.ts, base.ts) | Frozen `Task` entity, `TaskStatus = open\|in_progress\|done\|canceled`, zod `.strict()` + `superRefine` invariants (`completedAt` required iff done), `idempotencyKey {vendor, externalId, tenantId}` → `synthesizeId()` |
| `packages/ports/task/src/port.ts` | 63 | `TaskPort`: `create · get · list · update · delete · listSince` — 6 methods. Vendor-prefixed IDs enforced by regex (`/^[a-z]+:/`) |
| `packages/ports/project/` | 55 | `ProjectPort`, same shape |
| `packages/adapters/github/` | 587 | **`GitHubTaskAdapter implements TaskPort`** + `project-adapter.ts` (Projects v2) + `queries.ts` (GraphQL) + `mappers.ts` (`github:<nodeId>` prefixing, `OPEN/CLOSED+stateReason → TaskStatus`) |
| `packages/adapters/linear/` | 692 | `LinearTaskAdapter`, same port |
| `packages/clients/github/src/client.ts` | 90 | `GitHubGraphQLClient implements Client` — typed 429/403/404/5xx → `RateLimited`/`Forbidden`/`NotFound`/`Unavailable` |
| `packages/surfaces/pm/src/surface.ts` | 35 | `TaskManagementSurface extends Surface` — composes `{task, project}` ports + `capabilities()` |
| **`packages/expositions/pm-toolbox/src/toolbox.ts`** | **152** | **`export class TaskManagementToolbox extends Toolbox` from `@agentic-patterns/core`** |
| `upstream/integration-framework/` | 306 | Vendored: `Port`/`Adapter`/`Surface`/`Client`, error taxonomy, `vendorPrefix`/`stripVendorPrefix`/`buildIdempotencyKey`, `Retrying`/`Traced`/`RateLimited` wrappers |

**The 10 agent-facing tools already written** (`pm-toolbox/src/toolbox.ts`, zod params with `.describe()` on every field, `include`/`exclude` filtering in the constructor):

`task.create · task.get · task.list · task.update · task.delete · project.create · project.get · project.list · project.update · project.delete`

**Creds:** `scripts/smoke-github.ts:16` — `execSync('gh auth token')` → `new GitHubGraphQLClient({ token })`. No new secret; rides the existing `gh` login. Linear path needs `LINEAR_API_KEY`.

**Documented D6 gaps in the GitHub adapter** (`packages/adapters/github/src/task-adapter.ts:1-16`, written honestly at the top of the file):

1. Issues can't be deleted → `delete()` closes with `NOT_PLANNED`
2. No idempotency-key mechanism
3. No `in_progress` state → that filter returns `[]`
4. `projectId`/`parentId` filters are client-side
5. Multi-assignee/multi-project → takes first of each
6. **`update()` only forwards title/description — status/assignee/labels throw `Unsupported`**
7. `listSince()` throws `Unsupported` on page saturation rather than silently truncating

**Staleness/risk:** pins `@agentic-patterns/core: ^0.1.12` (current core is **0.17.0**). Last commit `68cf700` 2026-05-30. `apps/agents/` contains only a `package.json` — **the toolbox was never wired to an actual agent.**

### B. `claudecode-patterns` `primitives/task-management/` — the *other* "gh task management"

At `~/.claude/plugins/marketplaces/claudecode-patterns/plugin/primitives/task-management/`:

- `README.md` (150 lines) — the **port**: 9 adapter-neutral ops (`read-issue`, `list-issues`, `create-issue`, `update-issue`, `add-comment`, `set-blocking`, `find-by-marker`, `add-sub-issue`, `set-type`), the `state:*`/`gate:*` label API, project/epic/task hierarchy, idempotence marker `[plan-key:<slug>/<key>]`, branch/PR/commit conventions
- `github.md` (200 lines) — one-to-one binding to `gh` CLI, org-vs-user owner detection (Issue Types vs `type:*` labels), Projects v2 field discovery, 9-option Status taxonomy
- `linear.md` — the Linear binding
- `bootstrap.sh` (90) — idempotent label provisioning, github-only
- `discover.sh` (131) — SessionStart hook → `.claude/.session/tracker-context.md`

**This is prose consumed by Claude Code agent prompts, not callable code.** Selected by `task_management: github` in `.claude/sdlc.yml` (line 1 of the agentic-patterns-ts config). Its README even documents "Adding a new adapter" — so a "local version" here = write a third `local.md` (~1h). But it's only usable by Claude Code agents, **not** by an agentic-patterns agent. Right for the SDLC loop; wrong layer for the assistant.

### C. `agentic-patterns` (Python) `extensions/task_management/`

`toolbox.py` (851) exposes ~25 tools including curated reads (`get_my_tasks`, `get_active_tasks`, `get_blocked_tasks`, `get_ready_tasks`), `quick_create_task`, bulk ops, `advance_task_phase`; `agent_toolbox.py` (226) is the slim 8-tool `/develop`-loop variant. Plus **1790 LOC of manual prose** (`issue_creation`, `project_structuring`, `query`, `work_tracking`) and 3 playbooks (`feature_implementation`, `sprint_planning`, `work_tracking`) — directly portable as `TextManual`/`Playbook` content. Backed by `extensions/linear/` mixin adapter. **`defaults.py`'s state machine (10 workflow states with transitions, 4 priorities, 6 issue types, 4 health signals) is the best-thought-out task model in the estate** and has no TS equivalent.

### D. `pattern-stack/task-patterns` (`tp`)

Real published CLI (`npm i -g @pattern-stack/task-patterns`), atoms/features/molecules/organisms layering that predates agentic-patterns-ts's. `src/molecules/issue.api.ts` (580 LOC) = 32-method `IssueAPI` facade; 4 workflows (`bulk-operations`, `smart-search`, `sprint-planning`, `issue-relations`); hierarchical config (`.tp/config.json` → `~/.task-pattern/config.json` → env). **Hard-coupled to `@linear/sdk` throughout** — `ServiceOptions { client: LinearClient }` at `src/atoms/contracts/service.contracts.ts:74`. No abstraction seam to swap in a local store. `docs/archive/MVP_TOOL_ABSTRACTIONS.md` is a good never-built spec for agent-shaped tools.

---

## 3. Recommendation

**The task capability for the assistant should come from `pattern-stack/agent-patterns`' PM stack, ported onto current core, with a new `LocalTaskAdapter` as the primary backend and `GitHubTaskAdapter` as an optional second.**

Why:

1. **It's the only place in the estate where a task model already reaches an `@agentic-patterns/core` `Toolbox`.** `packages/expositions/pm-toolbox/src/toolbox.ts` is literally `extends Toolbox` with 10 zod-described tools. Everything else stops at a CLI (`tp`), a prompt (`claudecode-patterns`), or the wrong language (Python).
2. **The port seam *is* the "extend to a local version" affordance Doug remembered.** `TaskPort` is 6 methods; two adapters already prove it's vendor-neutral. A `LocalTaskAdapter` drops in behind the identical tool contract — zero changes to the toolbox, the surface, or the agent.
3. **Local should be primary, not secondary.** GitHub Issues is a poor store for a general-purpose assistant: gap #6 means the adapter can't set status, gap #3 means no `in_progress`, gap #1 means no delete. An assistant that can't move a task to in-progress is crippled. gh-backed is the right *dev-work* backend; local sqlite is the right *assistant* backend. Same tools, config-selected adapter — exactly what the port buys.
4. **It retires a dangling interface.** `packages/agent-core/src/protocols/task.ts` defines `TaskProtocol` (15 methods) with zero implementations anywhere in the repo. Note the two models differ: core's carries `phase`/`statusCategory`/`priority`/relations; agent-patterns' `TaskPort` is leaner (`open|in_progress|done|canceled` + labels). **Pick one — I'd take `TaskPort`'s shape and widen it with core's `phase`/`priority`, since only that one has working adapters.**

### Effort

| Piece | Size | Notes |
|---|---|---|
| Port domain + ports + surface + toolbox onto current core | **M** (half day) | ~430 LOC copy-paste; swap the hand-rolled `tool()` helper (`toolbox.ts:14-19`) for core's `defineTool` — typed args *and* runtime `returns` validation, strictly better |
| `LocalTaskAdapter implements TaskPort` (sqlite or JSON) | **S** (<2h) | 6 methods; `Task.create()` already does validation + freezing; ids `local:<uuid>` |
| Add `GitHubTaskAdapter` + client + integration-framework subset | **M** (half day) | ~980 LOC, already smoke-tested live via `gh auth token` |
| Manual + playbook prose ported from Python `defaults.py` | **S–M** | State machine → `TextManual`; high value, low risk |

**Local-only path: S–M (~half day). Local + gh: L (day+).**

**Main risk — core version skew, `^0.1.12` → `0.17.0`.** The `Toolbox` base class and `ToolDefinition` contract moved substantially in between (`defineTool` with `returns` validation, `ToolExecutionContext`, `SessionScope`/`requireScope`, the tool-authoring linter from #264/#270). Expect the 152-LOC toolbox to need a real rewrite against the current idiom rather than a drop-in — budget the half day for *that*, not for the ports, which are plain zod + interfaces and will move untouched.

**Secondary risk:** three competing task models are in flight (core's `TaskProtocol`, agent-patterns' `TaskPort`, Python's `defaults.py` state machine). Reconcile before writing the adapter, or you ship a fourth.

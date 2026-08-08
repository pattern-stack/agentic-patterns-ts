# Toolbox inventory — swe-brain (`pattern-stack/sdlc-patterns`) + `pattern-stack/agent-patterns`

**Purpose:** size harvesting existing agent toolboxes into `pattern-stack/agentic-patterns-ts` as a reusable "baseline generic capability pack" (web, notes, files, tasks, calendar, project management).

**Status: complete.** Both clones succeeded (`gh repo clone … --depth 1` into `/Users/dug/.claude/jobs/94af14d6/tmp/`). Both repos swept exhaustively for tool/toolbox definitions (`grep -rl "toolbox(\|defineTool\|ToolDefinition\|Toolbox"` across all `*.ts`, plus a manual walk of every workspace package). Nothing outstanding.

**Headline:** the two repos contain **4 toolboxes / 20 tools total**. Only one (agent-patterns' `TaskManagementToolbox`) is a production-grade generic capability. Every email/Slack/calendar "actuator" in swe-brain is a stub that returns a draft and never sends. There is **no web tool anywhere in either repo**.

---

## Repo A — `pattern-stack/sdlc-patterns` ("swe-brain")

Clone: `/Users/dug/.claude/jobs/94af14d6/tmp/sdlc-patterns`

**Tool-authoring idiom:** core `0.13.1` / runtime `0.28.1` (`apps/backend/package.json:20-21`). `class X extends Toolbox` with `readonly tools: Record<string, ToolDefinition>`; each entry `{description, parameters: zod, execute}`. **No `returns`, no `defineTool`, no `toolbox()` helper** — all postdate 0.13. `execute` receives `Record<string, unknown>`, so args are hand-cast (`workspace-read.toolbox.ts:56`).

Registered through `CapabilityRegistry` (`apps/backend/src/modules/agents/capability-registry.ts`) → consumed by `buildAgentFromConfig` (`agent-assembler.service.ts:69`). The registry carries a `blastRadius: 'read'|'write'|'external'` + `surface` overlay per capability (`capability-registry.ts:26-33`) — an app-side consent concept, explicitly *not* a framework primitive. It also exposes a read-only catalog (`list()`, `:156-175`) that introspects each toolbox's Zod params into flat JSON-schema param lists — the source for `GET /agents/capabilities`.

### Tool table

| Tool | Toolbox | Path | Purpose | Args | Deps / side-effects | Generic vs Domain | Effort |
|---|---|---|---|---|---|---|---|
| `list_emails` | WorkspaceRead | `apps/backend/src/modules/agents/workspace-read.toolbox.ts:100` | List recent emails (subject/from/snippet/timestamps) | `{limit?: int ≤100, default 25}` | **Read-only.** Postgres via NestJS `EmailService`. No vendor token, no external call | Generic factory, domain entity | **S** |
| `get_email` | WorkspaceRead | same `:101` | Fetch one email including body | `{id: string}` | same | same | **S** |
| `list_meetings` | WorkspaceRead | same `:102` | List meetings (title/time/organizer/attendees) | `{limit?}` | `MeetingService` (Postgres) | same | **S** |
| `get_meeting` | WorkspaceRead | same `:103` | Fetch one meeting by id | `{id}` | same | same | **S** |
| `list_people` | WorkspaceRead | same `:104` | List people (org identity directory: name + primary email) | `{limit?}` | `PersonService` (Postgres) | same | **S** |
| `get_person` | WorkspaceRead | same `:105` | Fetch one person by id | `{id}` | same | same | **S** |
| `gather_evidence` | WorkspaceSearch | `apps/backend/src/modules/agents/workspace-search.toolbox.ts:111` | Retrieval primitive: lexical rank → per-kind window → cite | `{question, kind?, per_kind? ≤20 default 4}` | **Read-only.** `ObservationService`; scans 500 rows/call (`SCAN_LIMIT`), ranks in-process. Keyword overlap, **not** semantic — no embedding index | **Generic** — `tokenize`/`score`/`cite` (`:54-83`) are pure fns over `{summary, quote, kind}` | **S–M** |
| `search_observations` | WorkspaceSearch | same `:137` | Unranked list of cited facts, optional kind filter | `{kind?, limit? ≤100 default 25}` | same | Generic | **S** |
| `send_email` | Comms | `apps/backend/src/modules/agents/comms.toolbox.ts:44` | "Compose and (with consent) send" an email | `{to, subject, body}` | **NONE — stub.** Returns `{status:'draft', gated:true}`, never sends (`:48-54`). Consent gate is "NOT yet wired into the run path" (`:5-7`) | Generic shape, zero implementation | **S** (net-negative) |
| `send_slack` | Comms | same `:56` | "Compose and (with consent) post" a Slack message | `{channel, text}` | **NONE — stub.** Same draft return (`:60-66`) | same | **S** (net-negative) |

### Per-toolbox harvest effort

| Toolbox | Effort | Why |
|---|---|---|
| **WorkspaceReadToolbox** | **S** (<2h) | Port `listTool`/`getTool` (`:58-68`) to `defineTool` + author `returns` schemas. Already entity-agnostic over a `{list, findById}` interface — it's a *generator*, not a fixed toolbox |
| **WorkspaceSearchToolbox** | **S–M** (2–4h) | Rank/window/cite lifts cleanly; needs a pluggable record-provider seam to replace `ObservationService`, plus `returns` schemas for the citation shape |
| **CommsToolbox** | **S** but not worth it | Two stubs, no transport. Faster to author fresh against a real client |

### The brief's infra vs. what is actually a TOOL

Every infra claim in the brief checks out — but **none of it is exposed as agent tools**:

- **No task/project-management tool of any kind.** swe-brain has no task or project entity across its 47 modules (`apps/backend/src/modules/`) — it is inbox/calendar/people/observation-shaped.
- **Calendar + email are read-only, via `list_meetings`/`list_emails` only.** Real Google transport exists (`packages/clients/google/src/client.ts` — a single OAuth token serving both `/gmail/v1` and `/calendar/v3`, "one client → many ports") and is **never handed to an agent**. Same for Slack (`packages/clients/slack/`) and Gong (`packages/clients/gong/`).
- **`apps/backend/src/triggers/actions.ts` is a *directive* action registry, not agent tools.** It contains exactly the names you'd want — `email.send`, `calendar.meeting.schedule`, `task.create` — but all three are `emitStub`: a dry-run `logger.log`, no transport. Plus 8 `generate.*` deterministic template stubs (`daily_brief`, `meeting_summary`, `action_items`, `standup_digest`, `risk_analysis`, `sentiment_pulse`, `weekly_wins_summary`, `contact_recent_activity_update`). **Value = naming/shape signal for the baseline pack, not code.**
- **The one real external write:** `messaging.message.create` → `PostMessageUseCase` (`apps/backend/src/modules/messaging/actuator/post-message.use-case.ts`) + `actuation-gate.ts`. A genuine consent-gated Slack post: `act` ConsentGrant check + visibility-≤-observed bound + echo-loop guard + write-through persist through `MessageRepository.integrationUpsertOne` (so a later poll-ingest of the bot's own post dedups). **Not a tool** — a Nest use-case threaded into the trigger dispatcher as `ctx.actuate`. Harvest = **L**; the pure gate policy in `actuation-gate.ts` (`canActuate`) is separable at **S**.
- **Cron/rrule schedules:** `apps/backend/src/triggers/cron.ts` — `nextOccurrence(row, after)` over two grammars (RRULE via `rrule` wins when set; else a 5/6-field cron via `croner` with IANA tz) + `validateCronExpression`. Throw-free by design (invalid → `null` → the dispatcher quarantines the row rather than hot-erroring every minute). ~90 LOC, genuinely generic. **S**, +2 deps. Documented in-file gap: the rrule path computes in naive UTC (needs luxon to thread tz).
- **JWT auth + consent lattice** = `modules/auth/`, `modules/consent_grants/`, `modules/messaging/consent/`. Pure app infra, no tool surface. **L**, not recommended for harvest.
- **`packages/query-surface/`** — a declarative query/retrieval engine (compiler, rank-normalize, expand, snippets, EAV reads, scope fail-closed). This is the substrate `gather_evidence` *emulates* lexically. Not a toolbox; belongs to the query-surface track, not agentic-patterns.

---

## Repo B — `pattern-stack/agent-patterns` (retired lab, harvest-only)

Clone: `/Users/dug/.claude/jobs/94af14d6/tmp/agent-patterns`

**Tool-authoring idiom:** core `0.1.12` (pinned via package.json `overrides`). Same `class X extends Toolbox` shape, but with a locally-authored `tool<T extends ZodTypeAny>()` helper (`packages/expositions/pm-toolbox/src/toolbox.ts:14-20`) that restores argument typing by sharing the inferred `T` between the schema and `execute` — **a direct ancestor of today's `defineTool`**, minus `returns`. Layer-first hexagonal layout: `domain → ports → adapters → clients → surfaces → expositions`, with `upstream/` staging pre-publication libs.

### Tool table

| Tool | Toolbox | Path | Purpose | Args | Deps / side-effects | Generic vs Domain | Effort |
|---|---|---|---|---|---|---|---|
| `task.create` | TaskManagement | `packages/expositions/pm-toolbox/src/toolbox.ts:88` | Create a task | `{title, description?=null, status='open', projectId?, parentId?, assigneeId?, labels[]}` | **Write.** Depends only on `TaskManagementSurface` = `{task: TaskPort, project: ProjectPort}`. **No vendor client, no env var, no db inside the toolbox** | **Generic / vendor-blind** | **M** |
| `task.get` | TaskManagement | same `:93` | Get a task by id | `{id}` — vendor-prefixed, Zod-guarded `^[a-z]+:` | Read via `TaskPort` | Generic | **M** |
| `task.list` | TaskManagement | same `:100` | List tasks, optionally filtered | `{status?, projectId?, parentId?}` | Read | Generic | **M** |
| `task.update` | TaskManagement | same `:106` | Patch a task | `{id, title?, description?, status?, projectId?, assigneeId?, labels?}` | Write | Generic | **M** |
| `task.delete` | TaskManagement | same `:110` | Delete a task | `{id}` | Write. (GitHub adapter maps this to close-as-`NOT_PLANNED` — Issues can't be deleted) | Generic | **M** |
| `project.create` | TaskManagement | same `:114` | Create a project | `{name, description?=null}` | Write via `ProjectPort` | Generic | **M** |
| `project.get` | TaskManagement | same `:119` | Get a project by id | `{id}` | Read | Generic | **M** |
| `project.list` | TaskManagement | same `:126` | List projects | `{status?: active\|archived}` | Read | Generic | **M** |
| `project.update` | TaskManagement | same `:131` | Patch a project | `{id, name?, description?, status?}` | Write | Generic | **M** |
| `project.delete` | TaskManagement | same `:135` | Delete a project | `{id}` | Write | Generic | **M** |

Toolbox-level extras: `{include?, exclude?}` tool subsetting (`:135-147`); dates ISO-serialized at the boundary via `serTask`/`serProject` (`:24-32`); a 156-line smoke test with stub ports (`pm-toolbox/src/smoke.test.ts`).

### Supporting layers behind that toolbox

| Layer | Path | What it is | Creds / deps |
|---|---|---|---|
| Domain | `packages/domain/pm/src/{task,project,base}.ts` | Frozen Zod-validated `Task`/`Project` with cross-field refinements (`completedAt` required iff status `done`/`archived`); `IdempotencyKey{vendor, externalId, tenantId}` → `synthesizeId` = `vendor:externalId` | zod only. Stylistically identical to target's atoms (`Object.freeze` + `Readonly<>`) |
| Ports | `packages/ports/{task,project}/src/` | `TaskPort`/`ProjectPort`: `create/get/list/update/delete/listSince` + Zod input/filter schemas | zod |
| Surface | `packages/surfaces/pm/src/surface.ts` | Composes both ports into `TaskManagementSurface` | integration-framework |
| Adapter · Linear | `packages/adapters/linear/src/{task,project}-adapter.ts`, `external.ts`, `mappers.ts`, `queries.ts` | GraphQL. Status↔`stateType` map (`open→[triage,backlog,unstarted]`, `in_progress→[started]`, `done→[completed]`, `canceled→[canceled]`); always team-scopes `list()` so a single-team agent can't leak other teams' issues | `LINEAR_API_KEY`, `LINEAR_TEAM_ID` |
| Adapter · GitHub | `packages/adapters/github/src/{task,project}-adapter.ts` | Issues + ProjectsV2. **7 divergences enumerated in the file header**: (1) no delete → close `NOT_PLANNED`; (2) no idempotency-key mechanism; (3) no `in_progress` state → that filter returns `[]`; (4) `projectId`/`parentId` filters need client-side filtering; (5) multi-assignee/project → adapter takes first; (6) `update()` forwards title/description only, everything else throws `Unsupported`; (7) `listSince` throws `Unsupported` on page saturation rather than silently truncating. Projects are **org-only** (personal accounts fail) | `GITHUB_TOKEN`, `GITHUB_OWNER`, `GITHUB_REPO` |
| Clients | `packages/clients/{github,linear}/src/client.ts` | Thin GraphQL transports mapping HTTP status → typed errors (`RateLimited(retryAfterMs)` off `X-RateLimit-*`, `Forbidden`, `NotFound`, `Unavailable`, `ValidationError`) | `fetch` |
| — | `packages/clients/linear/src/team-resolver.ts` | Resolves a Linear team identifier (UUID **or** alpha key like `"AP"`) → canonical UUID + parent organization (the natural `tenantId`) | Linear API |
| Framework | `upstream/integration-framework/src/` | `Port`/`Surface`/`Adapter`/`Client` + `Retrying(RateLimited(Traced(client)))` wrappers + 7 typed errors + `stripVendorPrefix` | none |
| Registry | `apps/backend/src/modules/agents/capability-registry.ts:74` | Registers exactly **one** capability, `task-management`, wired GitHub-only and **read-restricted**: `include: ['task.list','task.get','project.list','project.get']` | `GITHUB_TOKEN` |
| Hand-built twin | `apps/backend/src/modules/agents/pm/pm.service.ts:113-140` | Same client→adapter→surface→toolbox wiring, built imperatively via `AgentBuilder`/`RoleBuilder` instead of by name | same |

### Per-item harvest effort

| Item | Effort | Note |
|---|---|---|
| `TaskManagementToolbox` **alone**, re-pointed at slim inline `TaskStore`/`ProjectStore` interfaces | **S–M** (3–5h) | Tools already depend only on an interface. Work = `defineTool` + author 10 `returns` schemas + inline the 2 port interfaces. **Drops all 6 supporting packages.** |
| `TaskManagementToolbox` + domain + ports + surface (faithful port) | **M** (half day) | 6 workspace packages collapse to ~2 modules; zod-only, no infra; preserves idempotency/tenancy semantics |
| GitHub adapter + client | **M** (half day) | Self-contained (GraphQL over `fetch`), but vendor-specific and carries the 7 known gaps |
| Linear adapter + client + team-resolver | **M** (half day) | Cleaner capability fit than GitHub (real status mapping, real delete via archive) |
| `include`/`exclude` subsetting | **S** (<1h) | |

### Novel, not yet upstreamed (job→agent-run and the declarative agent factory excluded per brief)

1. **`{include, exclude}` toolbox subsetting** (`pm-toolbox/src/toolbox.ts:135-147`) — lets one CRUD toolbox be registered read-only vs read-write from a single definition. ~10 LOC; no equivalent in target's `packages/agent-core/src/molecules/toolbox.ts`. **Worth lifting.**
2. **Vendor-prefixed id + `IdempotencyKey` convention** — `vendor:externalId` with a `^[a-z]+:` Zod guard threading domain → port → tool params. A good convention for any multi-backend capability pack.
3. **Adapter divergence-documentation discipline** — the GitHub adapters' head comments enumerate every capability gap and consistently choose `throw Unsupported` over silent truncation. Pattern, not code.
4. **`tool()` typed helper** — already superseded by `defineTool`. Nothing to take.
5. **`upstream/integration-framework`** — **do not harvest.** It overlaps `pattern-stack/codegen`'s integration-framework (swe-brain carries a much larger sibling at `packages/integration-framework/`). Belongs to the codegen track, not agentic-patterns.

---

## Shortlist — baseline generic capability pack

### Coverage reality check

| Baseline slot | Harvestable today | Source |
|---|---|---|
| Tasks | ✅ full CRUD, vendor-blind | agent-patterns `TaskManagementToolbox` |
| Project management | ✅ full CRUD, vendor-blind | same |
| Search / retrieval (cross-cutting) | ✅ rank → window → cite | swe-brain `WorkspaceSearchToolbox` |
| Notes / files | ⚠️ **pattern only** — the list/get factory. swe-brain has `document`/`folder` entities + services but **zero tools over them** | swe-brain `WorkspaceReadToolbox` factories |
| Calendar | ❌ read-only list/get of meetings; no create/update. Write exists only as a dry-run stub (`calendar.meeting.schedule`) | — |
| Email | ❌ read list/get only; `send_email` is a draft stub | — |
| Slack | ❌ `send_slack` is a draft stub; the real gated poster is app infra (**L**) | — |
| Web | ❌ **nothing in either repo** — must be authored fresh | — |

### Recommended pack (ranked)

1. **`TaskManagementToolbox` → `tasks` + `projects` capabilities** — `packages/expositions/pm-toolbox/src/toolbox.ts` + `packages/domain/pm/` + `packages/ports/{task,project}/`. The single highest-value asset across both repos: 10 tools, zero infra coupling, already Zod-first and frozen-immutable in the target's own house style. **M — half day.**
2. **`SearchToolbox`** (from `WorkspaceSearchToolbox`) — `apps/backend/src/modules/agents/workspace-search.toolbox.ts`. The `gather_evidence` rank→window→cite discipline generalizes to any citable record source and pairs naturally with the already-shipped MemoryToolbox. **S–M — 2–4h.**
3. **`readToolsFor(entity, store)` factory** (from `WorkspaceReadToolbox`) — `workspace-read.toolbox.ts:58-68`. Not a capability but a *generator*: ~10 lines yields a list/get pair for any `{list, findById}` store. Directly serves notes/files/contacts once those stores exist. **S — <2h.**
4. **`include`/`exclude` toolbox subsetting** — `pm-toolbox/src/toolbox.ts:135-147`. **S — <1h.**
5. **`nextOccurrence` rrule+cron math** — `apps/backend/src/triggers/cron.ts`. The scheduling half of a future reminders/calendar capability. **S — <2h** (+`croner`, `rrule`).
6. *(optional, vendor-specific)* **GitHub and/or Linear adapter** — proves the vendor-blind port is real with a second backend. **M each.**

### Total effort

- **Items 1–5: ~1.5 days.**
- **+ one vendor adapter: ~2 days.**
- **Everything not on this list (email send, Slack post, calendar write, web) is greenfield authoring, not harvest.**

---

## Three flags for the decision

1. **Every actuator-looking name in swe-brain is a stub.** `send_email`, `send_slack`, `calendar.meeting.schedule`, `task.create`, `email.send` — all return `{status:'draft'}` or a dry-run log line. There is no email-send, calendar-write, or Slack-post *tool* to harvest; only the consent-gated Nest use-case (**L**) and the raw HTTP transports in `packages/clients/{google,slack,gong}`.
2. **No web capability exists in either repo.** It must be authored fresh.
3. **swe-brain explicitly forbids the architecture the baseline pack wants.** `workspace-read.toolbox.ts:78-87` states the invariant that an agent must never hold a vendor token, never see a vendor SDK, never call Google/GitHub/Slack — and names agent-patterns' GitHub-backed toolbox as the model "deliberately NOT replicated here." The harvest is therefore a real architectural fork: **agent-patterns' direct-to-vendor toolbox is what a general-purpose assistant wants; swe-brain's brain-mediated one is what a multi-tenant product wants.** Settle this before building — it determines whether the `tasks` capability takes a vendor client or a normalized store.

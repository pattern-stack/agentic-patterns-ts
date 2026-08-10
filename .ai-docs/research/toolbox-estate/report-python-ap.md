# Python `agentic-patterns` — Toolbox / Tool Inventory & TS Port Sizing

**Source:** `pattern-stack/agentic-patterns` @ v0.5.0, cloned shallow to
`/Users/dug/.claude/jobs/94af14d6/tmp/agentic-patterns-py`
**Target:** `pattern-stack/agentic-patterns-ts` (`defineTool` / `toolbox()` / Capability = Toolbox + Manual)
**Status:** clone succeeded, sweep complete — no gaps.

---

## Toolbox index (idiom + port effort)

The Python idiom is **subclass `BaseToolbox`; every public `async def` auto-becomes a tool** — tool name = method
name, description = docstring first line, JSON-Schema params derived from type hints via `_build_tool_def` /
`_type_to_schema` (`agentic_patterns/core/molecules/toolboxes/base.py:26`).

A second tool surface exists: **`BasePlaybook` "plays"** are surfaced identically and concatenated into
`Capability.get_tools()` (`agentic_patterns/core/molecules/capabilities/capability.py:44`).

Those two idioms account for **100%** of tool definitions in the repo — no decorator registry, no MCP server, no
function-tool registry. Verified by grepping every `class .*Toolbox` / `class .*Playbook` across
`agentic_patterns/`, `app/`, `examples/`, `evals/`, `scripts/`, `pattern_stack/`.

| # | Toolbox / Playbook | File | Tools | Port effort | Notes |
|---|---|---|---|---|---|
| 1 | `BaseToolbox` (infra) | `agentic_patterns/core/molecules/toolboxes/base.py:26` | — | **superseded** | TS `Toolbox` / `toolbox()` / `defineTool` already covers it (`packages/agent-core/src/molecules/toolbox.ts`), with Zod instead of type-hint introspection |
| 2 | `ManualToolbox` | `agentic_patterns/core/molecules/manuals/toolbox.py:9` | 2 | **already ported** | Exists in TS at `packages/agent-core/src/molecules/manual.ts:288` |
| 3 | `MessagingToolbox` | `agentic_patterns/core/systems/transport/messaging_toolbox.py:16` | 3 | **already ported** | Exists in TS at `packages/agent-runtime/src/transport/messaging-toolbox.ts:23` |
| 4 | `TaskManagementToolbox` | `agentic_patterns/extensions/task_management/toolbox.py:111` | 50 | **L** (facade-only over a protocol: M) | Thin facade + summarizers over 4 injected protocols; the only real backend is `LinearAdapter` (7 GraphQL mixins) which itself imports `pattern_stack.atoms.cache` (Python-only infra) — `agentic_patterns/extensions/linear/adapter.py:6` |
| 5 | `AgentTaskToolbox` | `agentic_patterns/extensions/task_management/agent_toolbox.py:70` | 8 | **M** | Same protocol deps, ~8-tool surface. TS `todo-manager` preset already covers 4 of the shapes in-memory (`packages/agent-runtime/src/presets/agents/todo-manager.ts:61`) |
| 6 | `VoiceToolbox` (abstract) + `OpenAIVoiceToolbox` | `examples/spanish_tutor/voice/base.py:54`, `.../openai.py:38` | 4 + 2 | **M** | `openai` SDK (Whisper STT + TTS), `OPENAI_API_KEY`, filesystem writes |
| 7 | `DeepgramVoiceToolbox` | `examples/spanish_tutor/voice/deepgram.py:22` | 2 | **skip** | Pure stub — every method `raise NotImplementedError` |
| 8 | `ElevenLabsVoiceToolbox` | `examples/spanish_tutor/voice/elevenlabs.py:23` | 2 | **skip** | Pure stub — every method `raise NotImplementedError` |
| 9 | `FeatureImplementationPlaybook` | `agentic_patterns/extensions/task_management/playbooks/feature_implementation.py` | 4 plays | **S** | Pure composition over `task_ops`/`tag_ops`; TS has `Playbook`/`definePlaybook` already |
| 10 | `SprintPlanningPlaybook` | `agentic_patterns/extensions/task_management/playbooks/sprint_planning.py` | 5 plays | **S** | Needs a `sprint_ops` protocol (Linear Cycles) that TS does not have |
| 11 | `WorkTrackingPlaybook` | `agentic_patterns/extensions/task_management/playbooks/work_tracking.py` | 5 plays | **S** | Pure composition over `task_ops`/`comment_ops` |

**83 tool-surfaced callables total** (69 toolbox tools + 14 plays).

---

## All tools

| Tool | Toolbox (path) | Purpose | Args (brief) | Deps / side-effects | Generic? |
|---|---|---|---|---|---|
| `read_manual_section` | ManualToolbox · `core/molecules/manuals/toolbox.py` | Fetch one manual section on demand (progressive disclosure) | `section_name: str` | none — pure in-memory | **GENERIC** (already in TS) |
| `list_manual_sections` | ManualToolbox · same | List available manual sections | — | none | **GENERIC** (already in TS) |
| `send_message` | MessagingToolbox · `core/systems/transport/messaging_toolbox.py` | DM another agent by role name | `to: str, content: str` | publishes `AgentMessageEvent` to `SandboxEventBus` | **GENERIC** (already in TS) |
| `broadcast` | MessagingToolbox · same | Broadcast to all agents | `content: str` | publishes `AgentBroadcastEvent` | **GENERIC** (already in TS) |
| `list_team` | MessagingToolbox · same | List team roster + agent ids | — | in-memory roster | **GENERIC** (already in TS) |
| `list_tasks` | TaskManagementToolbox · `extensions/task_management/toolbox.py` | List tasks with optional filter | `filter: TaskFilter?` | Linear GraphQL read (`LINEAR_API_KEY`, `LINEAR_TEAM_ID`), httpx, `pattern_stack` cache | DOMAIN — issue tracking (generic shape) |
| `get_task` | TaskManagementToolbox | Get one task by id (e.g. AGENT-123) | `id: str` | Linear read | DOMAIN — issue tracking |
| `get_my_tasks` | TaskManagementToolbox | Tasks assigned to current user | `phase?, status_category?` | Linear read (+ viewer lookup) | DOMAIN |
| `get_active_tasks` | TaskManagementToolbox | Tasks in-progress | — | Linear read | DOMAIN |
| `get_blocked_tasks` | TaskManagementToolbox | Tasks with blockers | — | Linear read | DOMAIN |
| `get_ready_tasks` | TaskManagementToolbox | IMPLEMENTATION-phase + TODO tasks | — | Linear read | DOMAIN |
| `create_task` | TaskManagementToolbox | Full-control task creation | `input: CreateTaskInput` | **Linear write** | DOMAIN |
| `quick_create_task` | TaskManagementToolbox | Task creation with defaults | `title, description?, assignee_id?` | **Linear write** | DOMAIN |
| `update_task` | TaskManagementToolbox | Update task fields | `id, title?, description?, status_category?, priority?, assignee_id?` | **Linear write** | DOMAIN |
| `delete_task` | TaskManagementToolbox | Archive/delete task | `id: str` | **Linear destructive write** | DOMAIN |
| `bulk_update_tasks` | TaskManagementToolbox | Same update across many tasks | `ids: list[str], status_category?, priority?, assignee_id?` | **Linear bulk write** | DOMAIN |
| `bulk_delete_tasks` | TaskManagementToolbox | Delete many tasks | `ids: list[str]` | **Linear destructive bulk write** | DOMAIN |
| `advance_task_phase` | TaskManagementToolbox | Planning → implementation phase | `id: str` | **Linear write** | DOMAIN |
| `list_projects` | TaskManagementToolbox | List projects (summary) | — | Linear read | DOMAIN |
| `get_project` | TaskManagementToolbox | Get project by id | `id: str` | Linear read | DOMAIN |
| `create_project` | TaskManagementToolbox | Create project | `name, description?` | **Linear write** | DOMAIN |
| `update_project` | TaskManagementToolbox | Update project | `id, name?, description?, status_category?` | **Linear write** | DOMAIN |
| `delete_project` | TaskManagementToolbox | Delete/archive project | `id: str` | **Linear destructive write** | DOMAIN |
| `assign_to_project` | TaskManagementToolbox | Move task into project | `task_id, project_id` | **Linear write** | DOMAIN |
| `get_project_tasks` | TaskManagementToolbox | Tasks in a project | `project_id: str` | Linear read | DOMAIN |
| `list_tags` | TaskManagementToolbox | List labels | — | Linear read | DOMAIN |
| `get_task_tags` | TaskManagementToolbox | Labels on a task | `task_id: str` | Linear read | DOMAIN |
| `apply_tag` | TaskManagementToolbox | Apply label by id | `task_id, tag_id` | **Linear write** | DOMAIN |
| `apply_tag_by_name` | TaskManagementToolbox | Apply label by name (resolves id) | `task_id, tag_name` | Linear read + **write** | DOMAIN |
| `remove_tag` | TaskManagementToolbox | Remove label | `task_id, tag_id` | **Linear write** | DOMAIN |
| `set_task_tags` | TaskManagementToolbox | Replace all labels | `task_id, tag_ids: list[str]` | **Linear write** | DOMAIN |
| `create_tag` | TaskManagementToolbox | Create label | `name, color?, description?` | **Linear write** | DOMAIN |
| `update_tag` | TaskManagementToolbox | Update label | `id, name?, color?` | **Linear write** | DOMAIN |
| `delete_tag` | TaskManagementToolbox | Delete label | `id: str` | **Linear destructive write** | DOMAIN |
| `bulk_apply_tag` | TaskManagementToolbox | Apply one label to many tasks | `task_ids: list[str], tag_id` | **Linear bulk write** | DOMAIN |
| `get_current_user` | TaskManagementToolbox | Authenticated viewer | — | Linear read | DOMAIN (generic shape) |
| `get_user` | TaskManagementToolbox | User by id | `id: str` | Linear read | DOMAIN |
| `find_user_by_name` | TaskManagementToolbox | Fuzzy user lookup | `name: str` | Linear read + client-side match | DOMAIN |
| `list_team_members` | TaskManagementToolbox | Members of current team | — | Linear read | DOMAIN |
| `get_team` | TaskManagementToolbox | Current team info | — | Linear read | DOMAIN |
| `list_teams` | TaskManagementToolbox | All workspace teams | — | Linear read | DOMAIN |
| `assign_task` | TaskManagementToolbox | Assign to user id | `task_id, user_id` | **Linear write** | DOMAIN |
| `assign_task_by_name` | TaskManagementToolbox | Assign by user name | `task_id, user_name` | Linear read + **write** | DOMAIN |
| `unassign_task` | TaskManagementToolbox | Clear assignee | `task_id: str` | **Linear write** | DOMAIN |
| `get_user_tasks` | TaskManagementToolbox | Tasks assigned to a user | `user_id: str` | Linear read | DOMAIN |
| `get_user_tasks_by_name` | TaskManagementToolbox | Same, by name | `user_name: str` | Linear read ×2 | DOMAIN |
| `get_team_workload` | TaskManagementToolbox | Task count per member | — | Linear read (fan-out) | DOMAIN |
| `get_available_assignees` | TaskManagementToolbox | Members under a WIP cap | `max_tasks: int = 5` | Linear read (fan-out) | DOMAIN |
| `link_parent` | TaskManagementToolbox | Child→epic link | `child_id, parent_id` | **Linear write** | DOMAIN |
| `unlink_parent` | TaskManagementToolbox | Remove parent link | `child_id, parent_id` | **Linear write** | DOMAIN |
| `get_parent` | TaskManagementToolbox | Parent of a task | `child_id: str` | Linear read | DOMAIN |
| `get_children` | TaskManagementToolbox | Children of an epic | `parent_id: str` | Linear read | DOMAIN |
| `add_blocker` | TaskManagementToolbox | Mark A blocks B | `blocked_id, blocker_id` | **Linear write** | DOMAIN |
| `remove_blocker` | TaskManagementToolbox | Remove block relation | `blocked_id, blocker_id` | **Linear write** | DOMAIN |
| `get_blockers` | TaskManagementToolbox | Tasks blocking this one | `task_id: str` | Linear read | DOMAIN |
| `get_ready_tasks` | AgentTaskToolbox · `extensions/task_management/agent_toolbox.py` | Ready-to-pick-up work | — | Linear read (via `TaskProtocolLike`) | DOMAIN — SDLC/coding agent |
| `get_task` | AgentTaskToolbox | Full task detail | `task_id: str` | Linear read | DOMAIN |
| `update_status` | AgentTaskToolbox | Move task status | `task_id, status_category: StatusCategory` | **Linear write** | DOMAIN |
| `add_comment` | AgentTaskToolbox | Log markdown progress comment | `task_id, body: str` | **Linear write** (Comment protocol) | DOMAIN |
| `advance_phase` | AgentTaskToolbox | Planning → implementation | `task_id: str` | **Linear write** | DOMAIN |
| `create_subtasks` | AgentTaskToolbox | Create child tasks under a parent | `parent_id, tasks: list[{title, description?}]` | **Linear bulk write** | DOMAIN |
| `set_tags` | AgentTaskToolbox | Replace tags on a task | `task_id, tag_ids: list[str]` | **Linear write** | DOMAIN |
| `get_project_tasks` | AgentTaskToolbox | Board-level project view | `project_id: str` | Linear read | DOMAIN |
| `transcribe` | VoiceToolbox/OpenAI · `examples/spanish_tutor/voice/{base,openai}.py` | Audio → text | `audio: bytes\|Path\|str, language='es', prompt?` | OpenAI Whisper API, `OPENAI_API_KEY`, filesystem read | **GENERIC** (assistant STT) |
| `speak` | VoiceToolbox/OpenAI · same | Text → speech bytes | `text, voice?, speed=1.0` | OpenAI TTS API, `OPENAI_API_KEY` | **GENERIC** (assistant TTS) |
| `transcribe_file` | VoiceToolbox (base) · `voice/base.py` | Transcribe from a path | `file_path, language='es'` | filesystem read + provider call | **GENERIC** |
| `speak_to_file` | VoiceToolbox (base) · same | Synthesize and write audio file | `text, output_path, voice?` | **filesystem write** + provider call | **GENERIC** |
| `speak_spanish` | OpenAIVoiceToolbox · `voice/openai.py` | Spanish TTS, optionally slowed | `text, slow=False` | OpenAI TTS | DOMAIN — language tutor |
| `transcribe_spanish` | OpenAIVoiceToolbox · same | Spanish STT with vocab hints | `audio, vocabulary_hints?` | OpenAI Whisper | DOMAIN — language tutor |
| `transcribe` / `speak` | DeepgramVoiceToolbox · `voice/deepgram.py` | — | same shape as base | **stub, raises NotImplementedError** | n/a |
| `transcribe` / `speak` | ElevenLabsVoiceToolbox · `voice/elevenlabs.py` | — | same shape as base | **stub, raises NotImplementedError** | n/a |
| `create_epic_from_spec` | FeatureImplementationPlaybook · `.../playbooks/feature_implementation.py` | Spec → epic + sub-issues | `title, spec, parent_id?, apply_tag_ids?` | **Linear bulk write** via `task_ops`/`tag_ops` | DOMAIN — SDLC |
| `create_implementation_chain` | FeatureImplementationPlaybook | Chain of dependent tasks | `titles: list[str], epic_id?` | **Linear bulk write** | DOMAIN — SDLC |
| `start_implementation` | FeatureImplementationPlaybook | Mark started + note | `task_id, implementation_notes?` | **Linear write** | DOMAIN — SDLC |
| `complete_implementation` | FeatureImplementationPlaybook | Mark complete + summary | `task_id, completion_summary?` | **Linear write** | DOMAIN — SDLC |
| `create_sprint_milestone` | SprintPlanningPlaybook · `.../playbooks/sprint_planning.py` | Create sprint + link tasks | `name, goal, starts_at, ends_at, task_ids?` | **Linear Cycles write** (`sprint_ops`) | DOMAIN — agile PM |
| `analyze_sprint_readiness` | SprintPlanningPlaybook | Readiness check across tasks | `task_ids: list[str]` | Linear read + local scoring | DOMAIN — agile PM |
| `generate_sprint_report` | SprintPlanningPlaybook | Sprint progress report | `sprint_id: str` | Linear read | DOMAIN — agile PM |
| `plan_next_sprint` | SprintPlanningPlaybook | Gather ready work into a sprint | `sprint_name, starts_at, ends_at, capacity?` | Linear read + **write** | DOMAIN — agile PM |
| `close_sprint_with_summary` | SprintPlanningPlaybook | Closing summary | `sprint_id: str` | Linear read + **write** | DOMAIN — agile PM |
| `post_progress_update` | WorkTrackingPlaybook · `.../playbooks/work_tracking.py` | Structured progress comment | `task_id, what_done, what_next, blockers?` | **Linear comment write** | DOMAIN — SDLC |
| `post_standup_update` | WorkTrackingPlaybook | Standup across many tasks | `task_ids, what_done, what_next, blockers?` | **Linear bulk comment write** | DOMAIN — SDLC |
| `mark_task_blocked` | WorkTrackingPlaybook | Block + link + explain | `task_id, blocker_id, reason` | **Linear write** ×2 | DOMAIN — SDLC |
| `complete_task_with_summary` | WorkTrackingPlaybook | Close with summary/lessons | `task_id, summary, lessons_learned?` | **Linear write** | DOMAIN — SDLC |
| `escalate_task` | WorkTrackingPlaybook | Escalate + notify | `task_id, escalation_reason, notify_user_ids?` | **Linear write** | DOMAIN — SDLC |

---

## Shortlist for the baseline generic pack

**Headline finding: the Python repo contains no baseline generic capability pack, and almost nothing to harvest
for one.** Zero web fetch, zero web search, zero notes/files/filesystem, zero calendar, zero email, zero shell,
zero HTTP-request tool. The entire tool estate is:

1. framework plumbing (manual + messaging) — **both already ported to TS**,
2. one very large Linear-backed issue-tracker facade (50 tools + 14 plays),
3. an example-grade voice pair.

Confirmed exhaustively: `httpx` / `aiohttp` / `requests` appear in exactly **one** non-test source file
(`agentic_patterns/extensions/linear/client.py`), and nothing in the repo touches a filesystem, browser, or
search API outside the voice example. The only external creds in `.env.example` are LLM provider keys,
`LINEAR_API_KEY` / `LINEAR_TEAM_ID(S)`, and observability endpoints (OTel / Langfuse).

### What I would take from Python

| Take | Source | Effort | Rationale |
|---|---|---|---|
| Voice pair — `transcribe` / `speak` / `transcribe_file` / `speak_to_file` | `examples/spanish_tutor/voice/base.py:54` + `openai.py:38` | **M** (~4h) | The only genuinely generic, non-superseded tools in the repo. Port `VoiceToolbox` as an abstract `Toolbox` with a provider seam; implement OpenAI first (Whisper + TTS). Drop `speak_spanish`/`transcribe_spanish` (tutor-specific) and both provider stubs. |
| `AgentTaskToolbox` shape (8 tools) as the **schema template** for a generic task tool, not a port | `extensions/task_management/agent_toolbox.py:70` | **S** (~2h) | Its `_summarize_task` "compact dict for LLM consumption" pattern is the right tool-output ergonomic. TS `todo-manager` preset already covers create/list/complete/delete; add `add_comment` + `create_subtasks` + `update_status` shapes over a local store. |
| Nothing else | — | — | TaskManagement (50 tools) and all three playbooks are Linear-shaped SDLC/agile domain surface, not daily-driver material; `LinearAdapter`'s `pattern_stack.atoms.cache` dependency makes a faithful port L-effort for no generic payoff. Manual + Messaging are already in TS. |

**Total for the pack sourced from Python: ~6 hours (M).**

### What the baseline pack still needs — written fresh in TS (no Python source exists)

web fetch · web search · notes/knowledge CRUD · filesystem read/write/glob · generic tasks/reminders · calendar ·
email · HTTP request · shell/exec · date-time.

Budget those independently — the Python repo contributes nothing to them.

### Already native in agentic-patterns-ts (compose, don't re-author)

- Memory — `packages/agent-runtime/src/memory/toolbox.ts` (`memory_save`, `memory_search`, `memory_list`, `memory_invalidate`)
- Messaging — `packages/agent-runtime/src/transport/messaging-toolbox.ts`
- Scratchpad — `packages/agent-runtime/src/workflows/observed-scratchpad.ts`
- Manual lookup — `packages/agent-core/src/molecules/manual.ts:288` (`ManualToolbox`)

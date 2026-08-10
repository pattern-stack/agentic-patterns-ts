# Ambient test walkthrough — M2 ignition + memory Phase 1

> Written 2026-08-09 for the session that follows the big merge-down. Everything below
> landed on `main` in both repos; nothing is published to npm yet. Paths and ports were
> verified against the merged trees, not recalled.
>
> **What you are testing:** a schedule occurrence starting a real agent run with no human
> in the loop (Test A), and an agent that remembers you across process restarts (Test B).
> Test C is the free, no-token regression check.

---

## Before you start

| | |
|---|---|
| Repos | `~/Projects/dug/swe-brain` (Test A) · `~/Projects/dug/agentic-patterns-ts` (Tests B/C) |
| Model credential | **None needed.** `createRunner`'s ladder falls through to `ClaudeCodeAPIRunner` using your `claude` CLI login. Setting `ANTHROPIC_API_KEY` also works and gives richer streaming events. |
| Runtime | **bun, never node.** Node hits the better-sqlite3 ABI wall and memory stores silently degrade to in-memory — tests and demos then lie. |
| Env gotcha | `just` loads `.env` only, and a process env var beats bun's `.env.local`. A stale `.env` silently shadows real values — check it before debugging any auth failure. |
| Gateway | Skip Bifrost. A configured gateway forces resolver mode before the `AGENT_MODEL`/`AGENT_TIER` branches and any agent without a pinned model fails loud (issue #243). |

---

## Test A — the ambient loop (swe-brain, ~15 min)

**The claim under test:** a time trigger starts a real agent run, end to end, unattended,
and the run's own row records *why it happened*.

### A1 · Bring the stack up

```bash
cd ~/Projects/dug/swe-brain
docker compose up -d postgres          # already running from 2026-08-08 if you left it
cd apps/backend && bun run db:apply    # no-op if migrations are current
bun run scripts/seed-schedules.ts      # idempotent; seeds the agent.run demo directive
```

Then two processes, each in its own terminal (the api/worker split is the point — the
worker is what claims jobs):

```bash
cd ~/Projects/dug/swe-brain/apps/backend
bun src/main.ts        # API   → http://localhost:3100
bun src/worker.ts      # WORKER → no port; its logs are the observability surface
```

Or `just dev-backend` for postgres + api + worker + tunnel under process-compose
(`just dev-logs worker` to tail).

### A2 · Fire it

```bash
docker exec swe-brain-postgres-1 psql -U swebrain -d swebrain \
  -c "UPDATE schedules SET enabled=true WHERE name='demo-minutely';"
```

Within 60 seconds the **worker** log should show this four-line sequence:

```
[ScheduleDispatcherJobHandler] directive[scheduled-agent-brief] agent.run enqueued agent 'workspace-analyst' as job <uuid> (schedule:demo-minutely)
[ScheduleDispatcherJobHandler] schedule-dispatcher: fired 1/1 due schedule(s) (demo-minutely)
[AgentRunJobHandler] agent-run: 'workspace-analyst' fired by directive[scheduled-agent-brief] (schedule:demo-minutely)
[AgentRunJobHandler] agent-run: 'workspace-analyst' completed run <uuid> (N events, X/Y tokens)
```

**That is the headline result.** Nothing typed it; a cron minute did.

### A3 · Verify the durable evidence (the part that matters)

```bash
# provenance on the run row — the row alone answers "why did this run happen"
docker exec swe-brain-postgres-1 psql -U swebrain -d swebrain -x -c \
  "SELECT id, agent_name, run_status, iterations, output_tokens, jsonb_pretty(run_context)
   FROM agent_runs ORDER BY created_at DESC LIMIT 1;"

# job lineage — the agent run is a CHILD of the dispatcher run
docker exec swe-brain-postgres-1 psql -U swebrain -d swebrain -c \
  "SELECT jr.job_type, jr.status, jr.pool, p.job_type AS parent_type, p.pool AS parent_pool
   FROM job_run jr LEFT JOIN job_run p ON p.id = jr.parent_run_id
   WHERE jr.job_type='agent-run' ORDER BY jr.created_at DESC LIMIT 1;"
```

Pass looks like: `run_context.trigger` naming the directive, the schedule, and the claimed
slot; and `agent-run` on pool `interactive` with parent `schedule-dispatcher` on pool
`batch` (the LLM loop deliberately does not squat the concurrency-5 batch pool).

Prove the run was **real**, not a stub — the agent called tools and answered honestly:

```bash
docker exec swe-brain-postgres-1 psql -U swebrain -d swebrain -c \
  "SELECT type, left(payload::text,200) FROM agent_run_events
   WHERE run_id=(SELECT id FROM agent_runs ORDER BY created_at DESC LIMIT 1)
   AND type LIKE '%message%' ORDER BY seq DESC LIMIT 2;"
```

### A4 · The browser pass

```bash
cd ~/Projects/dug/swe-brain && just dev     # adds the frontend on :8338
cd apps/backend && bun scripts/set-seed-password.ts   # login: owner@swe-brain.test / swebrain-dev
```

Open `http://localhost:8338` and walk: **/schedules** (see `demo-minutely` and its
`next_fire_at` advancing each minute) → **/directives** (`scheduled-agent-brief`, its
`agent.run` step) → **/agents** → the workspace-analyst **console / trace** view, where the
triggered run should appear alongside console-started ones.

⚠️ **Verify rather than assume:** `process-compose.yml` carries a comment that the frontend
runs on mock data (`VITE_DATA_SOURCE=mock`), but the generated store binds entities to
`api`/`electric` backings — the two disagree and I did not resolve which wins at runtime.
If the browser shows agents you don't recognize, that's mock data; the psql/API results
above are ground truth. If needed, set `VITE_API_URL=http://localhost:3100` (and
`VITE_DATA_SOURCE=rest`) in `apps/frontend/.env.local` and restart the frontend.

### A5 · Stand down

```bash
docker exec swe-brain-postgres-1 psql -U swebrain -d swebrain \
  -c "UPDATE schedules SET enabled=false WHERE name='demo-minutely';"
```

Leave it enabled only if you want the loop running all day — it costs a real model call
per minute.

### Known limits (expected, not bugs)

- **`agent_runs.final_answer` is empty** on the claude-CLI path — the answer lives in the
  `agent.message.complete` event instead. Filed as sdlc-patterns#363.
- **The agent's answer cannot post back to Slack.** `agent.run` *enqueues* and returns
  `{jobRunId, enqueued}`, not the answer, so a downstream `messaging.message.create` has
  nothing to bind. Await-mode composition was a deliberate non-goal this round.
- **Scheduled directives still cannot post at all** — the schedule dispatcher withholds
  `actuate` by design. Opening that is the pending C1 policy decision (consent-gated
  DM-to-owner first).
- The agent has no memory yet on this path — swe-brain's memory adoption is
  sdlc-patterns#364.

---

## Test B — cross-session memory (agentic-patterns-ts, ~10 min)

**The claim under test:** the agent remembers you after the process dies.

```bash
cd ~/Projects/dug/agentic-patterns-ts
just companion        # builds, then runs the playground under bun
```

Persistence lives at `~/.local/state/ap/memory.db` (override with `AP_MEMORY_DB_PATH`;
identity defaults to `$AP_USER || "local"`).

1. In the companion chat, state something durable: *"My name is Doug and I prefer terse answers."*
2. Watch it save — the memory tool call is visible in the trace pane.
3. **Kill the process entirely** (Ctrl-C).
4. `just companion` again, new conversation: *"What's my name?"*

Pass = it answers from memory on turn one, without searching. That path is the recall tier
(auto-injected at conversation start), not a tool call.

Worth trying while you're there, because it's the exact gap ADR-0009 exists to close:
ask the same question with **different wording** than you saved it in. Identity facts saved
as `kind:"profile"` survive rephrasing (they're injected before search runs); other kinds
are lexical-match only and can miss. That miss is the motivating bug for Phase B routing.

Inspect the store directly if you want:

```bash
sqlite3 ~/.local/state/ap/memory.db "SELECT kind, content FROM memories LIMIT 10;"
```

---

## Test C — the free regression pass (no tokens)

```bash
cd ~/Projects/dug/agentic-patterns-ts
bun run check                                   # build + typecheck + lint + all suites
bun evals/memory-behavior/run.mts --dry         # exits 0; gate wiring only
just eval-memory                                # ⚠️ live model calls — real tokens
```

`bun run check` on merged `main` was green as of 2026-08-09, including the SQLite memory
smoke. The eval harness now runs against the **shipped** SQLite backend (not in-memory),
so a green run means something it didn't a day ago.

Note `--dry` skips live families and still prints a passing gate — read the skip count,
don't just read the exit code (a known sharp edge, called out in the #453 review).

---

## If you only have five minutes

Run **A1 → A2 → A3's first query**. Schedule fires → agent runs → the row says which
schedule caused it. That single query is the whole M2 milestone in one line of output.

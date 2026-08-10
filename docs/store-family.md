---
title: "The Store family — the framework's persistence & context layer"
description: "Locked plan naming every durable store (Conversation, Event, Run, Memory, Artifact), the ADK mapping, and the #118 → #116/#99 → #117 execution order."
sidebar:
  label: "The Store family"
---

> Status: **DESIGN / PLAN (LOCKED)** (2026-07-03). Post-investigation: every claim below was
> verified against the runtime source and the downstream consumer
> (`~/retrieval-agent-2.0/canvas-workstation`). Companion: `docs/node-context.md` (the runner +
> scratchpad threading tracks — **#116 / #99** — that aren't Stores but dissolve
> `with-persistence.ts`), `docs/agent-packages.md`, `docs/closed-composition.md`.

## The idea

Every **durable persistence** primitive is a **`Store`**: one naming convention (`<Noun>Store`),
one conceptual layer beside the runner/Node execution layer. This makes our persistence surface
legible against ADK's services and answers "do we cover ADK cleanly?" — we cover most, we named
them inconsistently, and two are genuine deferred gaps.

**A `Store` is a durable, injected service — chosen by DI at the composition edge.** The concept is
a **protocol**; the backend is an **impl**; the agent never knows which. This is the crux the
naming cleanup encodes:

```
ConversationStore                         ← the protocol (what agent/system code depends on)
  ├─ InMemoryConversationStore            ← impl: dev / CI / tests
  ├─ SqliteConversationStore              ← impl: single-node persistence
  └─ PostgresConversationStore            ← impl: prod
```

Same agent config; the composition root binds a different impl per environment (`provideDeps()` /
`depKey`). That is the "runs in-memory in dev, persists in prod" behavior — achieved by **injection,
not a runtime `if`**. Streaming is **not** a storage backend: it's live transport (`EventBus` +
`SSEExporter`); a store can be subscribed to but still has one durable backend. Don't conflate the
axes.

## The family (verified against current code)

| Store | Responsibility | Current state | ADK analog |
|---|---|---|---|
| **ConversationStore** | thread/session message + turn history (the dialogue you *replay*) | ✅ exists — protocol is **`ConversationStoreProtocol`**; in-mem impl **mis-named `MemoryStore`** (`conversation/store.ts:59,94`) | `SessionService` (`session.events`) |
| **EventStore** | raw event-stream log — every bus event → a row (SQLite) | ✅ exists — `storage/event-store.ts:94` + `SQLiteExporter` | ADK events (partial) |
| **RunStore** | aggregated **run records** — one row per run (tokens, step metrics, finish, status, trace) — the execution you *analyze* | ❌ **#117**. Extends `EventStore`; spec = canvas-workstation `EvalStore` **minus** its eval overlay | ADK eval/run logs (no clean 1:1) |
| **MemoryStore** | **cross-session recall** — search facts from past sessions into the current one | ✅ Phase 1 complete (#417–#422) — protocol **`MemoryStore`** + impls **`InMemoryMemoryStore`** (`memory/store.ts`) and **`SqliteMemoryStore`** (`memory/sqlite-store.ts`, FTS5/bm25, its OWN db file + `user_version` ladder, `loadMemoryStore()` soft-degrades); conformance kit `runMemoryStoreConformance` (`memory/conformance.ts`) is the portability contract (ADR-0007) and both impls pass it; agent surface `MemoryToolbox`/`memoryCapability` (`memory/toolbox.ts`) + turn-1 `assembleRecall` (`memory/recall.ts`). Compositional layer (ADR-0008 promotion/overlay) is Phase B | `MemoryService` |
| **ArtifactStore** | versioned **blob/file** storage tied to a run/session | ❌ **#120**, not built | `ArtifactService` |
| **ScratchpadStore** | run-scoped **shared context** (ephemeral, forked per branch) | ✅ exists as `Scratchpad`/`Slot` (`workflows/slot.ts`) — **not a durable store; naming alias only** | ADK `session.state` (partial) |

Convention going forward:
- **`<Noun>Store`** = the protocol / concept (`ConversationStore`, `MemoryStore`).
- **`InMemory<Noun>Store` / `Sqlite<Noun>Store` / `<Db><Noun>Store`** = impls.
- The bare noun NEVER names an impl — that's the `MemoryStore` mistake #118 fixes.

### ConversationStore vs RunStore — "replay" vs "analyze"

They're different axes; one thread contains many runs.

| | **ConversationStore** | **RunStore** |
|---|---|---|
| rows | **messages** (`StoredMessage`: request/response, parts, tokens — `conversation/store.ts:34`) | **one per invocation** (`RunRow`: final answer, tool_calls, iterations, tokens, finish_reason, elapsed, status, step_metrics + event stream + system prompt/agent config) |
| purpose | keep the agent coherent **across turns** — read back INTO the next prompt | let **you** debug / measure / eval a single execution |
| nature | **functional** (without it, amnesia) | **observational** (agent never reads it back) |
| read by | the agent, next turn | you / graders / the cockpit |

**Already linked in code, not redundant:** `StoredMessage.runId` (`conversation/store.ts:38`) stamps
each message with the run that produced it. **One conversation → many runs → each run emits
messages.** (ADK crams execution detail into session events; splitting "dialogue to replay" from
"execution to analyze" is one place we're arguably cleaner than ADK, and why #117 is its own store,
not a column on the conversation.)

### ScratchpadStore is a *naming alias*, not a durable store

`Scratchpad` is **ephemeral run-state whose `fork()`/`join()` is coupled to the Parallel/FanOut
combinators** — execution substrate, not an injected backend. It stays in `workflows/slot.ts`. It
gets a `ScratchpadStore` **type alias** for convention symmetry, but the fork/join mechanism does
**not** move into `stores/`. (It's also the *delegation-wide* run-context primitive — used by
Sequential/Parallel AND coordinator delegation; see `docs/node-context.md` #99.)

## Full ADK ⇄ us mapping (reference)

| ADK | Us | Note |
|---|---|---|
| `LlmAgent` (model + instruction + tools) | `Agent` / `AgentBuilder` | the definition |
| `Runner` (agent + services → run + persist) | **split:** `AgentRunner` (LLM loop) + `NodeRunContext` (carries services) + `AgencyRuntime` (multi-agent) | our Runner is the *executor half* |
| `SessionService` (+ InMemory/Database impls) | `ConversationStore` + impls | **#118** |
| `Session` object (`.events` + `.state`) | *(future)* `Session` aggregate | deferred wrapper — see below |
| `session.state` (ephemeral dict) | `Scratchpad` (`slot.ts`) | run-scoped, execution-coupled |
| `MemoryService` (semantic recall) | `MemoryStore` (freed by #118) | **#418** — protocol + in-memory impl + conformance kit; SQLite/toolbox later |
| `ArtifactService` (blobs) | `ArtifactStore` | **#120**, deferred |
| eval/run logs | `EventStore` *(have)* + `RunStore` *(#117)* | run aggregate; eval overlay later |
| **— no equivalent —** | **`Role`** = Persona + Judgments + Capabilities + Responsibilities | our extra layer; the subagent-consistency mechanism |

## The `Session` aggregate (deferred, ADK-Session-shaped)

There is **no "SessionStore."** ADK has two things: `SessionService` (the durable service =
our `ConversationStore`) and a `Session` object = one thread's `{ .events (conversation),
.state (scratchpad), ids }`. A `Session { conversation, scratchpad, id }` aggregate mirrors ADK 1:1
and is the natural home for "the shared context of a thread." **Deferred** because it's an aggregate
*over* primitives we're still standardizing, and it forces a lifecycle reconciliation (conversation
persists across turns; scratchpad dies each run — a persisted session-state store would be a distinct
future primitive). Named here so today's cleanup doesn't foreclose it.

---

## Execution plan (this session)

Order is **locked**. Runner/scratchpad detail lives in `docs/node-context.md`.

```
#118  (naming + stores/ module)   ──►   #116 + #99  (runner policy + scratchpad propagation)   ──►   #117 (RunStore)
        pure refactor, unblocker            the "every subagent configured/contextualized                extends EventStore
                                             the same declarative way" pair
```

### #118 — Store naming standardization + `stores/` module  *(do first)*

Pure refactor, gates-green, unblocks the rest. **Breaking API change** (renames exported symbols) →
needs a version bump + changeset. Release gotcha (from prior session): `rm bun.lock && bun install`
before publish or the lockfile-sanity gate fails.

- **Rename** `MemoryStore` → `InMemoryConversationStore` and `ConversationStoreProtocol` →
  `ConversationStore` in `conversation/store.ts` (`:59`, `:94`).
- **Update usages** (from grep): `conversation/index.ts`, `conversation/conversation.ts`,
  `streaming/stdio-adapter.ts`, `agent-server/src/config.ts`, `agent-server/src/index.ts`.
- **Barrel:** audit `packages/agent-runtime/src/index.ts` (surfaced via `conversation/index.ts`).
- **New `stores/` module** — `src/stores/index.ts` barrel that aggregates the durable family
  (`ConversationStore` + impls, `EventStore`, and #117's `RunStore`). Establishes the namespace;
  **physical file moves are optional** (keep the diff reviewable — a re-export barrel is enough for
  v1). Re-export a `ScratchpadStore` **type alias** here pointing at `workflows/slot.ts` (alias only).
- **No deprecated `MemoryStore` alias** — matches the project's breaking-change posture
  (see `atom-standardization-pass`).

### #116 + #99 — see `docs/node-context.md`

Both make "every subagent configured/contextualized the same declarative way." #116 = per-node
**runner** override + `withRunner()` subtree combinator (kills the `ctx.runner` closure hack).
#99 = **Design A** scratchpad+deps propagation across the agent-as-tool seam (opaque `host?: unknown`
on core `ToolExecutionContext`; `fork()` at the seam).

### #117 — RunStore (extends EventStore)

We already capture the **per-event** half: `EventStore` (`storage/event-store.ts:94`, `run_id` on
every row) + `SQLiteExporter`. #117 adds the **one-row-per-run aggregate** + run-list queries —
canvas-workstation's `EvalStore.run` table (mode/model/scope/arm → final_answer/tokens/iterations/
finish_reason/elapsed/status/step_metrics) **minus** the `eval_result` overlay.

- Consume `runEval`'s `onResult` seam (`eval/run-eval.ts:45`) and/or a bus-finish hook (`startRun` →
  attach event stream → `finishRun`).
- **`eval_result` + grading is deferred** until an eval system exists — we don't have one yet, so
  do NOT build an "EvalStore." The base substrate is runs + events + tools; eval grades ride on top
  later.
- Closing #116 + #117 collapses canvas-workstation `with-persistence.ts` to near-zero: its concerns
  map to `withRunner(pipeline, directGoogle)` (#116) + RunStore (#117) + an escalate-token-fold fix.

## Deferred-with-intent

Named, scoped, built only when a project actually needs them — documenting the chosen deferral is the
point (the persistence surface is now *explicit*):

- **#119 MemoryStore** — semantic cross-session recall (`write` / `search`, pluggable backend). YAGNI
  for search-deal-context (its "memory" is the dealbrain corpus via query-surface). For agent-system #2.
- **#120 ArtifactStore** — versioned blob storage. YAGNI for search-deal-context (text out, no binaries).
- **`Session` aggregate** — conversation + scratchpad + ids (ADK `Session`-shaped). Build when
  persisted session-state is needed.
- **AgentNode ↔ Node-world consolidation** — re-base `AgentNode`'s hand-rolled continuity onto
  `ConversationStore`. Depends on #118. See `docs/node-context.md`.

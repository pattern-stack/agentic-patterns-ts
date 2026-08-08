---
title: "ADR 0007 — MemoryStore: cross-session memory is a scoped, invalidation-first store protocol; backends differ in engine, never in contract"
---

- **Status:** PROPOSED — design review. Graduates #119 (deferred-with-intent, build trigger fired). Epic M1 #415, ambient-platform program #414.
- **Date:** 2026-08-06
- **Context owner:** Doug
- **Scope:**
  - `packages/agent-core` — `src/molecules/memory-record.ts` (new: `MemoryRecord`, `MemoryScope`, `MemoryHit`, `MemorySearchQuery` Zod schemas + factories); `src/atoms/base.ts` (widen `RenderContext` with `recall?`); `src/atoms/awareness.ts` (`fromRecall` instance render fn, mirroring `fromScope`).
  - `packages/agent-runtime` — `src/memory/` (new module: `store.ts` protocol + `InMemoryMemoryStore`, `sqlite-store.ts` `SqliteMemoryStore`, `toolbox.ts` `MemoryToolbox`, `recall.ts` recall assembler, `conformance.ts` exported conformance kit); `src/storage/load.ts` (`loadMemoryStore()`); `src/events/types.ts` (+3 event types, `AgentEvent` union); `src/transport/sse-formatter.ts` (4 coordinated edits) + `sse-event-manifest.json` regen; `src/events/event-profiles.ts`.
  - `packages/agent-dashboard` — client event union (drift test `src/__tests__/sse-events.drift.test.ts` enforces this).

## Context

We flatly lack cross-session memory (#119): write facts during a session, retrieve relevant ones into a later session. `Scratchpad` is run-scoped and ephemeral; `ConversationStore` is per-thread history; neither is recall. The build trigger recorded on #119 — *"build when a conversational agent / agent-system #2 needs to remember prior sessions"* — has fired: the ambient-platform program (#414) needs a coordinator agent that remembers users across sessions, and the production tier (a Postgres backend in codegen-patterns) must implement the same contract.

We surveyed the field before designing (Google ADK `memoryService`/Vertex Memory Bank, Letta/MemGPT, mem0, LangMem/LangGraph, Zep/Graphiti, ChatGPT memory, Anthropic's memory tool). The convergent findings, compressed:

**Table stakes** (every serious system): composite scoping keys; explicit CRUD + search as the base API; a write-time reconciliation story — append-only stores are considered broken for evolving facts; a two-tier split (small always-in-context profile + large on-demand store); provenance timestamps and host-visible management.

**Worth stealing:** Zep's time-invalidation instead of destructive overwrite (contradictions invalidate the old fact, audit trail survives); Letta's shareable memory attached across agents; LangMem's profile-vs-collection distinction; ADK's minimal two-method abstract core with optional extensions; ADK `preload_memory`'s formatting discipline (timestamped entries wrapped in a delimited block).

**Widely regretted:** graph memory as default (mem0's own paper shows ~2% gain; a plain file directory beat their graph variant on an independent LoCoMo run); automatic salience-decay math (no production system ships it); opaque auto-curation (ChatGPT's "Dreaming" drew criticism for shrinking the audit trail); LLM extraction in the hot path.

**ADK's specific gaps we will not copy:** no delete/forget on the interface at all; no memory lifecycle events; no top-k/filter parameters on search; unranked unbounded results from the reference in-memory impl; ingestion so manual that crash-before-save data loss is the community's top complaint.

In-repo constraints that shaped the design (verified this session):

1. **No framework identity key exists.** `SessionScope` is content-free by design (ADR-0005); `StoredConversation` carries only a UUID `id` + free-form `metadata`. Memory must define its own partition key and let the author bind it.
2. **The SQLite store ladder is the wrong home.** `EventStore → RunStore → EvalStore → SQLiteConversationStore` is a literal `extends` chain on one dev-telemetry file: all schema folded into `event-store.ts`, downgrade a hard throw, retention-pruned, lockstep-shipped. Memory is a system of record with the opposite lifecycle — and an external Postgres impl can implement a protocol but cannot inherit `EventStore`. `ScratchpadStore` is the documented opt-out precedent (docs/store-family.md).
3. **Render fns are a hard purity gate** (ADR-0005: no fetching inside a render fn). Recall must be resolved upstream and passed in via `RenderContext`.
4. **No conformance kit exists.** The two `ConversationStore` impls are tested by duplicated hand-written files, with at least one documented parity trap (`limit === 0`) nothing enforces. The SQLite↔Postgres portability promise for memory requires mechanical enforcement.
5. **The event vocabulary is triple-guarded at compile time** — adding event types requires the four coordinated `sse-formatter.ts` edits plus the dashboard drift test. Good: parity cannot silently rot.
6. **No FTS/vector precedent anywhere** — full-text search is net-new to the repo.

## Decision

1. **MemoryStore is a standalone protocol, not a ladder member.** It lives in a new runtime `memory/` module, modeled on the `ConversationStore` pattern (structural protocol + `InMemoryMemoryStore` beside it, `SqliteMemoryStore` separate), with its own SQLite file and its own `PRAGMA user_version` ladder starting at 1. It does not extend `EventStore`, does not touch `TARGET_SCHEMA_VERSION`, and is never retention-pruned. The store ladder contributes *mechanics* (driver-agnostic `.exec`/`.prepare` only, explicit `BEGIN`/`COMMIT`, `loadMemoryStore()` mirroring `load.ts` conventions including the bun named-param adapter) — not inheritance.

2. **The data contract lives in core; the machinery lives in runtime.** `MemoryRecord` is a Zod-validated, frozen value object in `core/molecules/memory-record.ts` — the `RenderArtifact` precedent exactly. Core placement lets the external Postgres implementation (codegen-patterns) type against the record without importing runtime.

3. **Scope is a flat string map with subset-match semantics.** A record's scope is `Record<string, string>` (e.g. `{ tenant: "acme", user: "u_42" }`), stored canonically (sorted keys). A search's scope filter matches every record whose scope contains all the filter's pairs — so `{ tenant: "acme" }` finds tenant-wide and per-user memories alike, giving namespace-like hierarchy without tuples. The framework does not invent identity: which fields form the scope is author-declared, typically read from `SessionScope` fields (ADR-0005). Exact-match-only scoping (ADK Memory Bank) is rejected — it is that system's top usability complaint.

4. **Curation is invalidation-first.** `write()` accepts an optional `supersedes: id`; the store atomically marks the superseded record `invalidAt: now` and links the chain. `invalidate(id)` exists on its own. Invalidated records are excluded from search by default (`includeInvalidated: true` opts in) but are never destroyed by curation — the audit trail survives, per Zep. `delete(id)` exists for true forgetting (privacy/host cleanup) and is deliberately **not** exposed to the agent toolbox.

5. **The search contract promises relevance ordering, never scores.** `search()` returns `MemoryHit[]` ordered by relevance with an optional backend-specific `score`. Backends differ in engine — SQLite reference uses FTS5/bm25; Postgres will use tsvector and/or pgvector — and declare power via `capabilities(): { search: "keyword" | "semantic" | "hybrid" }`. The conformance kit tests ordering behavior and filter semantics, not score values. `query` is optional: absent, search is a filtered, recency-ordered listing (unlike ADK, which cannot list).

6. **The protocol is small; extensions are explicit.**

   ```ts
   interface MemoryStore {
     write(inputs: MemoryWriteInput[]): Promise<MemoryRecord[]>;
     search(q: MemorySearchQuery): Promise<MemoryHit[]>;
     get(id: string): Promise<MemoryRecord | null>;
     invalidate(id: string, reason?: string): Promise<void>;
     delete(id: string): Promise<void>;
     capabilities(): MemoryStoreCapabilities;
   }
   ```

   All methods async (house rule). Anything beyond this (session auto-capture, batch import) arrives later as separate, optional interfaces — ADK's "two abstract methods, optional extensions throw" shape, minus the throwing: we use capability flags and separate interfaces instead of `NotImplementedError` surprises. [ADR-0008](0008-compositional-memory.md) defines the first such extension: store-resident promotion (`promote`/`demote`/`corroborate` + promotion rows), declared via `capabilities()` and pinned by the same conformance kit — promotion state is system-of-record data, so it lives here, not on the retention-pruned telemetry spine.

7. **The record is a fact with provenance and validity, not a scored embedding row.**

   ```ts
   MemoryRecord = {
     id: string;
     scope: Record<string, string>;
     kind: "fact" | "preference" | "episode" | "profile";
     content: string;                    // natural-language, prompt-ready
     tags?: string[];
     provenance?: { conversationId?: string; runId?: string; author?: string };
     createdAt: string; updatedAt: string;          // ISO 8601
     invalidAt?: string; supersededBy?: string;     // invalidation chain
     expiresAt?: string;                            // optional TTL (host-enforced)
     target?: MemoryTarget;                         // optional typed pointer into the
                                                    // agent's composition — see ADR-0008
     payload?: unknown;                             // structured form for structured
                                                    // targets — see ADR-0008
     supports?: Provenance[];                       // corroboration evidence — see ADR-0008
   }
   ```

   No confidence/salience fields and no decay function — the field's consensus regret. `kind: "profile"` is the two-tier answer: profile records are the small always-injected tier (LangMem's profile, Letta's blocks, flattened into the same store rather than a parallel block system).

   `target` is reserved now because it is breaking to add later: [ADR-0008](0008-compositional-memory.md) promotes matured memories out of the recall blob and *into* the agent's composition (a `Background` entry, a `Judgment` heuristic, an `Example`, an `Awareness` domain). In this ADR's scope, `target` is stored and returned untouched; untargeted records — all of v1 — behave exactly as described here. ADR-0008 also extends prompt-section attribution (`AgentPromptSectionData.source`) with a `"memory"` source carrying record ids, so learned prompt lines trace to the record — and through `provenance` — to the conversation that taught them.

8. **Two recall surfaces, both budget-capped.**
   - **Turn-1 injection (the `preload` analog):** the runtime host assembles recall *before* rendering — profile-kind records for the scope first, then `search(firstUserText, scope)` hits — caps it by a character budget, and passes the finished block via `RenderContext.recall`. Core renders it through an `Awareness.fromRecall` instance fn, mirroring `Awareness.fromScope` (ADR-0005's prompt seam; no new `Section` subclass). Truncation is marked, never silent (house rule, events/types.ts byte-cap precedent). Character budget, not tokens: model-agnostic, deterministic, and what OpenClaw/Hermes ship.
   - **On-demand toolbox (the `load_memory` analog):** `MemoryToolbox` with `memory_save`, `memory_search`, `memory_list`, `memory_invalidate` — built with `defineTool` (typed args, validated returns), Manual carrying a standing "you have memory" instruction (ADK precedent) and the curation protocol (save with `supersedes` when correcting a fact — Letta-style self-editing).

9. **Scope binds at instantiate time, not tool-call time.** `MemoryToolbox` is delivered per-conversation via the instantiate seam (ADR-0004) with the partition scope captured at construction. This sidesteps the known ADR-0005 limit that CC-runner tools don't see `host.scope`, and means a memory tool cannot write outside its conversation's partition even if the model asks it to.

10. **Memory is observable.** Three event types — `agent.memory.write`, `agent.memory.search`, `agent.memory.recall` (the injection event: counts, byte size, truncated flag) — added through all four `sse-formatter.ts` guards, the manifest, event profiles, and the dashboard union. ADK ships zero memory observability; our event spine is a differentiator and we use it.

11. **The conformance kit is the portability contract.** `runMemoryStoreConformance(makeStore)` — an exported vitest `describe`-factory covering write/search/scope-subset/invalidation/ordering/limit semantics, with optional sub-suites keyed by capability flags. `InMemoryMemoryStore` and `SqliteMemoryStore` both run it in-repo; the codegen-patterns Postgres subsystem imports and runs the same kit. This is the first conformance kit in the repo; the `ConversationStore` parity trap is the cautionary precedent for why it is not optional.

12. **v1 writes are explicit only.** The agent (or host code) writes memories deliberately; there is no automatic extraction pipeline in the framework hot path. Session auto-capture and background consolidation are Phase-2 concerns that belong to the jobs/scheduler tier (codegen-patterns) and the AgencyHost lifecycle (program M3) — and LLM-driven reconciliation, when it comes, arrives as a composable Judgment/Play above the store, not inside it.

## Recall assembly (the one place budget lives)

Render purity means the renderer never fetches. The flow:

```
runner/host (runtime)                          core (pure)
─────────────────────                          ───────────
scope = readScopeAs<...>(ctx)
profile = store.search({scope, kinds:["profile"]})
hits    = store.search({query: userText, scope, limit})
block   = capToBudget(profile ⊕ hits, chars)   ──►  RenderContext.recall
emit agent.memory.recall {count, bytes, truncated}
                                               Awareness.fromRecall renders block
```

`renderContinuation` is untouched in v1 — recall injects at turn 1 only; the toolbox covers mid-conversation needs. Per-turn re-injection (ADK `preload_memory` style) is a known limit, revisited when AgencyHost lands.

## Consequences

**Good**

- One protocol, three backends (in-memory dev, SQLite reference, Postgres production) with parity enforced mechanically, not by discipline. The SQLite→Postgres path the platform promises is a conformance run, not a rewrite.
- Invalidation-first curation gives contradiction handling and an audit trail without a graph, an extraction LLM, or destructive overwrites — the highest-value ideas from Zep/Memory Bank at a fraction of their machinery.
- The agent surface (toolbox + Manual protocol) and the ambient surface (turn-1 recall) compose from existing seams — instantiate (ADR-0004), scope (ADR-0005), Awareness render fn — with zero new section types and zero render impurity.
- Memory events make recall inspectable in the dashboard from day one; "what did it remember and why" is a query, not a mystery.

**Costs / risks**

- FTS5 is net-new to the repo and must hold under both bun:sqlite and better-sqlite3 through the `.exec`/`.prepare`-only contract; the conformance kit needs to run under both drivers.
- A second SQLite file (memory is not on the telemetry file) means one more path to configure and back up. Deliberate: memory must not inherit telemetry retention/pruning or its downgrade-hostile versioning.
- Subset-match scoping is more powerful than exact-match and therefore easier to misuse (an empty filter matches everything). The conformance kit pins the semantics; the toolbox never exposes an unscoped search.
- Character budgets are a blunt instrument versus token budgets; accepted for determinism and model-independence.

**Known limits, stated rather than hidden**

- No semantic/vector search in the reference backend — keyword FTS only. The capability flag exists precisely so the Postgres/pgvector backend can exceed the reference without breaking the contract.
- No automatic capture: a session that never calls `memory_save` leaves no memory. This is ADK's top community complaint and we ship v1 with it anyway — the fix (lifecycle-hooked capture + background extraction) needs the daemon and jobs tiers, which are later program milestones.
- Recall injects at turn 1 only; long conversations rely on the toolbox.
- Multi-agent sharing is by overlapping scope only — no Letta-style attach-by-reference blocks in v1.
- `expiresAt` is stored and filtered on read; nothing sweeps expired rows in v1 (no scheduler in the framework tier).

## Rejected alternatives

- **Join the EventStore ladder (SCHEMA_V6).** Forces a global version bump on every ladder consumer, couples memory to telemetry retention and downgrade-throw semantics, and cannot be mirrored by an external Postgres impl. Wrong lifecycle, wrong coupling.
- **LLM extraction/reconciliation inside the store.** mem0's pipeline is real but belongs above the store (as a Judgment/Play in this framework), and hot-path extraction is a documented regret elsewhere. The store stays deterministic and cheap.
- **Graph memory.** ~2% measured gain in mem0's own paper; beaten by a file directory in independent testing; Anthropic ships a literal folder as their memory product. Earn-in threshold not met; the protocol does not preclude a graph-backed implementation later.
- **Salience scores + decay.** No surveyed production system ships automatic decay; expiry + invalidation cover forgetting without speculative math.
- **Token-budgeting inside the renderer.** Violates the ADR-0005 purity gate and would drag a tokenizer into core. Budgeting happens where the data is fetched.
- **A separate pinned-block subsystem (Letta blocks).** `kind: "profile"` + always-inject-first gives the two-tier behavior with one store and one protocol; a block system can be layered later if profile records prove insufficient.
- **Exact-match scope (ADK Memory Bank).** Its best-documented usability failure; subset-match is strictly more useful and conformance-testable.

## Follow-ups

1. **[ADR-0008 — Compositional memory](0008-compositional-memory.md):** the layer above this store — matured memories compile into the agent's composition (typed `target`s, `applyMemoryOverlay`, tiered promotion gates, the evolution ledger). This ADR is its substrate; nothing here changes when 0008 lands.
2. **Phase 2 — capture & consolidation:** session auto-capture on conversation close (AgencyHost lifecycle, program M3), background reconciliation as a Play (mem0 ADD/UPDATE/INVALIDATE/NOOP shape, invalidation-first), expiry sweeping via the jobs tier.
3. **Phase 3 — production backend:** codegen-patterns `memory` subsystem (drizzle/Postgres, tsvector; pgvector unlocks `search: "semantic"`), importing the conformance kit. Un-parks the knowledge-family vector stub.
4. **Dashboard:** a memory lens (recall events already carry counts/bytes/truncation).
5. Sibling #120 (`ArtifactStore`) remains separate and unblocked by this ADR.

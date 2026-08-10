---
title: "Memory — developer guide"
description: "How to wire a MemoryStore into an agent: scoping from SessionScope, the memory toolbox, turn-1 recall, save policy, and Phase 1 vs unbuilt Phase B limits."
---

> **Status: PHASE 1 SHIPPED** (#417–#422) — the store, its in-memory and SQLite/FTS5 backends, the
> conformance kit, the memory events, the agent toolbox, and the turn-1 recall surface are
> implemented and exported. The **compositional layer (ADR-0008)** — promotion, `applyMemoryOverlay`,
> demotion, the gardening pass, `lintComposition`, `memory_learnings` — is **Phase B, not built**.
> Sections describing it are marked **(Phase B)** and state intended behavior, not shipped code.

How to give an agent cross-session memory: wire a store, scope it, let the agent read and write
it, and — when a memory has earned it — compile it into the agent's composition. Sources:
[ADR-0007](../adr/0007-memory-store.md) (the store) and
[ADR-0008](../adr/0008-compositional-memory.md) (the compositional layer). The questions this guide
originally had to guess at are settled below in
[design questions](#design-questions-surfaced-while-writing-this) — each marked RESOLVED with what
shipped, or still flagged open for Phase B/C.

## The mental model

Two layers, one store.

**The store (ADR-0007)** is a scoped, invalidation-first system of record. A `MemoryRecord` is a
natural-language fact with provenance and validity — no embeddings, no salience scores, no decay
math. Records are partitioned by a flat string-map **scope** (`{ tenant: "acme", user: "u_42" }`)
with subset-match search semantics, and curated by **invalidation**, never destructive overwrite:
correcting a fact writes a new record with `supersedes`, and the old one survives as an audit
trail. The store reaches the agent through two surfaces:

- **Turn-1 recall** — before the first render, the host assembles a budget-capped block
  (profile records first, then search hits against the first user message) and injects it via
  `RenderContext.recall`. The agent is *told* what it remembers.
- **The toolbox** — `memory_save` / `memory_search` / `memory_list` / `memory_invalidate`, bound
  to the conversation's scope at instantiate time. The agent *manages* what it remembers.

**The compositional layer (ADR-0008)** is what no other surveyed framework has. This framework's
agent anatomy is typed — `Background` is what the agent knows, `Judgment` is how it decides,
`Example` is what has worked, `Awareness` is what it can find out. A memory record may carry a
typed `target` naming one of those slots. Once such a record is **promoted**, `applyMemoryOverlay`
folds it into the `AgentConfig` at the instantiate seam: a learned project fact renders under the
same `Background` heading as authored context; a lesson from a failed run compiles into an
`Example` on the relevant `Judgment`. The agent doesn't read its diary each morning — **it wakes
up already changed.**

That gives every memory one of two standings:

| Tier | Where it appears | What the agent experiences |
|---|---|---|
| **Recall tier** | The turn-1 recall block + toolbox search results | "Here is what you remembered" — visibly memory, quoted at the agent |
| **Promoted tier** | Compiled into the composition via `applyMemoryOverlay` | Indistinguishable from authored config in the prompt — part of the self |

Every untargeted record lives in the recall tier forever, and that's fine — most memories are
session-relevant context, not identity changes. A *targeted* record starts as a **candidate**
(recall tier, `target` attached as a proposal) and moves to the promoted tier only through a
gated promotion act. In the tooling the two tiers stay fully distinguishable: promoted lines
carry `source: "memory"` attribution with `memoryIds`, so "why does the agent believe X?"
resolves prompt line → record → `provenance.conversationId` → the conversation that taught it.

## Quickstart

### 1. Wire a store

`loadMemoryStore()` follows the `load.ts` optional-dep convention: durable SQLite when a driver
is available (`bun:sqlite` under Bun, `better-sqlite3` under Node), otherwise you fall back to
the in-memory store yourself. Memory gets **its own SQLite file** — it is a system of record, not
telemetry, and must never inherit the event store's retention pruning.

```typescript
import { loadMemoryStore } from "@agentic-patterns/runtime";

// `store` is ALWAYS usable — when `unavailable` it is already the
// InMemoryMemoryStore fallback; `reason` says why (CLI-banner material).
const { store, unavailable, reason } = await loadMemoryStore({ path: "./data/memory.sqlite" });

await store.capabilities(); // { search: "keyword" } — the SQLite reference backend is FTS5/bm25
```

The protocol is six methods, all async:

```typescript
interface MemoryStore {
  write(inputs: MemoryWriteInput[]): Promise<MemoryRecord[]>;
  search(q: MemorySearchQuery): Promise<MemoryHit[]>;
  get(id: string): Promise<MemoryRecord | null>;
  invalidate(id: string, reason?: string): Promise<void>;
  delete(id: string): Promise<void>;   // true forgetting — never exposed to the agent
  capabilities(): Promise<MemoryStoreCapabilities>;
}
```

Any backend that passes `runMemoryStoreConformance(makeStore, options?)` — an exported vitest
`describe`-factory — honors the same contract. That's the whole portability story: the
SQLite→Postgres path is a conformance run, not a rewrite. The kit has two tiers: **Tier 1** is
universal, **Tier 2** is keyed on what `capabilities()` declares and pins *match semantics* for
every `search: "keyword"` backend. See [Limits](#limits-v1) for exactly what each tier pins, and
for the one thing deliberately left unpinned.

### 2. Scope it from SessionScope

The framework does not invent identity. You declare a `SessionScope` (ADR-0005) as usual, then
decide which of its fields form the memory partition key. Keep that mapping in one named
function — it is the single most consequential decision you'll make (see
[recall tuning](#recall-tuning) for the patterns it unlocks).

```typescript
import { SessionScope, scopeItem, type ScopeValue } from "@agentic-patterns/core";
import { z } from "zod";

const supportScope = new SessionScope({
  tenant: scopeItem(z.string().min(1), { description: "Tenant slug" }),
  user: scopeItem(z.string().min(1), { description: "Acting user id" }),
  tier: scopeItem(z.enum(["free", "pro", "enterprise"])),
});

type SupportScope = ScopeValue<typeof supportScope>;

/** Which scope fields partition memory. `tier` deliberately excluded — it's
 *  an input, not an identity, and a tier upgrade must not orphan memories. */
function memoryScope(s: SupportScope): Record<string, string> {
  return { tenant: s.tenant, user: s.user };
}
```

### 3. Attach the toolbox at the instantiate seam

`MemoryToolbox` captures its partition scope **at construction**, which is why it belongs inside
your `instantiate` hook (ADR-0004): a memory tool physically cannot write outside its
conversation's partition, even if the model asks it to. No tool takes a `scope` parameter, and no
unscoped search is reachable.

The packaging is deliberately two-piece: `MemoryToolbox` is a plain `Toolbox` (tools only), and
`memoryCapability(store, scope, opts)` is the ready-made bundle — that toolbox plus a built-in
`TextManual` carrying the standing "you have memory" instruction and the curation protocol (save
with `supersedes` when correcting). Use the capability helper unless you want to compose the
Manual yourself (see [deciding what to remember](#deciding-what-to-remember)).

```typescript
import { AgentBuilder, Awareness } from "@agentic-patterns/core";
import { MemoryToolbox } from "@agentic-patterns/runtime";

function buildSupportAgent(s: SupportScope) {
  const memory = new MemoryToolbox({ store, scope: memoryScope(s) });

  return new AgentBuilder(buildSupportRole(memory))
    // Renders RenderContext.recall when the host supplies it; silent otherwise.
    // The `fromScope` sibling — no new Section subclass, no render impurity.
    .withAwareness(Awareness.fromRecall())
    .withMission(supportMission)
    .build();
}

export default {
  id: "support",
  name: "Support",
  agent: buildSupportAgent(DEFAULT_SCOPE),
  scope: supportScope,
  instantiate: async (context?: Record<string, unknown>) =>
    buildSupportAgent(supportScope.parse({ ...DEFAULT_SCOPE, ...(context ?? {}) })),
};
```

Note `delete` is not in the toolbox — the agent can invalidate (audit trail survives) but never
truly forget; forgetting is a host/privacy operation you call on the store directly.

### 4. Enable turn-1 recall

Render purity is a hard gate: the renderer never fetches. The **host** assembles recall before
rendering and passes the finished block in. Self-hosting the runner, that looks like:

```typescript
import { assembleRecall } from "@agentic-patterns/runtime";

const recall = await assembleRecall(store, memoryScope(s), {
  query: firstUserText,     // optional — without it, profile + recency listing only
  budgetChars: 4_000,       // character budget, deterministic and model-agnostic
});
// Profile-kind records first, then search hits; capped; truncation marked, never silent.
// Emits agent.memory.recall { count, chars, truncated } — only when the `emit` option is wired.

const prompt = agent.renderInitialPrompt({ scope: s, recall: recall.block });
```

Under the server, recall assembly is the host's job at **first-message time** — the first user
text is the search query, so assembly waits for it rather than running at conversation creation.
The registration seam shipped in #444: a registration declares
`memory: { store, scope, budgetChars? }` (the scope as a static string map or a function of the
conversation's parsed context, resolved once at creation), and `POST /conversations/:id/messages`
assembles recall on the first turn and sets it on the conversation's host bag — both runners
narrow `host.recall` into the `RenderContext` alongside `host.scope`. Recall injects at
**turn 1 only** in v1; mid-conversation needs go through the toolbox.

**The one invariant the seam cannot check for you:** `memory.store` must be the SAME instance
your `instantiate` hook binds into `memoryCapability`, and `memory.scope` must derive the SAME
partition that hook binds. They are two independent author-supplied declarations — if they
diverge, every toolbox write succeeds and every recall comes back empty, with no error anywhere.
Keep both in one named function (the `memoryScope(s)` pattern above) and pass it to both seams.

Everything above is observable from day one: `agent.memory.write`, `agent.memory.search`, and
`agent.memory.recall` flow through the standard event spine to exporters and the dashboard.

### 5. Try it — the companion demo

The repo ships a first-party memory-wired agent: **companion**
(`agents/companion/agent.mjs` + the `buildCompanionAgent` preset). It binds the persistent
default store (`$AP_MEMORY_DB_PATH` | `~/.local/state/ap/memory.db`) and pairs the scope-bound
toolbox with the #444 turn-1 recall wiring over the same store instance.

```bash
just companion          # build + ap playground with the companion discovered
```

Then, in the dashboard chat:

1. Tell it something durable — *"remember: I take espresso, no milk"* — and watch
   `agent.memory.write` land in the event stream.
2. Kill the playground, start it again, open a **fresh** conversation.
3. Ask *"what do I drink?"* — the recall block arrives at turn 1
   (`agent.memory.recall` appears in the chat stream with counts/chars/truncated) and the
   answer comes from memory.

Identity: `AP_USER` names the partition's `user` key (default `"local"`); per-conversation
override via `POST /conversations` with `context: { user: "guest" }`. The reserved
`agent: "companion"` key (ADR-0008 D8) keeps companion-specific records out of other agents'
recall, while `user`-only records stay shared across your agents.

**Which runner you resolve matters for step 1** (playground env contract: `AGENT_MODEL` /
`AGENT_TIER` / provider keys): with a provider key — e.g. `ANTHROPIC_API_KEY` — you get
`AgentRunner` and the full event vocabulary, `memory_save` included. The bare **claude-CLI
fallback** (no keys) still SAVES and RECALLS correctly, but executes tools without a
`ToolExecutionContext`, so `agent.memory.write`/`.search` don't emit — and it runs with native
CC tools disabled, so it is not the "capable daily driver" profile. The `agent.memory.recall`
event in step 3 is route-emitted and appears on every runner.

## Deciding what to remember

Memory is the *fourth* place context can live, and it is the most expensive one — every record
is a future recall candidate competing for a character budget. Route information to the cheapest
home that serves it:

| You have… | Put it in… | Why |
|---|---|---|
| Who this run acts for (tenant id, user id, plan tier, region) | `SessionScope` | The host already knows it, validated per conversation. Inputs are not learnings. |
| Stable truths known at authoring time (team conventions, project facts) | Authored `Background` | Authored config always wins over memory; don't launder authorship through the store. |
| What was said earlier in *this* conversation | Conversation history | It's already in context. A memory restating the transcript is pure budget waste. |
| Intermediate working state during a run | `Scratchpad` | Run-scoped and ephemeral by design. |
| A durable fact learned in-session about a user/tenant/project | `MemoryStore` — `kind: "fact"` or `"preference"` | This is exactly what memory is for. |
| What happened and what it taught you | `MemoryStore` — `kind: "episode"` | Recallable now; promotable into an `Example` later. |
| The five-line always-relevant summary of a user | `MemoryStore` — `kind: "profile"` | Injected first every session, before any search runs. Keep it tiny. |
| A learning that should change how the agent *behaves*, not just what it's told | A record with a `target` | Candidate for promotion into the composition — see the next section. |

### Choosing a kind

| `kind` | Use for | Recall behavior |
|---|---|---|
| `fact` | Atomic, declarative, still-true-next-week statements | Search-ranked |
| `preference` | User/tenant tastes and choices | Search-ranked |
| `episode` | Outcomes: what was tried, what happened, the lesson | Search-ranked; the raw material for `example` targets |
| `profile` | The compact standing summary of a scope | Always injected first, ahead of search hits — the two-tier "small always-in-context" tier |

Rules of thumb that survive contact with real stores:

- **One fact per record.** `search` ranks records, not sentences; a paragraph of five facts is
  recalled all-or-nothing and superseded all-or-nothing.
- **Write content that stands alone.** `content` is prompt-ready natural language. "The user
  prefers the second option" is garbage a week later; "Dana prefers staging deploys announced in
  #ops before they start" survives.
- **Correct, don't accumulate.** A contradiction means a `write` with `supersedes` — the store
  atomically invalidates the old record and links the chain. Two live contradictory records is a
  curation failure the gardening pass will flag at you.
- **Set a `target` only when the memory should change the agent.** Most memories inform sessions;
  they need no target. Target the ones that are really rules, examples, settled background, or
  discovered sources — and accept that a target is a *proposal*, not a promotion.
- **Keep `profile` records brutally short.** They spend recall budget in every single session of
  their scope, before relevance ranking gets a vote.

### Writing the Manual that makes the agent save well

v1 has **no automatic capture** — a session that never calls `memory_save` leaves no memory. The
quality of your agent's memory is therefore mostly the quality of the standing instructions you
give it. The `MemoryToolbox` Manual carries the baseline ("you have memory", the `supersedes`
protocol); layer your domain's save policy on top:

```typescript
import { TextManual } from "@agentic-patterns/core";

const memoryManual = new TextManual(
  "memory-policy",
  [
    "You have persistent memory scoped to this user. What you recalled at the start of this",
    "conversation is already in your context — do not search for it again.",
    "",
    "Save a memory (memory_save) when you learn something durable:",
    "- a preference the user states or demonstrates ('always cc legal on renewals'),",
    "- a fact about their environment that will still be true next week,",
    "- the outcome of an approach you tried — what worked, what failed, and why.",
    "",
    "Do NOT save:",
    "- anything already visible in this conversation or in your recall block,",
    "- secrets, credentials, or tokens of any kind,",
    "- transient state ('the build is currently red'),",
    "- restatements of instructions you were just given.",
    "",
    "Write one fact per record, in plain declarative language that makes sense without this",
    "conversation. Before saving something you suspect you already know, memory_search first.",
    "When new information contradicts an existing memory, save the correction with `supersedes`",
    "set to the old record's id — never leave both standing.",
  ].join("\n"),
);
```

The failure modes to write against are asymmetric: an agent that saves too little just stays
forgetful; an agent that saves transcript restatements poisons its own recall budget in every
future session. Bias the instructions toward *selective* saving, and let the gardening pass
catch duplicates rather than relying on it.

## Targets and promotion

A `target` is a typed pointer into the agent's anatomy — a discriminated union naming the slot a
matured memory should compile into:

```typescript
type MemoryTarget =
  | { primitive: "background"; section: "teamContext" | "projectContext"
                                      | "conventions" | "currentState"; key: string }
  | { primitive: "judgment";   domain: string;
      slot: "heuristics" | "constraints" | "escalationTriggers" }  // latter two guarded-tier
  | { primitive: "example";    judgmentDomain: string }  // compiles to an Example on that Judgment
  | { primitive: "awareness" }                           // compiles to an AwarenessDomain
  | { primitive: "recovery" }                            // guarded-tier
  | { primitive: "manual";     capability: string; section: "workflows" };  // later phase
```

The union ships **whole** (`molecules/memory-record.ts`, #417) even though only some arms are
promotable — widening a stored record's schema later is breaking, so the guarded and later-phase
arms are storable from day one. In Phase 1 the target is stored and returned untouched; nothing
acts on it.

**Structured targets carry a structured `payload`, not prose to be parsed.** `example` and
`awareness` declare their required shapes as Zod schemas beside the record
(`ExampleTargetPayloadSchema` = `{ scenario, good, bad?, reasoning? }`,
`AwarenessTargetPayloadSchema` = `{ name, description, accessMethod }`), validated on write by
`MemoryRecordSchema`'s refinement. `content` stays prompt-ready prose alongside. A structured-arm
record with **no** payload is still valid — it is a candidate that simply cannot promote. Prose
arms (`background`, `judgment`, `recovery`, `manual`) carry their learning in `content` and their
payload is never validated.

```typescript
await store.write([
  {
    scope: { tenant: "acme" },
    kind: "fact",
    content: "Staging deploys freeze on the last business day of each month.",
    target: { primitive: "background", section: "conventions", key: "deployFreeze" },
  },
  {
    scope: { tenant: "acme" },
    kind: "episode",
    content:
      "Escalating a P1 without checking the status page first duplicated an incident thread; " +
      "checking status.acme.dev first avoided it the next three times.",
    target: { primitive: "judgment", domain: "triage", slot: "heuristics" },
  },
]);
```

A targeted record is a **candidate**: it reaches the agent through the recall surfaces like any
other record — visible *as memory* — until promotion moves it into the overlay.

> **(Phase B)** Everything from here to the end of this section — promotion tiers, the gate chain,
> `applyMemoryOverlay` — is ADR-0008 and **not implemented**. Phase 1 ships the *data contract*
> (`target`, structured `payload`, `supports`) and the write-time nudge; no promotion machinery
> exists. `MemoryStore` deliberately has no `promote`/`demote`/`corroborate` methods yet.

Promotion is tiered by blast radius:

| Tier | Targets | Bar to promote |
|---|---|---|
| **Auto** | `background.*`, `awareness` domains | Written + reconciled. No approval; audited via events. |
| **Earned** | `judgment.heuristics`, `example` | Recurrence (≥N supporting episodes, default N=2) **or** eval-pass (suite green on `config′`), through the gate chain. |
| **Guarded** | `judgment.constraints`, `escalationTriggers`, `recovery` | Human approval (`HumanApprovalGate`) — these change what the agent refuses or escalates. |
| **Locked (v1)** | `persona`, `tone`, `methodology`, `mission`, *new* judgment domains | Not promotable. Identity is authored. |

Note the asymmetry in the target union: v1 targets can only *append* heuristics to an **existing**
judgment domain — a memory may not create a new domain. Structural change is reserved for humans.

Promotion runs as a Play through the gate chain; the earned tier's thresholds
(`recurrenceThreshold`, whether eval-gating is required) are Play configuration. Eval-gated
promotion is the differentiating loop: because agents are pure config, the Play can run your eval
suite against `config` and `config′` and require non-regression before a learned heuristic
sticks. Self-improvement becomes measured, reviewable, and reversible — not "edit MEMORY.md and
hope."

At each instantiate, `applyMemoryOverlay(config, records)` — a pure core function — folds the
scope's *promoted, valid* records into the authored `AgentConfig`:

- **Authored config always wins.** A learned `background` entry colliding with an authored key is
  dropped from the overlay and flagged by lint — never overwrites.
- Merge rules per primitive: `background` entries insert under their section keyed by `key`;
  `judgment` heuristics and `example`s append to the existing judgment with matching domain;
  `awareness` domains append.
- Conflicts between learned records resolve by `createdAt` (older wins) and are reported, never
  silently dropped.
- The stored authored `AgentConfig` is **never mutated**. The overlay is a derived view,
  recomputed each instantiate from the store's current valid records — which is exactly what
  makes rollback a one-liner (next section).

**A candidate that never promotes is not a bug.** It stays recall-tier forever: still findable,
still injected when relevant, just never part of the self. That is the correct failure mode —
slow growth beats bad growth.

## Recall tuning

### Budgets

Recall is capped by a **character** budget — deterministic and model-agnostic, deliberately not
tokens. Assembly order is fixed: profile records for the scope first, then search hits against
the first user text, cut at the budget with truncation *marked* in the block and reported on the
`agent.memory.recall` event (`{ count, chars, truncated }`). Watch that event in the dashboard:
a permanently-true `truncated` flag means your profile tier has bloated or your agents save too
liberally — fix the write side before raising the budget.

### Profile records

`kind: "profile"` is the two-tier answer without a separate block subsystem: the small
always-injected tier. Maintain at most a handful per scope, and prefer *replacing* a profile
record (`supersedes`) over accumulating several — they all spend budget before relevance ranking
applies to anything else.

Because the tier is unconditional it is also unconditional *cost*, so it carries its own slice:
`AssembleRecallOptions.profileBudgetChars`, defaulting to `DEFAULT_PROFILE_BUDGET_RATIO` (0.4) of
`budgetChars`. Profile records are admitted newest-first until the slice is spent; the rest are
**deferred, not dropped** — they still count toward the block's truncation marker, and one may
still enter through the hits tier if the query earns it. Without this slice a bloated profile
partition silently starves the tier that answers the user's actual question, and starves it worst
in exactly the sessions where the store has learned the most. Raising the slice is the wrong
first move: a persistently-truncated block means the write side is over-saving profiles.

### Scoping patterns

Search filters use **subset-match**: a filter matches every record whose scope contains all of
the filter's pairs. Narrower filters match fewer records; a record's extra scope keys never
exclude it from broader filters.

```typescript
// Personal memory: written and read at { tenant, user }.
await store.search({ query: q, scope: { tenant: "acme", user: "u_42" } });

// Team-shared memory: written at { tenant } only — matched by ANY filter
// that includes tenant: "acme"... including other users' filters. See below.
await store.write([{ scope: { tenant: "acme" }, kind: "fact", content: "…" }]);
```

The subtlety: subset-match composes *downward*, not sideways. A filter of `{ tenant: "acme" }`
matches tenant-wide records **and every user's personal records** in that tenant — there is no
way to say "records scoped *exactly* `{ tenant }`". So the common "shared + mine, but not
theirs" recall needs a convention plus two searches:

```typescript
// Convention: shared records carry an explicit audience key.
await store.write([{ scope: { tenant: "acme", audience: "team" }, kind: "fact", content: "…" }]);

// Recall = union of two subset filters:
const mine = await store.search({ query: q, scope: { tenant: "acme", user: "u_42" } });
const ours = await store.search({ query: q, scope: { tenant: "acme", audience: "team" } });
```

(This is awkward enough to be question 7 below.) Two guardrails regardless of pattern: an empty
filter matches **everything** — the toolbox never exposes an unscoped search, and your host code
shouldn't either — and scope values are canonical sorted-key strings, so pick stable ids
(`u_42`), not display names.

### includeInvalidated

Invalidated records are excluded from search by default. Pass `includeInvalidated: true` to see
the full chain — superseded versions, invalidation reasons — for audit, debugging, and "what did
it used to believe" queries. Never enable it on the recall path; recall is for current truth.

Omitting `query` entirely turns `search` into a filtered, recency-ordered listing — that's what
backs `memory_list` and your admin surfaces.

## Evolution operations (Phase B)

> Not implemented. `agent.memory.promote` / `.demote` / `.overlay` events and the
> `memory_learnings` tool do not exist in Phase 1 — the shipped events are
> `agent.memory.write` / `.search` / `.recall` (#420) and the shipped toolbox has four tools
> (#421). `store.invalidate(id, reason)` *is* shipped and behaves as described below; what is
> missing is the overlay that would recompile as a result.

### Reading the ledger

Every change to what an agent *is* emits a typed event through the standard spine:

- `agent.memory.promote` / `agent.memory.demote` — a record entered/left the promoted tier, with
  human-readable content and provenance.
- `agent.memory.overlay` — per-instantiate summary: record count, bytes per primitive,
  dropped-conflict count. This is the heartbeat; alert on a dropped-conflict count that stops
  being zero.

Because overlays are derived views over invalidation-first records, the ledger fully determines
history: **which records were valid + promoted at time T fully determines the composition at
time T.** Point-in-time reconstruction is a replay, not an archaeology project.

### Communicating learnings

"What did you learn this week?" is a query, not a feature: promote events since T, each carrying
content and provenance. Agents get the same view via the toolbox's `memory_learnings`, so an
agent can *tell the user* how it has changed — with every claim traceable to the conversation
that taught it.

### Rolling back a bad learning

```typescript
await store.invalidate(recordId, "heuristic caused over-escalation of routine tickets");
// Shipped: the record is excluded from every subsequent search and recall.
// (Phase B) The next instantiate also recompiles without it — no migration, no config surgery.
```

**(Phase B)** Demotion will mirror promotion automatically: an invalidated record leaves the overlay
at the next instantiate and emits `agent.memory.demote`. If the record was superseded rather than
plainly wrong, prefer the `supersedes` write — the correction and the retirement land in one atomic
act and the chain records *why*.

### Answering "why does the agent believe X?"

Prompt fragments carry attribution: `source: "role" | "instance" | "memory"`, with `memoryIds`
on memory-derived fragments. The chain is mechanical: prompt line → `memoryIds` → record →
`provenance.conversationId` / `runId` → the stored conversation. The dashboard's section
attribution surface (Playground lens) renders it. No surveyed memory system has line-level
attribution; use it — it is what makes letting agents evolve tolerable.

## Governance (Phase B)

> Not implemented. `applyMemoryOverlay`, `lintComposition`, and the gardening pass are ADR-0008.
> The one governance mechanism that *is* live in Phase 1 is the toolbox's write-time nudge:
> a second `memory_save` with the same scope + same target returns a structured conflict envelope
> instead of silently duplicating (#421).

Agents must grow naturally, not malignantly. Three mechanisms, all mandatory in the design:

### Budgets

`applyMemoryOverlay` enforces per-primitive character budgets. An over-budget record **falls back
to the recall tier** — never silently discarded — and truncation is marked. A composition-wide
ceiling triggers a hard lint failure long before you hit context limits. If lint starts failing,
the fix is curation (below), not raising the ceiling.

### Contradiction conflicts

Promotion into a judgment slot requires a reconciliation search over the same domain first. A
candidate that contradicts an existing heuristic or constraint **cannot auto-promote** — it
surfaces as a conflict with two resolutions:

- **Agent-proposed:** the candidate supersedes the old record (invalidation chain, audit trail
  intact), and promotion re-runs clean.
- **Human pick:** curation UI/review chooses which survives.

Authored-vs-learned conflicts never reach a choice: authored wins, always, and the collision is
reported. Be honest with yourself about the detection quality — it is lexical/search-grade, not
semantic proof. It narrows the window; gardening and human review close it.

### The gardening pass

A periodic curation pass — a Play, run on the jobs tier in production, invocable manually in the
framework tier. It **proposes**; the same gate tiers approve. No opaque auto-rewriting — that is
the documented trust failure this design exists to avoid. One pass:

- dedupes near-identical records and proposes merges for fragmenting entries,
- proposes invalidation of stale `currentState`-targeted facts,
- re-runs evals on earned-tier promotions (a heuristic that no longer passes gets flagged),
- emits the composition health report.

### Reading lintComposition output

`lintComposition` is the health report backing the gardening pass and your CI:

| Section | What it tells you | What to do |
|---|---|---|
| Size per primitive | Overlay chars per slot vs budget | Approaching budget → curate before promotion stalls; ceiling breach is a hard failure |
| Conflict list | Authored-key collisions + learned-vs-learned conflicts | Collisions with authored keys mean the agent keeps re-learning something you already wrote — either author it properly or fix the target key |
| Unused-recall stats | Records that never surface in recall | Candidates for invalidation; also a signal your agent saves things nothing ever asks about |
| Staleness candidates | Old `currentState` facts, expired-adjacent records | Approve the proposed invalidations or refresh the facts |

## Limits (v1)

Stated rather than hidden, mirroring the ADRs:

- **No automatic capture.** A session that never calls `memory_save` leaves no memory. Lifecycle-
  hooked capture and background extraction need the daemon/jobs tiers (later milestones). Your
  Manual is the capture mechanism — write it accordingly.
- **Keyword search only in the reference backends** (FTS5/bm25). No semantic/vector search until
  the Postgres/pgvector backend; the `capabilities()` flag exists so it can exceed the reference
  without breaking the contract.

  **Match semantics are now pinned across backends — this bullet used to say the opposite.** It
  read: *"Match granularity differs between reference backends and is deliberately NOT pinned by
  the conformance kit … Only relevance ORDERING and the filter semantics are contractual — develop
  against the backend you ship on."* That was true and it was a bug, not a feature: the shipped
  companion runs on SQLite/FTS5 while every test and eval ran on `InMemoryMemoryStore`, and the two
  disagreed in **opposite** directions — in-memory matched SUBSTRINGS (`am` hit `name`, `prefer`
  hit `Prefers`) and split the query on whitespace only (so `name?` matched nothing), while FTS5
  matched whole tokens, split on punctuation and folded diacritics (`cafe` hit `café`). "Develop
  against the backend you ship on" is not advice a library can give about its own reference
  implementations. [ADR-0009](../adr/0009-memory-routing-and-background-composition.md) settled it
  (constraint D-3, Decision 13) and both backends changed.

  What **is** pinned, by `runMemoryStoreConformance`:

  | Tier | Applies to | Pins |
  |---|---|---|
  | 1 — universal | every backend | filtering (scope subset-match, `kinds`, `tags`), invalidation chains, `limit` semantics including `limit: 0`, the `updatedAt`-only-on-invalidate rule, the recency listing, more-matching-tokens-first (for non-semantic backends — a `semantic` backend may rank a conceptually closer record above one with more literal token overlap), and the **batch tie** |
  | 2 — per `capabilities().search` | every backend declaring `keyword` | **identical match SETS** over one shared corpus: word boundaries, punctuation, case, diacritics, one-character tokens, tags-as-haystack, and multi-token OR |

  Both reference backends call one exported `tokenize()` — lowercase → NFD → drop combining marks
  → split on every non-letter/non-number. No stemming and **no stopword list**, mirroring FTS5's
  `unicode61`: `prefer` does *not* match `prefers` on either backend, and `the` matches everything
  containing it. The batch tie matters more than it sounds: every backend assigns one `now` per
  batch, so `write([a,b,c])` ties all three on `createdAt`, and a `limit: 2` listing used to return
  *different records* per backend. Last written now wins, everywhere.

  What is **not** pinned, deliberately: **total rank order** for a query search. In-memory ranks by
  matched-token count then recency, FTS5 by bm25, a Postgres backend would use `ts_rank`. Pinning
  total order would force a bm25 reimplementation into the in-memory store and would then fail the
  `ts_rank` backend — relocating the divergence instead of removing it. Assert on match sets and on
  the Tier 1 ordering invariants; do not assert on positions 3-vs-4 of a relevance list.

  Also not pinned: **non-Latin diacritic and combining-mark parity**. The match-set pin holds for
  Latin-1-class content (ASCII, Latin-1, Latin Extended-A, NFD-normalized Latin); outside it the
  shared `tokenize()` (NFD + strip combining marks) and FTS5's `unicode61` are known to diverge —
  Vietnamese diacritics (`tieng` matches `Tiếng` in-memory, zero rows on SQLite), Greek tonos,
  Cyrillic breve, and Hebrew/Arabic combining marks (separators to `unicode61`, stripped by
  `tokenize()`). Non-Latin corpora should be developed against the backend you ship on.
- **The hits tier misses when wording does not overlap.** Recall's search tier passes the first
  user message verbatim as `query`, and the reference backends match it lexically — so a stored
  `fact` reading "The user's name is Doug" is returned for *"what's my name?"* and **not** for
  *"who am I?"*. There is no zero-hit fallback to the recency listing, which makes passing a query
  strictly worse than passing none when the phrasings diverge. The block's own framing line
  ("most relevant first") promises more than lexical matching delivers. `kind: "profile"` is the
  v1 answer for anything that must survive rephrasing — it is injected before search runs and is
  therefore phrasing-proof; `fact`/`preference`/`episode` are not. Retrieval quality on the
  shipped path is unowned work, not a resolved design.
- **Recall injects at turn 1 only.** Long conversations rely on the toolbox; per-turn
  re-injection waits for AgencyHost.
- **Multi-agent sharing is by overlapping scope only** — no attach-by-reference memory blocks.
  Per-agent partitioning uses the reserved `agent` scope key, applied as a client-side post-filter;
  its documented cost is that **a page may return fewer than `limit` hits** when foreign-agent
  records occupied slots (no over-fetch compensation in v1).
- **`expiresAt` is filtered at read; nothing sweeps expired rows** (no scheduler in the framework
  tier). Expired records are excluded from `search` unconditionally but still returned by `get`.
- **The whole compositional layer is Phase B** — no `applyMemoryOverlay`, no promotion or
  demotion, no gardening pass, no `lintComposition`, no `memory_learnings`. A `target` is stored
  and returned untouched; nothing acts on it yet.
- **Promotable targets (Phase B) will be `background`, `awareness`, `judgment.heuristics`,
  `example` only.**
  Constraints/escalation/recovery are human-gated; persona, tone, methodology, mission, and *new*
  judgment domains are not promotable at all.
- **No skill synthesis.** A learned procedure lands as prose (`manual.workflows`, later phase)
  before it ever lands as executable code.
- **Contradiction detection is search-grade, not semantic.** Gardening + human review are the
  backstop.
- **Character budgets are blunt** versus token budgets; accepted for determinism.
- **CC-runner attribution is limited** to what the prompt carries; the ledger stays complete
  server-side.

## Design questions surfaced while writing this

Writing this guide as if the system existed forced concrete answers the ADRs don't give. Every
item below is one of those gaps, marked **RESOLVED** with what shipped in #417–#422 (or in the
PR #416 decision round) — or still **OPEN**, deferred to Phase B/C.

1. **RESOLVED (decision round) — where "promoted" lives: in the store, not the ledger.**
   Promotion state is store-resident, so `applyMemoryOverlay` gets the bounded per-instantiate
   query it needs; ledger replay was rejected as too expensive per instantiate. Phase 1 ships the
   record fields this rests on (`target`, structured `payload`, `supports`) precisely because
   widening a stored record later is breaking. The promotion *columns and operations*
   (`promote`/`demote`/`corroborate`) are Phase B and deliberately absent from the `MemoryStore`
   protocol today. **Still open (Phase B):** whether promotion is a record field or a side table.

2. **RESOLVED (#418, #421) — `MemoryWriteInput` is pinned, and the model *may* propose targets.**
   `MemoryWriteInputSchema` = `{ scope, kind, content, tags?, provenance?, target?, payload?,
   supersedes? }`. The store assigns `id`, `createdAt`, `updatedAt` (equal at birth); everything
   lifecycle-owned — `invalidAt`, `supersededBy`, `expiresAt`, `supports` — is **not** writable on
   a write. Writes are all-or-nothing per batch: an invalid input or an unknown `supersedes` id
   rejects the whole batch with no mutation. Through `MemoryToolbox` there is no `scope` parameter
   at all (bound at construction), but `memory_save` **does** expose `target` to the model — an
   agent can propose its own promotion target, which is safe precisely because a target is a
   proposal that Phase 1 stores and ignores.

3. **RESOLVED (#422) — the runtime assembler owns formatting.** `RenderContext.recall` is a
   finished string; core only *places* it. `Awareness.fromRecall(fn?, base?)` mirrors `fromScope`
   and defaults `fn` to identity, so the zero-arg form renders the assembled block verbatim. The
   hook is instance-carried with a `replace()` override, so `withDomain`/`withDomains`/
   `withCapabilities` preserve it; absent `ctx.recall`, rendering is byte-identical to pre-recall.
   This is what keeps render purity (ADR-0005) intact — the renderer never fetches.

4. **RESOLVED (#422) — the knob is `AssembleRecallOptions.budgetChars`**, default
   `DEFAULT_RECALL_BUDGET_CHARS = 4000`, applied to the *whole* block (header and truncation
   marker included). Server-registration wiring remains open — question 5.

5. **OPEN (Phase C) — the server-path memory seam.** Nothing tells the server a registration
   *has* memory: no `memory: { store, scope, budget }` registration field exists, and whether a
   store error should fail conversation creation (like `instantiate`'s 502) or degrade to no
   recall is undecided. Phase 1 ships the assembler and pins **who calls it and when** (question
   19); the self-hosted path in the quickstart is the only wired path.

6. **OPEN (Phase C) — SessionScope → memory scope stringification.** Memory scope is
   `Record<string, string>`; SessionScope fields can be any Zod type. It remains an ad hoc
   per-registration mapping function, declared nowhere machine-readable. Phase 1 only pins the
   *storage* side: scope is canonicalized to sorted-key form (`canonicalMemoryScope`), so pick
   stable ids.

7. **PARTIALLY RESOLVED (#421/#422) — the reserved `agent` key is blessed; exact-scope querying
   is not.** ADR-0008 D8's reserved `agent` scope key now has a shipped convention: a record is
   visible to agent `me` when its scope's `agent` key is unset (shared) or equals `me`, applied as
   a client-side post-filter (`matchesAgentConvention`) by both the toolbox and the recall
   assembler — a runtime helper, not a store change. **Documented v1 consequence:** a page may
   return fewer than `limit` hits when foreign-agent records occupied slots; there is no
   over-fetch compensation. The general problem — no "scope is exactly X" or "key absent"
   operator, so `{ tenant }` still over-matches every user's personal records — is **still open**;
   the `audience: "team"` sentinel plus two-search union remains the workaround.

8. **RESOLVED (decision round, data contract in #417/#422) — recurrence evidence is an explicit
   corroboration array.** `MemoryRecord.supports?: Provenance[]` (ADR-0008 D4) records supporting
   occurrences on the record itself, rather than counting near-duplicate writes (which would fight
   dedupe-on-write). It is lifecycle-owned — not settable on `write`; a Phase B `corroborate`
   operation appends to it. The "a candidate that never surfaces can never be corroborated"
   chicken-and-egg is answered by `assembleRecall`'s `pinCandidates` option: up to N valid targeted
   records, newest first, are pinned between the profile tier and the hits tier. It defaults to
   `0` (off) — the hook exists; the promotion machinery that would use it is Phase B.

9. **OPEN (Phase B) — threshold and eval-suite wiring for promotion Plays.** Where `N` lives, how
   a promotion Play locates the agent's eval suite, and whether eval-gating is an alternative to
   recurrence or an additional requirement, all remain unspecified. Nothing in Phase 1 depends on
   the answer.

10. **RESOLVED (decision round, enforced at write in #421) — conflicts are supersede-first, so
    older-wins rarely arbitrates.** The fix moved *upstream* of the overlay: `memory_save`
    detects a near-duplicate targeted collision in the same scope + same target and returns a
    structured conflict envelope demanding the agent either supersede the existing record or
    re-key — it never silently writes the duplicate. Two live contradictory targeted records is
    now a state the write path resists, rather than one the overlay has to referee. Older-wins
    survives only as a determinism tiebreak of last resort (Phase B).

11. **RESOLVED (#417) — structured targets carry a structured payload; nothing parses prose.**
    `ExampleTargetPayloadSchema` (`{ scenario, good, bad?, reasoning? }`) and
    `AwarenessTargetPayloadSchema` (`{ name, description, accessMethod }`) are declared beside the
    record and enforced by `MemoryRecordSchema`'s refinement on write. The shapes mirror the atoms
    they compile into as *input* shapes, declared rather than imported, so the data contract stays
    free of atom coupling. A structured-arm record with no payload stays valid — it just cannot
    promote. This is what lets the Phase B fold be pure and deterministic.

12. **OPEN (Phase B) — `applyMemoryOverlay`'s return shape.** It must carry a report
    (`{ config, conflicts, spilled, … }`) since a pure core function cannot emit events, but the
    exact shape and its translation into `agent.memory.overlay` are unspecified. Not built.

13. **OPEN (Phase B) — the ledger needs a named durable home.** `memory_learnings` is not shipped
    (the toolbox has four tools), and the `MemoryStore` protocol still has no event-history API.
    Phase 1 sharpens the constraint rather than solving it: memory deliberately got **its own
    SQLite file** with its own `user_version` ladder, never the retention-pruned `events.db` — so
    whatever the ledger's home turns out to be, it will not inherit telemetry retention.

14. **RESOLVED (decision round) — the removal bar equals the addition bar.** Invalidating a
    *promoted* guarded-tier record requires the same gate that promoted it; an agent cannot
    unilaterally strip a human-approved constraint from its own overlay via `memory_invalidate`.
    Enforcement is Phase B (there is no promoted tier yet to protect). Phase 1's contribution is
    that `delete` is host-only and absent from the toolbox — the agent can never destroy the
    evidence, only invalidate it.

15. **PARTIALLY RESOLVED (#418/#419) — expiry semantics are pinned; the ledger interaction is not.**
    Expired records (`expiresAt <= now`) are excluded from `search` unconditionally — even with
    `includeInvalidated: true` — while `get(id)` still returns them for host management. Nothing
    sweeps expired rows. Whether expiry on a *promoted* record must emit a demote event (or be
    banned outright) is **still open** for Phase B.

16. **OPEN (Phase B) — `lintComposition` invocation and failure semantics.** Where a ceiling
    breach fails (instantiate? CI? the gardening report only?), and the function's input and
    output schemas, are all unspecified. Not built.

17. **RESOLVED (#420/#422) — chars for budgets, bytes only for previews.** Budget units are
    **characters end-to-end**; `agent.memory.recall` reports `{ count, chars, truncated }`. The
    only bytes anywhere are the standard house-rule preview caps (512 B, marked when clipped) on
    event payloads, which are a log-hygiene concern rather than a budget. The dashboard therefore
    never shows two competing budget units.

18. **RESOLVED (#421) — `MemoryToolbox` is a `Toolbox`; `memoryCapability()` is the bundle.**
    The toolbox ships tools only; `memoryCapability(store, scope, opts)` wraps it with a built-in
    `TextManual` carrying the standing instruction and save policy. Authors who want to compose
    their own Manual use the toolbox directly. Tool names (`memory_save` / `memory_search` /
    `memory_list` / `memory_invalidate`) were checked against the play-collision guidance for the
    SDK-bridge path.

19. **RESOLVED (#422) — recall assembles at first-message time, not conversation creation.**
    The pinned ordering is **instantiate → bind → first user message → `assembleRecall` → render**.
    The host calls the assembler when the first user text exists to serve as `query`, then passes
    `result.block` via `RenderContext.recall` into `renderInitialPrompt({ scope, recall })`. This
    is documented in the module docblock as well as here, because getting it wrong yields an empty
    query and a silently degraded recall block rather than an error.

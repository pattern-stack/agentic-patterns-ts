# How agents evolve: worked examples

> **Status: DESIGN PREVIEW** — behavior specified in ADR-0007/ADR-0008; not yet implemented. These scenarios exist to pressure-test the design.

This cookbook follows five agents over days and weeks and shows the full causal chain of
each learning, concretely: the interaction that triggered it, the `MemoryRecord` written
([ADR-0007](../adr/0007-memory-store.md)), the tier path it took through the promotion
gates ([ADR-0008](../adr/0008-compositional-memory.md)), the resulting composition diff in
the *actual* render formats of the atoms, and how the change stays visible — ledger events
and the "what did you learn this week?" query.

Conventions used throughout:

- Record ids (`mem_9f2e71`), conversation/run ids, and event payload fields beyond what the
  ADRs pin down are **illustrative**. The record shape, scope semantics, invalidation
  chain, tier table, and event *names* are normative per the ADRs.
- Recall blocks are rendered by `Awareness.fromRecall` (ADR-0007 §8); the exact block
  format is not yet specified, so the delimited/timestamped shape shown here (ADK
  `preload_memory` discipline) is a plausible rendering, not a contract.
- Prompt fragments are shown exactly as the atoms render them today
  (`Background.toPrompt()`, `Judgment.toPrompt()`, `Example.toPrompt()`,
  `AwarenessDomain.toPrompt()`), because ADR-0008 adds **zero** schema or rendering
  changes to atoms — memory lands under the same headings as authored content.

---

## Scenario 1 — Compass learns the project (background, auto tier)

**Agent:** Compass, the PM/coordinator for project *Atlas* (tenant `acme`).
**Memory scope (author-declared):** `{ tenant: "acme", project: "atlas", agent: "compass" }`.
**Window:** two weeks, three sessions. This is the easy path: `background.*` targets are
**auto tier** — written + reconciled, no approval, everything audited via events.

### Day 1 (Mon) — a fact arrives in conversation

> **Doug:** Heads up for planning — deploys go out **Tuesdays after 14:00 ET** now, and
> staging freezes Friday noon. Don't schedule anything that fights that.
> **Compass:** Noted — I'll plan reviews to land Mondays. Saving that so I don't ask again.

Compass calls `memory_save` (MemoryToolbox, ADR-0007 §8). The record written:

```json
{
  "id": "mem_9f2e71",
  "scope": { "agent": "compass", "project": "atlas", "tenant": "acme" },
  "kind": "fact",
  "content": "Deploys go out Tuesdays after 14:00 ET; staging freezes Friday noon.",
  "tags": ["release-process"],
  "provenance": {
    "conversationId": "conv_5d1c04",
    "runId": "run_b8377a",
    "author": "agent:compass"
  },
  "createdAt": "2026-08-10T15:22:31Z",
  "updatedAt": "2026-08-10T15:22:31Z",
  "target": {
    "primitive": "background",
    "section": "projectContext",
    "key": "deploy_window"
  }
}
```

### Tier path

```
written (agent.memory.write)
  → reconciliation search over scope + section: no duplicate, no conflict
  → AUTO tier: promoted immediately, no approval (agent.memory.promote)
  → next instantiate: applyMemoryOverlay folds it into config′ (agent.memory.overlay)
```

Bar cleared: "written + reconciled" — the auto tier's entire bar (ADR-0008 Decision 4).
No gate pauses it; the gate chain's audit tier still records the promotion.

On **Day 4**, the same path runs for a second fact
(`mem_c22d80`, target `{ "primitive": "background", "section": "teamContext", "key": "qa_signoff" }`,
content "QA signoff on Atlas releases is owned by Priya (Slack: @priya).").

### Composition diff

Compass's authored `Background` before any memory (Day 0 instantiate):

```markdown
## Project Context

- **repo**: pattern-stack/atlas
- **tracker**: Linear team ATL
```

Day 5 instantiate — `applyMemoryOverlay(config, records)` inserts the promoted entries
under their sections, keyed by `key`. Authored keys always win on collision; these keys are
new, so both land. `Background.toPrompt()` renders memory lines identically to authored
ones:

```markdown
## Team Context

- **qa_signoff**: QA signoff on Atlas releases is owned by Priya (Slack: @priya).

## Project Context

- **repo**: pattern-stack/atlas
- **tracker**: Linear team ATL
- **deploy_window**: Deploys go out Tuesdays after 14:00 ET; staging freezes Friday noon.
```

Indistinguishable in the prompt; fully distinguishable in tooling —
`renderSections()` tags these fragments `source: "memory"` with
`memoryIds: ["mem_9f2e71"]` / `["mem_c22d80"]` (ADR-0008 Decision 3).

### Day 9 (week 2) — the fact changes

> **Doug:** Deploy day moved — we're on **Thursdays** now, same 14:00 cutoff.
> **Compass:** Updating my notes — Thursdays it is.

Curation is invalidation-first: Compass saves the correction **with `supersedes`**
(the Manual's curation protocol, ADR-0007 §8), never editing in place:

```json
{
  "id": "mem_a04b19",
  "scope": { "agent": "compass", "project": "atlas", "tenant": "acme" },
  "kind": "fact",
  "content": "Deploys go out Thursdays after 14:00 ET; staging freezes Friday noon.",
  "tags": ["release-process"],
  "provenance": {
    "conversationId": "conv_88f3e2",
    "runId": "run_11c9d5",
    "author": "agent:compass"
  },
  "createdAt": "2026-08-19T09:41:07Z",
  "updatedAt": "2026-08-19T09:41:07Z",
  "target": {
    "primitive": "background",
    "section": "projectContext",
    "key": "deploy_window"
  }
}
```

The store atomically closes the chain on the old record:

```json
{
  "id": "mem_9f2e71",
  "invalidAt": "2026-08-19T09:41:07Z",
  "supersededBy": "mem_a04b19",
  "...": "(all other fields unchanged — audit trail survives)"
}
```

Demotion mirrors promotion automatically: the invalidated record leaves the overlay at the
next instantiate; the successor (auto tier, reconciled) takes its place. The
`deploy_window` bullet now reads `Thursdays` — no migration, no config surgery.

### Visibility

Ledger events over the two weeks (payloads illustrative beyond the fields ADR-0008 names):

```jsonc
{ "type": "agent.memory.write",   "recordId": "mem_9f2e71" }
{ "type": "agent.memory.promote", "recordId": "mem_9f2e71", "tier": "auto",
  "target": "background.projectContext.deploy_window", "bar": "written+reconciled" }
{ "type": "agent.memory.overlay", "records": 1, "bytesPerPrimitive": { "background": 78 },
  "droppedConflicts": 0 }
// ... same trio for mem_c22d80 ...
{ "type": "agent.memory.write",   "recordId": "mem_a04b19", "supersedes": "mem_9f2e71" }
{ "type": "agent.memory.promote", "recordId": "mem_a04b19", "tier": "auto" }
{ "type": "agent.memory.demote",  "recordId": "mem_9f2e71", "reason": "superseded" }
{ "type": "agent.memory.overlay", "records": 2, "bytesPerPrimitive": { "background": 161 } }
```

> **Doug:** What did you learn this week?
> **Compass** (via the `memory_learnings` view — promote events since Monday, each with
> content + provenance): Two things stuck: **(1)** deploys moved to Thursdays after 14:00 ET
> — this replaced what I'd learned on Aug 10; **(2)** Priya owns QA signoff. Both are now
> part of my standing project context. Source conversations: conv_5d1c04, conv_88f3e2.

---

## Scenario 2 — Sable earns a heuristic (judgment, earned tier via recurrence)

**Agent:** Sable, a code-review agent with an authored judgment:

```markdown
## Judgment: code-review

**Heuristics:**
- Prefer small, focused diffs; ask for a split above ~400 changed lines.
- Missing tests on changed behavior is a blocker, not a note.
```

**Scope:** `{ tenant: "pattern-stack", repo: "agentic-patterns-ts", agent: "sable" }`.
`judgment.heuristics` is **earned tier**: recurrence (≥ 2 supporting episodes, the default
N) *or* eval-pass, through the gate chain. This scenario shows the recurrence path — and
crucially, the first occurrence **not** changing the composition.

### Day 1 (Aug 11) — first occurrence: candidate only

Sable approves PR #431, which adds an SSE event type. CI fails after approval: the
dashboard drift test.

> **Doug:** You approved #431 but the drift test failed — new event types need the four
> coordinated `sse-formatter.ts` edits plus the manifest regen. That's bitten us before;
> worth remembering.
> **Sable:** Understood — recording it. I'll treat missing formatter guards as a blocker
> on event-type PRs.

```json
{
  "id": "mem_e41c92",
  "scope": { "agent": "sable", "repo": "agentic-patterns-ts", "tenant": "pattern-stack" },
  "kind": "fact",
  "content": "PRs adding SSE event types must include all four coordinated sse-formatter.ts guard edits plus sse-event-manifest.json regen; approving without them fails the dashboard drift test.",
  "tags": ["sse", "events", "review-miss"],
  "provenance": {
    "conversationId": "conv_2b90aa",
    "runId": "run_f0d31c",
    "author": "agent:sable"
  },
  "createdAt": "2026-08-11T18:03:44Z",
  "updatedAt": "2026-08-11T18:03:44Z",
  "target": { "primitive": "judgment", "domain": "code-review", "slot": "heuristics" }
}
```

**Tier path so far:** `candidate` — full stop. A `target` is a *proposal*, not a promotion
(ADR-0008 Decision 1). One supporting episode < N=2, so the promotion Play holds it.

**Where it lives meanwhile — recall, not composition.** Next session (Aug 14, another
event-type PR), the host's turn-1 recall assembly (`search(firstUserText, scope)`) matches
the record, and `Awareness.fromRecall` injects it:

```markdown
## Recalled Memory

<recall>
[2026-08-11] (fact) PRs adding SSE event types must include all four coordinated
sse-formatter.ts guard edits plus sse-event-manifest.json regen; approving without
them fails the dashboard drift test.
</recall>
```

The `## Judgment: code-review` section renders **byte-identical to the authored version
above** — two heuristics, unchanged. The agent *sees* the memory (narrated, visibly a
memory); it has not *become* the memory.

### Day 9 (Aug 19) — second occurrence: promotion

PR #447 adds another event type; the recall line primes Sable, which catches the missing
manifest regen at review time instead of at CI time, and writes a supporting episode:

```json
{
  "id": "mem_b7d05f",
  "scope": { "agent": "sable", "repo": "agentic-patterns-ts", "tenant": "pattern-stack" },
  "kind": "episode",
  "content": "PR #447: caught missing sse-event-manifest.json regen at review time; same failure class as PR #431.",
  "tags": ["sse", "events", "supports:mem_e41c92"],
  "provenance": {
    "conversationId": "conv_c31e77",
    "runId": "run_a9028b",
    "author": "agent:sable"
  },
  "createdAt": "2026-08-19T14:17:20Z",
  "updatedAt": "2026-08-19T14:17:20Z"
}
```

(The `supports:` tag is one plausible linkage convention — see open question 3.)

**Tier path:**

```
candidate (1 episode, Aug 11)
  → recall-tier only; surfaced via Awareness.fromRecall
  → second supporting episode (Aug 19) → recurrence bar met (N=2)
  → promotion Play runs through the gate chain (SafetyGate + audit; earned tier
    needs no human approval)
  → contradiction check: reconciliation search over domain "code-review" — no conflicts
  → PROMOTED (agent.memory.promote, tier "earned", bar "recurrence:2")
```

### Composition diff

Next instantiate, `applyMemoryOverlay` appends to the *existing* judgment with matching
`domain` (memory may not create a new judgment domain in v1):

```markdown
## Judgment: code-review

**Heuristics:**
- Prefer small, focused diffs; ask for a split above ~400 changed lines.
- Missing tests on changed behavior is a blocker, not a note.
- PRs adding SSE event types must include all four coordinated sse-formatter.ts guard edits plus sse-event-manifest.json regen; approving without them fails the dashboard drift test.
```

The recall line for `mem_e41c92` no longer needs to appear — the record is now part of the
self, not the diary. The new bullet's fragment carries
`source: "memory", memoryIds: ["mem_e41c92"]`.

### Visibility

```jsonc
{ "type": "agent.memory.write",   "recordId": "mem_e41c92" }          // Aug 11
{ "type": "agent.memory.recall",  "count": 1, "bytes": 214, "truncated": false } // Aug 14
{ "type": "agent.memory.write",   "recordId": "mem_b7d05f" }          // Aug 19
{ "type": "agent.memory.promote", "recordId": "mem_e41c92", "tier": "earned",
  "bar": "recurrence:2", "target": "judgment.code-review.heuristics" }
{ "type": "agent.memory.overlay", "records": 1, "bytesPerPrimitive": { "judgment": 187 } }
```

> **Doug:** What did you learn this week?
> **Sable:** One rule graduated: I now treat missing SSE formatter guards + manifest regen
> as a review blocker on event-type PRs. It took two occurrences (PR #431 taught it,
> PR #447 confirmed it) — it's in my judgment now, not just my notes.

---

## Scenario 3 — Mercury compiles a failure into an Example (earned tier via eval-pass)

**Agent:** Mercury, a migration-author agent with judgment domain `schema-changes` and an
eval suite of 9 migration-scenario cases.
**Scope:** `{ tenant: "acme", project: "atlas", agent: "mercury" }`.

### Aug 13 — the failed episode

Mercury ships a migration that drops a `NOT NULL` column in the same step that deploys the
code change. Old app instances crash-loop during the rolling deploy; the release is rolled
back. Postmortem excerpt:

> **Doug:** The failure was sequencing — old pods were still writing that column while the
> migration dropped it. Expand/contract: make the column nullable, deploy, *then* drop in
> a later migration.
> **Mercury:** Confirmed — that ordering was the whole failure. Compiling this one into an
> example so the next migration review starts from it.

Mercury writes the episode with an `example` target. `Example` needs
`scenario`/`good`/`bad`/`reasoning`, but `content` is a single prompt-ready string — this
scenario uses labeled lines the compiler must parse (see open question 4):

```json
{
  "id": "mem_5c88f0",
  "scope": { "agent": "mercury", "project": "atlas", "tenant": "acme" },
  "kind": "episode",
  "content": "Scenario: removing a NOT NULL column still written by live code during a rolling deploy.\nGood: expand/contract — make the column nullable, deploy the code that stops writing it, drop the column in a later migration.\nBad: drop the column in the same release that removes the writes; old pods crash-loop mid-rollout (Aug 13 incident, release 2026.08.13).\nWhy: during a rolling deploy both code versions run against one schema; the schema must stay valid for both until the fleet converges.",
  "tags": ["migrations", "incident"],
  "provenance": {
    "conversationId": "conv_9a44d1",
    "runId": "run_63be0f",
    "author": "agent:mercury"
  },
  "createdAt": "2026-08-13T21:10:52Z",
  "updatedAt": "2026-08-13T21:10:52Z",
  "target": { "primitive": "example", "judgmentDomain": "schema-changes" }
}
```

### Tier path — the eval gate

`example` is earned tier. There is no second occurrence (one incident is enough *if the
eval suite proves the lesson helps*), so the promotion Play takes the **eval-pass** path
(ADR-0008 Decision 7): build `config′ = applyMemoryOverlay(config, [mem_5c88f0])` and run
the suite on both.

| Eval case (`schema-changes` suite)          | `config` | `config′` |
|---------------------------------------------|:--------:|:---------:|
| add nullable column                          | pass     | pass      |
| add column with default (large table)        | pass     | pass      |
| rename column, two-phase                     | pass     | pass      |
| **drop column under rolling deploy**         | **fail** | **pass**  |
| **tighten constraint on live table**         | **fail** | **pass**  |
| add index concurrently                       | pass     | pass      |
| backfill batching                            | pass     | pass      |
| enum value addition                          | pass     | pass      |
| destructive change without backup note       | pass     | pass      |

`config` 7/9 → `config′` 9/9: non-regression *and* improvement. Bar cleared: **eval-pass**,
through the gate chain (audited, no human approval required for earned tier).

```
candidate (Aug 13)
  → promotion Play: eval suite on config vs config′ → 7/9 vs 9/9
  → contradiction check over domain "schema-changes": clean
  → PROMOTED (agent.memory.promote, tier "earned", bar "eval-pass:7/9→9/9")
```

### Composition diff

Before (authored judgment, no examples):

```markdown
## Judgment: schema-changes

**Heuristics:**
- Every migration must be reversible or explicitly marked destructive.

**Constraints (never violate):**
- Never run destructive migrations without a verified backup.
```

After the next instantiate — the episode is now few-shot, rendered by `Example.toPrompt()`
under the judgment's `**Examples:**` block:

```markdown
## Judgment: schema-changes

**Heuristics:**
- Every migration must be reversible or explicitly marked destructive.

**Constraints (never violate):**
- Never run destructive migrations without a verified backup.

**Examples:**
- **Scenario:** removing a NOT NULL column still written by live code during a rolling deploy.
  - ✓ expand/contract — make the column nullable, deploy the code that stops writing it, drop the column in a later migration.
  - ✗ drop the column in the same release that removes the writes; old pods crash-loop mid-rollout (Aug 13 incident, release 2026.08.13).
  - *Why:* during a rolling deploy both code versions run against one schema; the schema must stay valid for both until the fleet converges.
```

Episodic memory, **compiled** — not retold. The agent is not shown a war story each
morning; the failure is now a few-shot example in the slot where migration decisions are
made.

### Visibility

```jsonc
{ "type": "agent.memory.write",   "recordId": "mem_5c88f0" }
{ "type": "agent.memory.promote", "recordId": "mem_5c88f0", "tier": "earned",
  "bar": "eval-pass:7/9→9/9", "target": "example.schema-changes" }
{ "type": "agent.memory.overlay", "records": 1, "bytesPerPrimitive": { "example": 472 } }
```

> **Doug:** What did you learn this week?
> **Mercury:** The Aug 13 outage became a permanent example: expand/contract for column
> drops under rolling deploys. Promotion was eval-gated — my suite went from 7/9 to 9/9
> with the lesson applied, so it stuck. Provenance: conv_9a44d1 (the postmortem).

---

## Scenario 4 — Rig proposes an escalation trigger; Doug approves, then rolls it back (guarded tier)

**Agent:** Rig, an infrastructure-operations agent with judgment domain `prod-operations`.
**Scope:** `{ tenant: "acme", env: "prod", agent: "rig" }`.
Escalation triggers change *what the agent refuses or escalates* — **guarded tier**, human
approval via `HumanApprovalGate`, no exceptions.

### Aug 12 — the trigger

> **Rig:** Cleanup done — removed the orphaned `atlas-tmp-exports` bucket along with the
> stale log groups.
> **Doug:** The bucket was fine to remove, but I didn't know it was happening. I want to
> be **asked before you delete anything in prod** — deletions are the one thing we can't
> undo.
> **Rig:** Understood. Proposing that as a standing escalation rule — it will need your
> approval to become part of how I operate.

```json
{
  "id": "mem_d1907c",
  "scope": { "agent": "rig", "env": "prod", "tenant": "acme" },
  "kind": "preference",
  "content": "Ask Doug before deleting any resource in prod (buckets, tables, log groups, DNS records) — deletions are irreversible.",
  "tags": ["prod-safety", "deletions"],
  "provenance": {
    "conversationId": "conv_e7b2c9",
    "runId": "run_40aa17",
    "author": "agent:rig"
  },
  "createdAt": "2026-08-12T16:45:09Z",
  "updatedAt": "2026-08-12T16:45:09Z",
  "target": { "primitive": "judgment", "domain": "prod-operations", "slot": "escalationTriggers" }
}
```

> **Design note:** ADR-0008's tier table names `escalationTriggers` as a guarded-tier
> target, but the `MemoryTarget` union in Decision 1 only admits
> `slot: "heuristics"` — the shape above assumes the union widens. See open question 1.

### Tier path — through the human gate

```
candidate (Aug 12)
  → guarded tier: promotion Play issues an approval request via HumanApprovalGate
  → gate surfaces: "Rig proposes escalation trigger: 'Ask Doug before deleting any
     resource in prod…' — approve to add to composition"
  → Doug approves (Aug 12, 17:02)
  → PROMOTED (agent.memory.promote, tier "guarded", bar "human-approval:doug")
```

Bar cleared: explicit human approval — the only bar the guarded tier accepts. Recurrence
and eval-pass are not sufficient here, by design: this slot changes refusal behavior.

### Composition diff

Before:

```markdown
## Judgment: prod-operations

**Heuristics:**
- Prefer the smallest change that restores service; optimize later.

**Escalate to human when:**
- Any action would modify IAM policies or security groups.
```

After (next instantiate):

```markdown
## Judgment: prod-operations

**Heuristics:**
- Prefer the smallest change that restores service; optimize later.

**Escalate to human when:**
- Any action would modify IAM policies or security groups.
- Ask Doug before deleting any resource in prod (buckets, tables, log groups, DNS records) — deletions are irreversible.
```

### Aug 25 — the rollback

Two weeks of routine log-group cleanups later:

> **Doug:** The deletion approvals have become noise — I've clicked "yes" on log-group
> cleanup eleven times. Drop that rule for now; I'll come back with something narrower.
> **Rig:** Rolling it back. The rule leaves my composition on my next instantiation;
> the record and its history stay in the store.

Rollback is not config surgery — it is one store call, `invalidate("mem_d1907c", ...)`
(here issued by the host/admin surface on Doug's behalf):

```json
{
  "id": "mem_d1907c",
  "invalidAt": "2026-08-25T10:31:44Z",
  "...": "(record otherwise untouched; no supersededBy — this is a rollback, not a correction)"
}
```

Because the overlay is a **derived view recomputed each instantiate from the store's
current valid records** (ADR-0008 Decision 2), the next instantiate simply compiles
without it. The `## Judgment: prod-operations` section renders **byte-identical to the
"Before" fragment above** — the composition has reverted, and the audit trail (proposal,
approval, 13 days in force, rollback) survives in full.

(Doug's "something narrower" would be a *new* record with `supersedes: "mem_d1907c"`
through the same human gate — supersede-for-corrections, invalidate-for-rollbacks. The
line between those two is currently convention, not contract; see open question 8.)

### Visibility

```jsonc
{ "type": "agent.memory.write",   "recordId": "mem_d1907c" }                    // Aug 12
{ "type": "agent.memory.promote", "recordId": "mem_d1907c", "tier": "guarded",
  "bar": "human-approval:doug", "target": "judgment.prod-operations.escalationTriggers" }
{ "type": "agent.memory.demote",  "recordId": "mem_d1907c",
  "reason": "invalidated: rolled back by doug — approval noise, rule too broad" }  // Aug 25
{ "type": "agent.memory.overlay", "records": 0, "bytesPerPrimitive": {} }          // next instantiate
```

> **Doug (Aug 21):** What did you learn this week?
> **Rig:** Nothing new promoted this week. Still in force from last week: the
> prod-deletion escalation rule you approved on Aug 12 — I've escalated 11 deletions
> under it. *(After Aug 25 the same query answers: that rule was rolled back on Aug 25;
> my escalation behavior is back to the authored baseline.)*

---

## Scenario 5 — a contradiction caught at promotion, resolved by supersedes (governance)

**Agent:** Sable again (code-review). By late August, Sable carries a previously *earned*
heuristic about `any` usage:

```json
{
  "id": "mem_77ab10",
  "scope": { "agent": "sable", "repo": "agentic-patterns-ts", "tenant": "pattern-stack" },
  "kind": "fact",
  "content": "Flag `any` only when it appears in exported signatures; internal `any` is a nit, not a blocker.",
  "tags": ["typescript", "strictness"],
  "provenance": { "conversationId": "conv_31d0f8", "author": "agent:sable" },
  "createdAt": "2026-08-05T11:20:33Z",
  "updatedAt": "2026-08-05T11:20:33Z",
  "target": { "primitive": "judgment", "domain": "code-review", "slot": "heuristics" }
}
```

### Sept 1 — the conflicting lesson

An `any` in a *shared test helper* masked a regression that shipped (#452):

> **Doug:** The #452 regression got past review because the assertion helper took `any` —
> the type error that would have caught it was swallowed. Test helpers are load-bearing.
> **Sable:** That cuts against a rule I currently hold — that internal `any` is only a
> nit. Proposing a replacement.

Sable writes the candidate:

```json
{
  "id": "mem_f3391b",
  "scope": { "agent": "sable", "repo": "agentic-patterns-ts", "tenant": "pattern-stack" },
  "kind": "fact",
  "content": "Treat `any` in shared test utilities as a blocker — an `any`-typed assertion helper masked the #452 regression. Internal `any` elsewhere remains a nit; exported signatures remain a blocker.",
  "tags": ["typescript", "strictness", "test-helpers"],
  "provenance": {
    "conversationId": "conv_0be6a4",
    "runId": "run_77e2c3",
    "author": "agent:sable"
  },
  "createdAt": "2026-09-01T15:58:26Z",
  "updatedAt": "2026-09-01T15:58:26Z",
  "target": { "primitive": "judgment", "domain": "code-review", "slot": "heuristics" }
}
```

### Tier path — promotion blocked, then resolved

The earned-tier promotion Play runs its mandatory **contradiction check** first
(ADR-0008 Decision 6): a reconciliation search (`search`, ADR-0007) over the same domain.
It hits `mem_77ab10` — both records rule on `any` severity, with opposite outcomes for the
test-helper case. **A candidate that contradicts an existing heuristic cannot
auto-promote**; it parks as a conflict for curation.

The next gardening pass (`lintComposition` — invoked manually in the framework tier)
surfaces it in the composition health report:

```text
lintComposition — sable @ 2026-09-02
  judgment.code-review        4 heuristics (1 memory-derived), 612 chars   OK
  CONFLICT  candidate mem_f3391b ⟷ promoted mem_77ab10
            both target judgment.code-review.heuristics; overlapping subject
            ("any" severity); opposing dispositions for internal/test code.
            Resolution required: agent-proposed supersedes, or human pick.
```

Resolution — curation *proposes*, it never silently rewrites (the anti-Dreaming rule).
Sable proposes `supersedes`; because the *loser* is an earned-tier heuristic and the
replacement targets the same slot, the proposal goes back through the earned-tier gate
(here Doug confirms during the gardening review). The store closes the chain:

```json
{
  "id": "mem_77ab10",
  "invalidAt": "2026-09-02T09:14:55Z",
  "supersededBy": "mem_f3391b",
  "...": "(rest unchanged)"
}
```

```
candidate mem_f3391b (Sept 1)
  → contradiction check: HIT (mem_77ab10) → auto-promotion BLOCKED
  → gardening/lintComposition surfaces the conflict (Sept 2)
  → resolution: supersedes chain mem_77ab10 → mem_f3391b, confirmed at the gate
  → mem_77ab10 invalidated+demoted; mem_f3391b PROMOTED (bar "supersedes-resolution")
```

Had the conflicting line been **authored** rather than learned, no supersedes would be
possible: authored-vs-learned always resolves authored-wins, and the candidate is
reported, not promoted (ADR-0008 Decisions 2 and 6).

### Composition diff

Before (Sept 1):

```markdown
## Judgment: code-review

**Heuristics:**
- Prefer small, focused diffs; ask for a split above ~400 changed lines.
- Missing tests on changed behavior is a blocker, not a note.
- PRs adding SSE event types must include all four coordinated sse-formatter.ts guard edits plus sse-event-manifest.json regen; approving without them fails the dashboard drift test.
- Flag `any` only when it appears in exported signatures; internal `any` is a nit, not a blocker.
```

After (first instantiate after Sept 2): the superseded bullet is gone, its replacement in:

```markdown
## Judgment: code-review

**Heuristics:**
- Prefer small, focused diffs; ask for a split above ~400 changed lines.
- Missing tests on changed behavior is a blocker, not a note.
- PRs adding SSE event types must include all four coordinated sse-formatter.ts guard edits plus sse-event-manifest.json regen; approving without them fails the dashboard drift test.
- Treat `any` in shared test utilities as a blocker — an `any`-typed assertion helper masked the #452 regression. Internal `any` elsewhere remains a nit; exported signatures remain a blocker.
```

### Visibility

```jsonc
{ "type": "agent.memory.write",   "recordId": "mem_f3391b" }
// promotion attempt → blocked; conflict surfaced via lintComposition (gardening)
{ "type": "agent.memory.demote",  "recordId": "mem_77ab10", "reason": "superseded by mem_f3391b" }
{ "type": "agent.memory.promote", "recordId": "mem_f3391b", "tier": "earned",
  "bar": "supersedes-resolution", "supersedes": "mem_77ab10" }
{ "type": "agent.memory.overlay", "records": 2, "bytesPerPrimitive": { "judgment": 405 },
  "droppedConflicts": 0 }
```

> **Doug:** What did you learn this week?
> **Sable:** I *revised* a belief rather than adding one: my Aug 5 rule ("internal `any`
> is a nit") turned out to be wrong for shared test helpers — the #452 regression proved
> it. The old rule is superseded, not deleted; the chain is
> mem_77ab10 → mem_f3391b if you want the history.

---

## When growth goes wrong

Two anti-scenarios the governance mechanisms are built for. Both end with the system
holding, not the agent degrading.

### Bloat: the overlay budget catches a hoarder

By October, Compass (Scenario 1) has 23 promoted `background` facts — every scheduling
detail, sprint anecdote, and tool quirk of two months. The per-primitive overlay budget
(say 1,000 chars for `background`) trips inside `applyMemoryOverlay`:

- The overlay folds records up to budget; the **overflow records fall back to the recall
  tier** — still searchable, still injectable on turn 1, never silently discarded
  (house rule: truncation is marked).
- The instantiate's `agent.memory.overlay` event reports it:
  `{ "records": 17, "bytesPerPrimitive": { "background": 998 }, "spilledToRecall": 6 }`.
- `lintComposition` flags the primitive as at-budget and lists staleness candidates; the
  gardening pass *proposes* merging near-duplicates and invalidating stale `currentState`
  facts — proposals only, resolved through the same gate tiers.

The failure mode is a slightly noisier recall block and a lint warning — not a
context-window blowout, and not a mystery: every spilled record is named in the ledger.

### The wrong lesson: one bad episode does not make a rule

Mercury (Scenario 3) hits a single flaky CI timeout during a migration verify step and
writes a candidate heuristic: *"Wait 30 seconds before running verification queries —
they fail when run immediately."* Target: `judgment.schema-changes.heuristics`, earned
tier.

- Recurrence bar: 1 episode < N=2 → the promotion Play holds it at **candidate**.
- Eval-pass path: the promotion Play tries `config` vs `config′` — no improvement
  (the suite has no case where sleeping helps) → no promotion.
- The record surfaces occasionally in recall (visibly a memory, weighable against
  context), never as a composed rule. Weeks later, gardening flags it as a stale
  never-promoted candidate and proposes invalidation.

Per ADR-0008: *"A candidate record that never earns promotion just remains recall-tier —
that is the correct failure mode, not a bug."* One bad Tuesday does not become part of
the self.

---

## Open design questions surfaced while writing this

Ambiguities and awkward corners hit while making the scenarios concrete. Each was worked
around above with an explicitly-marked assumption; all need answers before Phase B/C.

1. **`MemoryTarget` cannot express the guarded tier.** The tier table (ADR-0008
   Decision 4) gates `judgment.constraints`, `escalationTriggers`, and `recovery` behind
   human approval — but the `MemoryTarget` union (Decision 1) only admits
   `{ primitive: "judgment"; slot: "heuristics" }`. Scenario 4 had to assume a widened
   union (`slot: "escalationTriggers"`). Also, `recovery` is a Role-level primitive, not
   a judgment slot — its target shape is entirely unspecified. Either the union widens in
   the same phase that activates the guarded tier, or the tier table's guarded row is
   aspirational; the ADRs should say which.

2. **Where does promotion state live?** `MemoryRecord` has no `tier`/`promoted` field, yet
   `applyMemoryOverlay` consumes "*promoted*, valid targeted records" and the instantiate
   path needs "a bounded query (valid+promoted records for scope)". Ledger replay defines
   point-in-time truth, but nobody wants to replay events per instantiate. Options: a
   field on the record (breaks ADR-0007's frozen shape — the exact "breaking to add
   later" trap `target` was reserved to avoid), a promotions side-table in the store, or
   a store-protocol extension (`listPromoted(scope)`). Needs a decision; it changes the
   ADR-0007 contract surface.

3. **Recurrence linkage is unspecified.** "≥ N supporting episodes" — supported *how*?
   Scenario 2 invented a `tags: ["supports:mem_e41c92"]` convention. Is support a tag
   convention, a provenance link, or a first-class edge? And what counts: N distinct
   *conversations*? runs? Can the same session mint two supporting episodes and
   self-promote a rule in one sitting?

4. **String `content` vs structured targets.** `Example` needs
   `scenario/good/bad/reasoning`; an `awareness` target is "content parsed as domain
   entry" (`name/description/accessMethod`). But `content` is "natural-language,
   prompt-ready" — a single string. Scenario 3 used labeled `Scenario:/Good:/Bad:/Why:`
   lines. Who parses (at write? at promotion? inside `applyMemoryOverlay`?), what is the
   grammar, and what happens on parse failure — reject at write, hold at candidate, or
   fall back to recall? A pure `applyMemoryOverlay` that can *fail to parse* mid-fold
   needs defined behavior.

5. **The `kind` vocabulary has no procedural kind.** A learned heuristic is neither
   `fact`, `preference`, `episode`, nor `profile` — Scenarios 2 and 5 shoehorned rules
   into `kind: "fact"`, Scenario 4 into `"preference"`. Once `target` exists, `kind` and
   `target` partially encode the same thing. Either `kind` grows a `rule`-like value, or
   the docs should state that `kind` is a recall/two-tier concern and `target` alone
   governs composition semantics.

6. **What does "written + reconciled" mean, exactly, for auto tier?** Scenario 1 assumed
   a synchronous reconciliation search at write time and immediate promotion. Is
   reconciliation mandatory-at-write (making `memory_save` slower), or deferred to the
   next gardening pass (facts don't appear in composition for hours/days)? The
   perceived responsiveness of the "easy path" hangs on this.

7. **Budget-spill ordering is unspecified.** Conflict resolution is "older wins", but
   when the bloat scenario spills 6 of 23 records to recall, *which* 6? Newest first?
   `kind: "profile"` protected? A pinned flag? Deterministic spill order is required for
   the pure-function claim, and "oldest wins" (mirroring conflicts) would mean an agent's
   most *recent* learnings are the first casualties of bloat — probably backwards.

8. **Invalidate vs supersede vs "demote-but-keep" is convention, not contract.**
   Scenario 4's rollback invalidated the record — which also removes it from *recall*
   search (by default). Doug wanted the rule out of the composition; did he want the
   memory gone from recall too? There is no operation for "revoke the promotion, keep
   the candidate" (demote without invalidate). The guarded tier likely needs one —
   rollback of a promotion and retraction of a memory are different acts.

9. **"Older wins" for memory-vs-memory key collisions fights the common case.** Two valid
   promoted records with the same `background` key resolve `createdAt`-older-wins. But
   for facts, the newer record is *usually* the truer one (Scenario 1's deploy-window
   change) — the design only produces the right answer if writers reliably use
   `supersedes`. A write-time nudge (reconciliation detecting a same-key valid record and
   *requiring* an explicit supersede-or-new-key choice) would close the trap; nothing
   specifies it.

10. **The ledger lives on the retention-pruned event spine.** "What did you learn this
    week" and point-in-time replay are defined as queries over promote/demote *events* —
    but ADR-0007 deliberately kept memory off the telemetry store precisely because it is
    retention-pruned and downgrade-hostile. If promote events age out with telemetry
    retention, the evolution ledger is not durable. Either promotion facts must also live
    in the memory store (see Q2 — same table solves both), or `memory_learnings` cannot
    be an event query.

11. **Scope subset-matching makes overlays per-slice — is that intended, and how do evals
    cope?** A heuristic promoted at scope `{ tenant, user: "u_42" }` overlays only
    conversations matching that scope: the "same" agent behaves differently per user.
    Probably desirable — but the eval-gated promotion runs *one* suite against *one*
    `config′`; per-scope overlays mean the evaluated composition is not the composition
    every user gets. Related: nothing but author convention (an `agent:` scope field)
    prevents records learned by one agent from overlaying a *different* agent whose
    judgment domains happen to match. The framework "does not invent identity" — but the
    overlay query needs a stated identity convention or cross-agent leakage is one
    missing scope field away.

12. **Learned lines in safety-relevant slots are prompt-indistinguishable by design —
    should they be?** For `background` this is the feature. For a guarded
    `escalationTriggers` line (Scenario 4), the model cannot tell an authored safety rule
    from a learned one, and neither can a human reading the raw prompt outside the
    dashboard. Attribution lives only in `renderSections()`. Worth an explicit decision
    that this is acceptable for guarded slots (the approval gate being deemed
    sufficient), rather than an accident.

13. **Candidates depend on lucky recall.** Scenario 2's story only works because the
    Aug 14 PR's first user text happened to match the candidate record. Recall is
    query-driven (turn-1 text) and budget-capped; a highly relevant candidate heuristic
    can simply miss. If candidacy is the probation mechanism, targeted candidates may
    need recall *priority* (e.g., ranked ahead of untargeted hits for the matching
    domain, or profile-style pinning) — otherwise probation is a coin flip and
    recurrence counts are suppressed by the very mechanism meant to gather them.

14. **`updatedAt` has no defined mutator.** With invalidation-first curation, records are
    never edited — corrections are new records via `supersedes`. So what ever changes
    `updatedAt`? If the answer is "invalidation touches it", say so; if records are
    truly immutable post-write, `updatedAt` is dead weight in the shape and the
    conformance kit should pin whichever answer is chosen.

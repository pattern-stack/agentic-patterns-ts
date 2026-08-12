---
title: "Triggers and the registry"
description: "The shipped ignition contract: the TriggerSource atom, the AgentRegistry protocol, runFromTrigger, and how trigger provenance reaches the run row."
sidebar:
  label: "Triggers & registry"
---

The ignition contract is three pieces: an atom describing **what fired**, a protocol for
resolving a **named agent**, and a function that turns both into a **run**. All three are
shipped and exported — `TriggerSource` from `@agentic-patterns/core`, the other two from
`@agentic-patterns/runtime`.

## `TriggerSource` — what started this run

A frozen, Zod-validated atom describing the cause of a run.

The runtime seams (`RunOptions.trigger`, `TriggerRunRequest.trigger`) take
**`TriggerSourceData`** — a plain object — and validate it themselves. So the ordinary host
path is an object literal:

```ts
const trigger = {
  kind: "schedule",
  sourceId: "sched_01HQ",         // your schedule row id
  label: "morning-brief",          // human-facing, prompt-safe
  firedAt: new Date().toISOString(),
  correlationId: jobRunId,         // join key back to your audit trail
  summary: "Weekday cadence, 09:00 America/New_York",
} satisfies TriggerSourceData;
```

Construct the **class** when you want validation at your own boundary rather than at the
seam, or when you want to render it:

```ts
import { TriggerSource, type TriggerSourceData } from "@agentic-patterns/core";

const source = new TriggerSource(trigger);   // throws on a bad kind or firedAt
```

> One ergonomic wrinkle worth knowing: `source.data` is typed `Readonly<...>` with every
> field optional (the shared atom base widens it), so it does **not** assign directly to a
> `TriggerSourceData` parameter without a cast. Pass the literal you built the atom from,
> not `source.data`.

| Field | Required | Purpose |
|---|---|---|
| `kind` | yes | What family of thing fired — see below |
| `firedAt` | yes | ISO 8601 with offset |
| `sourceId` | no | Stable id of the triggering thing (schedule row, webhook delivery, message ts) |
| `label` | no | Human-facing name — **renders into the prompt** |
| `correlationId` | no | Host join key back to your own audit rows |
| `summary` | no | Small prompt-safe excerpt — **never the full event body** |

### The kinds

The vocabulary is deliberately small and stable. App-level distinctions belong in
`sourceId`/`label`/`summary`, not in a growing enum.

| Kind | Renders as | Use for |
|---|---|---|
| `schedule` | a schedule | Cron, rrule, interval cadences |
| `webhook` | a webhook delivery | Inbound HTTP from a third party |
| `message` | an incoming message | Chat/channel ingress |
| `manual` | a person, manually | A human pressed the button |
| `agent` | another agent | Delegation and multi-agent handoff |
| `system` | the system | Internal causes — startup, retry, backfill |

### Making the agent aware of its trigger

`TriggerSource` renders. `toPrompt()` produces a compact line, plus `summary` when present:

```
This run was started by a schedule ('morning-brief') at 2026-08-12T09:00:00Z.
Weekday cadence, 09:00 America/New_York
```

**The runtime does not call this for you.** A trigger passed to `runFromTrigger` or
`RunOptions` travels as *provenance* — onto `agent.message.start` and into the run row —
and never reaches the prompt. Nothing in the runtime invokes `toPrompt()` on it.

Note the wiring constraint: `runFromTrigger` calls `registry.resolve(agentId, scope)` — it
does **not** pass the trigger to the registry. So a trigger-aware composition needs a
registry that closes over the firing:

```ts
/** Wrap a registry so this firing's trigger lands in the agent's awareness. */
function triggerAware(base: AgentRegistry, trigger: TriggerSourceData): AgentRegistry {
  return {
    list: () => base.list(),
    resolve: async (id, scope) => {
      const agent = (await base.resolve(id, scope)) as Agent;
      return new AgentBuilder(agent.role)
        .withBackground(agent.background)
        .withMission(agent.mission)
        .withAwareness(
          new Awareness({
            domains: [
              {
                name: "Trigger",
                description: new TriggerSource(trigger).toPrompt(),
                accessMethod: "provided at ignition",
              },
            ],
          }),
        )
        .build();
    },
  };
}

await runFromTrigger({ registry: triggerAware(registry, trigger), runner }, request);
```

This replaces the agent's declared awareness rather than merging into it — `Awareness` has
no merge operation today. If your agents declare awareness domains of their own, carry them
across explicitly (`[...agent.awareness.data.domains, triggerDomain]`).

Keep it terse on purpose: `summary` is specified as a *small prompt-safe excerpt*, never
the full event body. A webhook payload rendered wholesale into a system prompt is both a
token sink and an injection surface.

## `AgentRegistry` — resolving a named agent

Before this protocol, agent identity lived only *above* the runtime: the CLI knew
`DiscoveredAgent.id`, the server knew `AgentRegistration.id`, and the runtime knew nothing
but `role.name`. A daemon-tier caller can import neither, so the runtime defines the
minimal structural protocol and hosts adapt to it — the same posture as `ToolExecutor` and
`ConversationStore`, and duck-typed for the same reason (never `instanceof` across a dist
boundary).

```ts
interface AgentRef {
  readonly id: string;          // "dealbrain/pm" — the canonical handle
  readonly name: string;
  readonly description?: string;
}

interface AgentRegistry {
  list(): readonly AgentRef[];
  resolve(id: string, scope?: Record<string, unknown>): Promise<AgentLike>;
}
```

`resolve` is the load-bearing method, and it carries a contract that is easy to violate by
accident:

> **Parse the scope against the registration's declared `SessionScope`, then instantiate
> through the registration's own seam. Never hand back the declared agent with a pinned
> scope.**

That last clause is a real bug class, not a style note: a registry that returns one shared
instance leaks the first caller's scope into every subsequent run. See
[ADR 0004](../adr/0004-instantiate-as-execution-seam.md) for why instantiate is the
execution seam, and [ADR 0005](../adr/0005-session-scope.md) for the scope contract.

### Adapting an existing store

Most hosts already have this shape and just need to expose it. A registry over database rows:

```ts
import type { AgentRegistry, AgentRef } from "@agentic-patterns/runtime";

class DbAgentRegistry implements AgentRegistry {
  constructor(private readonly rows: AgentDefinitionRow[]) {}

  list(): readonly AgentRef[] {
    return this.rows.map((r) => ({ id: r.id, name: r.name, description: r.description }));
  }

  async resolve(id: string, scope?: Record<string, unknown>) {
    const row = this.rows.find((r) => r.id === id);
    if (!row) throw new Error(`Unknown agent: ${id}`);

    const declared = buildAgentFromConfig(row.config);
    // Parse — reject, don't coerce — then instantiate. Both halves matter.
    return declared.instantiate(declared.scope?.parse(scope ?? {}));
  }
}
```

Reject unknown ids rather than returning `undefined`: an ambient caller has no user to show
a 404 to, and a silent no-op schedule is the hardest kind of outage to notice.

## `runFromTrigger` — the seam

```ts
import { runFromTrigger } from "@agentic-patterns/runtime";

const handle = await runFromTrigger(
  { registry, runner, eventBus },   // wired once, reused across firings
  {
    agentId: "ops/morning-brief",
    input: "Summarize what changed overnight.",
    trigger,                         // validated at entry
    scope: { tenantId: "acme" },     // raw; the registry parses it
    runId: jobRunId,                 // optional — minted here when absent
  },
);
```

**Dependencies** (`TriggerRunDeps`) — `registry` and `runner` are required; `eventBus` is
optional; `toolExecutor` overrides the default, which is derived from the resolved agent's
own capabilities. A capability-less agent runs tool-less, byte-identical to the server path.

**Request** (`TriggerRunRequest`) — `agentId`, `input`, and `trigger` are required. `scope`,
`runId`, `maxIterations`, and `signal` are optional.

**Handle** (`TriggerRunHandle`) — `{ runId, agentId, result }`.

### The guarantees

Each one exists to prevent a bug class:

- **Validated at entry.** `TriggerSourceSchema.parse` runs first. Daemon callers hand over
  wire-shaped data; a malformed trigger fails here, not three layers down.
- **Resolution goes through the registry.** The ADR-0004 instantiate + `scope.parse` path,
  never a pinned declared instance.
- **Pre-correlatable.** The returned `runId` is chosen *before* execution — caller-supplied
  or minted here — so you can write your correlation row up front.
- **Provenance survives.** `RunOptions.trigger` → `MessageStartEvent.trigger` →
  `RunMeta.metadata.trigger`. The run row alone answers "why did this run happen".
- **Scope reaches tools and renders** the same way the server and CLI paths do.

Trigger provenance is purely additive: omit it and behavior is byte-identical.

### What it deliberately does not do

`runFromTrigger` is a function, not a daemon. It does not own:

- **Conversation continuity across triggers** — needs scope persistence and rehydration.
  See [Conversations](conversations.md).
- **Queue or reject policy** for a conversation that is already busy.
- **Any transport.** A trigger fires with no HTTP request; there is nothing to respond to.

Those are M3's `AgencyHost`, which will formalize this function into a method on a host
that holds the registry, runner, and bus. Until then this *is* the contract, callable from
any daemon or jobs tier.

## Reading a triggered run

The events a triggered run emits are the ordinary vocabulary — see the
[SSE event reference](../reference/events.md). The one addition is that `agent.message.start`,
the run's root event, carries `trigger`, and `RunStoreExporter` persists it under
`RunMeta.metadata.trigger`. Anything that can read a run row can answer why it happened,
without joining back to your scheduler.

## Forward compatibility

`TRIGGER_KINDS` has no member for an internal domain event today — an order shipped, a
threshold crossed. That is [#470](https://github.com/pattern-stack/agentic-patterns-ts/issues/470),
and the recorded decision is to add an `event` kind carrying a subkind. Code that switches
exhaustively over `kind` should expect a seventh member; code that treats unknown kinds as
`system` will keep working.

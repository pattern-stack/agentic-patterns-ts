---
title: "Ambient agents"
description: "Agents that run without a human in the loop: how a schedule or webhook wakes a named agent, why the run records what started it, and which pieces are shipped today."
sidebar:
  label: "Ambient agents"
---

Most agent frameworks assume a person is waiting. A request arrives, an agent answers,
the process ends. An **ambient** agent inverts that: it runs because *something happened* —
a schedule fired, a webhook landed, a message arrived — and whoever cares reads the result
later.

That inversion breaks three assumptions at once. There is no HTTP request to carry
identity, so scope has to come from somewhere else. There is no caller holding a reference
to an agent instance, so the agent has to be addressable *by name*. And there is no human
to ask "why did this happen?", so the run itself has to record why.

This page is the map. The framework ships the ignition seam that answers all three.

## The loop

```
  a schedule fires ─┐
  a webhook lands  ─┼─→  TriggerSource  ─→  runFromTrigger  ─→  AgentRegistry.resolve
  a message arrives─┘                              │                      │
                                                   │              (parse scope,
                                                   │               instantiate)
                                                   ↓                      ↓
                          RunMeta.metadata.trigger ←── the run ←── a scoped agent
                                                   │
                                                   ↓
                                  memory written, recalled next time
```

Read left to right: something in the world fires, the host describes it as a
`TriggerSource`, and `runFromTrigger` turns "this agent, this input, this cause" into a
run whose provenance survives in the run row.

## The one function

`runFromTrigger` is the whole contract. A daemon, a job handler, a cron dispatcher — anything
that can call a function — can start an agent run with it:

```ts
import { runFromTrigger } from "@agentic-patterns/runtime";

const handle = await runFromTrigger(
  { registry, runner },
  {
    agentId: "ops/morning-brief",
    input: "Summarize what changed overnight.",
    trigger: {
      kind: "schedule",
      label: "morning-brief",
      firedAt: new Date().toISOString(),
      correlationId: jobRunId, // your own audit row
    },
  },
);

// Known BEFORE the run executed — correlate it with your job table now,
// not after the agent finishes.
console.log(handle.runId, handle.result.response);
```

Four things happen in that call, and each one exists to prevent a specific bug:

1. **The trigger is schema-validated at entry.** Daemon callers hand over wire-shaped
   data; garbage fails loud here rather than three layers down.
2. **The agent is resolved through `AgentRegistry`,** which parses your scope and goes
   through the registration's `instantiate` seam — never a pinned instance handed back
   to every caller.
3. **The `runId` is chosen before execution.** You can write your correlation row before
   the agent has produced a single token.
4. **Provenance rides all the way down** — `RunOptions.trigger` → `MessageStartEvent.trigger`
   → `RunMeta.metadata.trigger`. The run row alone answers *why did this run happen*.

[Triggers and the registry](triggers.md) covers each of these in full, including how to
adapt your own agent store to `AgentRegistry`.

## Why the trigger is an atom

`TriggerSource` is an atom rather than opaque host metadata, which means it is
Zod-validated, frozen, and has a `toPrompt()` like everything else in the composition:

```
This run was started by a schedule ('morning-brief') at 2026-08-12T09:00:00Z.
```

The reasoning: an ambient agent may legitimately behave differently at 9am on a cadence
than when a human asks it something directly, and that belongs in the composition rather
than in a string a host remembered to prepend.

> **What ships today:** the trigger travels as provenance — onto the run's root event and
> into the run row. **It is not automatically rendered into the prompt.** Nothing in the
> runtime calls `toPrompt()` on it. If you want the agent to *know* what woke it, compose
> that yourself — see [Triggers](triggers.md#making-the-agent-aware-of-its-trigger).

The `kind` vocabulary stays small and stable — `schedule`, `webhook`, `message`, `manual`,
`agent`, `system`. App-level notions (a directive id, a cron slot, a channel name) ride
`sourceId`, `label`, and `summary` instead of growing the enum.

## What memory adds

An agent that wakes on a cadence and remembers nothing between firings is a cron job with
a language model attached. Cross-session memory is what makes the loop compound: the store
is scoped, invalidation-first, and reaches the agent through two surfaces — a budget-capped
turn-1 injection and a toolbox the agent can search.

Phase 1 is shipped and documented in the [memory guide](../memory/guide.md).

## What is shipped, and what is not

The honest state as of runtime **0.40.0** / core **0.18.0**:

| Capability | State |
|---|---|
| `TriggerSource` atom — what started this run | **Shipped** (core 0.18) |
| `AgentRegistry` — resolve a named agent + scope | **Shipped** (runtime 0.39) |
| `runFromTrigger` — the ignition seam | **Shipped** (runtime 0.39) |
| Trigger provenance persisted on the run row | **Shipped** |
| Cross-session memory — store, recall, toolbox | **Shipped** (Phase 1) |
| Gateway model routing for unattended runs | **Shipped** (see [Gateway routing](gateway.md)) |
| Conversation continuity *across* triggers | **Not shipped** — see [Conversations](conversations.md) |
| `AgencyHost` — persistent daemon mode, no idle timeouts | **Not shipped** (M3) |
| Channel adapters — Slack and friends | **Not shipped** (M4) |
| Memory promotion into the composition | **Not shipped** (Phase B) |

What that means practically: the framework gives you the ignition seam and everything below
it. **The daemon, the scheduler, and the transport are yours** — `runFromTrigger` is a
function, not a process. Hosts today wire it into their own job runner.

## Next

- **[Triggers and the registry](triggers.md)** — the full contract, and how to adapt an
  existing agent store to it.
- **[Conversations and threading](conversations.md)** — what it takes for a reply hours
  later to reach the same agent with context, and exactly where the framework stops.
- **[Gateway routing](gateway.md)** — the model-selection setup that unattended runs need,
  and why the direct-key path behaves differently.
- **[Memory guide](../memory/guide.md)** — giving an ambient agent something to carry
  between firings.

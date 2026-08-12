---
title: "Conversations and threading"
description: "What the framework ships for multi-turn state, why a reply hours later needs history rehydration you own today, and the runner that silently drops it."
sidebar:
  label: "Conversations"
---

The ambient loop people actually want looks like this: a schedule fires at 9am, the agent
writes a brief into a thread, and at 11am you reply to that thread and the agent answers
*with the brief still in context*.

That has been proven end to end — but not entirely inside this framework. This page draws
the line precisely, because the failure mode when you get it wrong is an agent that answers
plausibly while remembering nothing.

## What ships — SHIPPED

**`Conversation`** — a live multi-turn conversation over an agent and a runner. It holds
exchange history, working state, aggregate token usage, and an opaque `host` payload fixed
at construction (that is how a parsed `SessionScope` reaches every run the conversation
makes, rather than being re-derived per message).

```ts
import { Conversation } from "@agentic-patterns/runtime";

const conversation = new Conversation(agent, runner, { store, host });
const exchange = await conversation.send("Hello!");
console.log(exchange.assistant, conversation.totalTokens);
```

Each `send()` builds `messageHistory` from the conversation's own history and hands it to
the runner. That is the entire mechanism by which a second turn knows about the first.

**`ConversationStore`** — the persistence protocol (`createConversation`, `addMessage`,
`getMessages`, `listConversations`, …) with `InMemoryConversationStore` as the reference
implementation. Pass a store and each exchange is persisted as it completes.

**History injection** — `new Conversation(agent, runner, { history })` seeds a conversation
with prior exchanges. This is the hook rehydration hangs off.

## Where the framework stops — DESIGNED (M3)

Two gaps, both real, both worth knowing before you design around them. The interim
answer to each is a RECIPE: app code you write today, deleted when the framework absorbs it.

### 1. `runFromTrigger` has no conversation

`TriggerRunRequest` carries `agentId`, `input`, `trigger`, `scope`, and `runId`. It carries
no conversation id and no message history — and it does not consult a `ConversationStore`.
Every triggered run is, from the runtime's perspective, a first turn.

This is deliberate rather than unfinished. Continuity across triggers needs scope
persistence, rehydration, and a policy for what happens when a trigger fires while the
conversation is mid-run — none of which the framework decides for you yet. The source says
so out loud:

> Deliberately NOT here (M3): conversation continuity across triggers (needs scope
> persistence + rehydration), queue/reject policy for busy conversations, and any
> transport — a trigger fires with no HTTP request.

M3's `AgencyHost` is where that lands.

### 2. Rehydration is yours today

`ConversationStore` persists `StoredMessage` rows; `Conversation` seeds from `Exchange`
objects. There is no shipped helper that turns the former into the latter — hosts write
that mapping themselves.

The shape of it: load the stored messages, pair them back into `Exchange` objects, and seed
a new `Conversation` with that history plus the same `host` the original run used. From
there `send()` carries the full thread.

**The full working recipe is
[`examples/ambient-morning-brief.ts`](https://github.com/pattern-stack/agentic-patterns-ts/blob/main/examples/ambient-morning-brief.ts)** —
a runnable end-to-end demo of the schedule → brief → reply loop, including the
rehydration mapping. Copy it; delete it when the framework absorbs this (M3).

Keep `host` consistent across rehydration. A conversation that resumes with a different
scope is a quieter bug than one that fails to resume at all.

## The trap that makes this urgent

Multi-turn context is only real if the runner reads it. **`ClaudeCodeAPIRunner` has no read
site for `options.messageHistory`** — only `AgentRunner`'s message assembly does. Land on
that runner and every turn becomes a first turn, while the agent still answers fluently.

That is not hypothetical. Measured in a consuming app on 2026-08-10: every reply to a
stored thread produced *"I don't have a prior brief or message history to reference"* —
because the framework shipped no provider packages, so a consumer with a valid API key fell
through the selection ladder to the one runner that drops history.

[ADR 0010](../adr/0010-bundled-provider-packages.md) fixed the cause: `@ai-sdk/anthropic`,
`@ai-sdk/openai`, and `@ai-sdk/google` are now real dependencies, and a present credential
whose package cannot load now **stops the ladder** with a named error instead of degrading.

Two things follow for anyone building ambient threads:

- **Verify which runner you are on** before trusting a multi-turn result. The selection
  ladder is documented in [Runner & provider strategy](../runners.md).
- **Test recall directly, not by asking the model.** A model's self-report about its own
  transcript is unreliable in both directions. Plant a passphrase in turn 1 and ask for it
  in turn 3; watch input tokens grow monotonically across the thread. Those two signals are
  arithmetic, not opinion.

## Threads versus memory

They solve different problems and compose well:

| | Conversation history | [Memory](../memory/guide.md) |
|---|---|---|
| Scope | One thread | Across sessions and threads |
| Lifetime | The conversation | Until invalidated |
| Mechanism | `messageHistory` on each run | Scoped store + turn-1 recall + toolbox |
| Answers | "What did we just say?" | "What do I know about this tenant?" |

An ambient agent generally wants both: the thread so a reply makes sense, and memory so the
*next* firing starts from something other than zero.

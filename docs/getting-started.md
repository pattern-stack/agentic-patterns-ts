---
title: "Getting started"
description: "Zero to a running agent: compose a prose-only agent first, then add capabilities built from tools — with or without an API key."
---

Build and run your first agent in about twenty lines — no tools required.
Then give it capabilities. Everything on this page is shipped API — no design
previews.

## Install

```sh
bun add @agentic-patterns/core @agentic-patterns/runtime zod
```

## 1. Your first agent — prose only

An agent is composed, not prompted: a `Persona` answers *who am I*, a
`Judgment` answers *how do I decide*, and the `Mission` is *what I'm here
for*. Each primitive renders its own section of the system prompt.

```ts
import {
  AgentBuilder,
  Judgment,
  Mission,
  Persona,
  RoleBuilder,
} from "@agentic-patterns/core";

const role = new RoleBuilder("sous-chef")
  .withPersona(
    new Persona({
      identity: "A practical home-cooking assistant",
      tone: "warm and direct",
      priorities: ["technique over gadgets"],
      principles: ["Suggest substitutions before extra shopping trips"],
    }),
  )
  .withJudgment(
    new Judgment({
      domain: "home cooking",
      heuristics: ["Prefer methods that survive a busy weeknight"],
      constraints: ["Only answer cooking questions"],
    }),
  )
  .build();

const agent = new AgentBuilder(role)
  .withMission(
    new Mission({
      objective: "Help people cook better with what they already have",
      successCriteria: ["Advice is actionable in a home kitchen"],
    }),
  )
  .build();
```

The agent pins no model — it runs on whatever the runner resolves. Pin one
explicitly with `.withModel("claude-sonnet-4-5")` on the builder if you need
to.

## 2. Run it

`createRunner()` picks a provider from your environment (`ANTHROPIC_API_KEY`,
`OPENAI_API_KEY`, a configured gateway, a local Ollama, …) and tells you what
it chose.

```ts
import { createRunner } from "@agentic-patterns/runtime";

const { runner, reason } = await createRunner();
console.log(reason); // e.g. "using anthropic (env ANTHROPIC_API_KEY)"

const result = await runner.run(agent, "My risotto always turns gluey — why?");
console.log(result.response);
```

That's a complete agent: typed composition in, rendered prompt out, model
response back. Everything else in the framework builds on this loop.

## 3. Add capabilities built from tools

A `Capability` is what the agent can *do*: a `Toolbox` of typed tools plus an
optional `Manual` of prose guidance. Tools are typed functions — `parameters`
and `returns` are Zod schemas, and `execute` arguments arrive already
validated.

```ts
import { capability, defineTool, toolbox } from "@agentic-patterns/core";
import { z } from "zod";

const Temperature = z.object({ degrees: z.number() });

const conversions = toolbox("unit_conversions", "Kitchen unit conversions", {
  celsius_to_fahrenheit: defineTool({
    description: "Convert an oven temperature from Celsius to Fahrenheit",
    parameters: z.object({ celsius: z.number().describe("Degrees Celsius") }),
    returns: Temperature,
    execute: async ({ celsius }) => ({ degrees: celsius * 1.8 + 32 }),
  }),
  fahrenheit_to_celsius: defineTool({
    description: "Convert an oven temperature from Fahrenheit to Celsius",
    parameters: z.object({ fahrenheit: z.number().describe("Degrees Fahrenheit") }),
    returns: Temperature,
    execute: async ({ fahrenheit }) => ({ degrees: (fahrenheit - 32) / 1.8 }),
  }),
});

const converting = capability({
  name: "unit_conversions",
  description: "Convert oven temperatures between Celsius and Fahrenheit",
  toolbox: conversions,
});
```

Attach it to the role, and hand the runner a tool executor — that's what lets
the runner actually *execute* your tools instead of just describing them to
the model:

```ts
import { createToolboxExecutor } from "@agentic-patterns/runtime";

const skilledRole = new RoleBuilder("sous-chef")
  .withPersona(/* …as above… */)
  .withJudgment(/* …as above… */)
  .withCapability(converting)
  .build();

const skilledAgent = new AgentBuilder(skilledRole)
  .withMission(/* …as above… */)
  .build();

const result = await runner.run(skilledAgent, "The recipe says 180°C — what's that in Fahrenheit?", {
  toolExecutor: createToolboxExecutor(skilledAgent),
});
// The model calls celsius_to_fahrenheit({ celsius: 180 }) and answers 356°F.
```

## No API key? Run it deterministically

`MockRunner` implements the same runner protocol with canned responses and
real tool dispatch — the standard way to test agents.

```ts
import { MockRunner, createToolboxExecutor } from "@agentic-patterns/runtime";

const mock = new MockRunner().addResponse("Fahrenheit", {
  content: "180°C is 356°F.",
  toolCalls: [{ name: "celsius_to_fahrenheit", arguments: { celsius: 180 } }],
});

const result = await mock.run(skilledAgent, "The recipe says 180°C — what's that in Fahrenheit?", {
  toolExecutor: createToolboxExecutor(skilledAgent),
});

console.log(result.response); // "180°C is 356°F."
```

## Where to go next

- [Authoring a toolbox](authoring-a-toolbox.md) — `defineTool`/`definePlay` in
  depth, schema linting for model-facing Zod, reading per-conversation scope
  in tools.
- [Memory guide](memory/guide.md) — give an agent cross-session memory: the
  store, the toolbox, and turn-1 recall.
- Run `ap playground` (from `@agentic-patterns/cli`) to chat with your agents
  in a browser with live event streaming — any agent exported from an
  `agents/<name>/agent.ts` file is discovered automatically.

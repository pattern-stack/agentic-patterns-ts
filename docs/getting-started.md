---
title: "Getting started"
description: "Zero to a running agent: define a tool, compose a Role, build the Agent, and run it — with or without an API key."
---

Build and run your first agent in about forty lines. Everything on this page
is shipped API — no design previews.

## Install

```sh
bun add @agentic-patterns/core @agentic-patterns/runtime zod
```

## 1. Define tools and bundle them into a Capability

Tools are typed functions: `parameters` and `returns` are Zod schemas, and the
`execute` arguments arrive already validated and typed.

```ts
import { capability, defineTool, toolbox } from "@agentic-patterns/core";
import { z } from "zod";

const Temperature = z.object({ degrees: z.number() });

const conversions = toolbox("unit_conversions", "Temperature conversions", {
  celsius_to_fahrenheit: defineTool({
    description: "Convert a temperature from Celsius to Fahrenheit",
    parameters: z.object({ celsius: z.number().describe("Degrees Celsius") }),
    returns: Temperature,
    execute: async ({ celsius }) => ({ degrees: celsius * 1.8 + 32 }),
  }),
  fahrenheit_to_celsius: defineTool({
    description: "Convert a temperature from Fahrenheit to Celsius",
    parameters: z.object({ fahrenheit: z.number().describe("Degrees Fahrenheit") }),
    returns: Temperature,
    execute: async ({ fahrenheit }) => ({ degrees: (fahrenheit - 32) / 1.8 }),
  }),
});

const converting = capability({
  name: "unit_conversions",
  description: "Convert temperatures between Celsius and Fahrenheit",
  toolbox: conversions,
});
```

## 2. Compose the Role and build the Agent

The anatomy is typed: a `Persona` answers *who am I*, a `Judgment` answers
*how do I decide*, a `Capability` is *what I can do*, and the `Mission` is
*what I'm here for*.

```ts
import {
  AgentBuilder,
  Judgment,
  Mission,
  Persona,
  RoleBuilder,
} from "@agentic-patterns/core";

const role = new RoleBuilder("unit-converter")
  .withPersona(
    new Persona({
      identity: "A precise unit-conversion assistant",
      tone: "brief and exact",
      priorities: ["accuracy"],
      principles: ["Always convert with the provided tools — never estimate"],
    }),
  )
  .withJudgment(
    new Judgment({
      domain: "unit conversion",
      heuristics: ["Use a tool for every conversion, even trivial ones"],
      constraints: ["Only answer unit-conversion questions"],
    }),
  )
  .withCapability(converting)
  .build();

const agent = new AgentBuilder(role)
  .withMission(
    new Mission({
      objective: "Convert temperatures precisely on request",
      successCriteria: ["Every conversion produced by a tool call"],
    }),
  )
  .build();
```

The agent pins no model — it runs on whatever the runner resolves. Pin one
explicitly with `.withModel("claude-sonnet-4-5")` on the builder if you need
to.

## 3. Run it

`createRunner()` picks a provider from your environment (`ANTHROPIC_API_KEY`,
`OPENAI_API_KEY`, a configured gateway, a local Ollama, …) and tells you what
it chose. `createToolboxExecutor(agent)` is what lets the runner actually
execute your tools rather than just describe them to the model.

```ts
import { createRunner, createToolboxExecutor } from "@agentic-patterns/runtime";

const { runner, reason } = await createRunner();
console.log(reason); // e.g. "using anthropic (env ANTHROPIC_API_KEY)"

const result = await runner.run(agent, "What is 21.5°C in Fahrenheit?", {
  toolExecutor: createToolboxExecutor(agent),
});

console.log(result.response);
// The model calls celsius_to_fahrenheit({ celsius: 21.5 }) and answers ~70.7°F.
```

## No API key? Run it deterministically

`MockRunner` implements the same runner protocol with canned responses and
real tool dispatch — the standard way to test agents.

```ts
import { MockRunner, createToolboxExecutor } from "@agentic-patterns/runtime";

const mock = new MockRunner().addResponse("Fahrenheit", {
  content: "21.5°C is 70.7°F.",
  toolCalls: [{ name: "celsius_to_fahrenheit", arguments: { celsius: 21.5 } }],
});

const result = await mock.run(agent, "What is 21.5°C in Fahrenheit?", {
  toolExecutor: createToolboxExecutor(agent),
});

console.log(result.response); // "21.5°C is 70.7°F."
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

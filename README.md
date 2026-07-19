# agentic-patterns (TypeScript)

A compositional agent framework for TypeScript. Agents are built by
composing frozen, immutable primitives upward through layers -- from
atoms to organisms -- then executed by a runtime with events, gates,
workflows, and exporters.

## Packages

| Package | Description |
|---------|-------------|
| [`@agentic-patterns/core`](./packages/agent-core) | Atoms, protocols, molecules, rendering, organisms |
| [`@agentic-patterns/runtime`](./packages/agent-runtime) | Runner, events, gates, workflows, transport, multi-agent, exporters |
| [`@agentic-patterns/server`](./packages/agent-server) | Hono HTTP server — routes, SSE, admin API, Claude Code hook bridge |
| [`@agentic-patterns/cli`](./packages/agent-cli) | `ap` — discover agents, chat in terminal, launch dashboard |

Runtime depends on core. Server depends on runtime + core. Core never imports runtime.

## Quick Start

```bash
npm install -g @agentic-patterns/cli
ap init my-agents --provider=anthropic --with-plugin
cd my-agents
cp .env.example .env   # add ANTHROPIC_API_KEY
bun install
bun run dev               # http://localhost:3456
```

`--with-plugin` also drops a Claude Code plugin next to your project — open Claude Code in that directory and every one of the 26 lifecycle events (tool calls, permission prompts, subagent spawns, compaction, etc.) streams live into the dashboard's `/claude-code` page, grouped by session.

Or, skip the CLI and use the library directly:

```bash
bun add @agentic-patterns/core @agentic-patterns/runtime ai @ai-sdk/anthropic
```

```typescript
import { Persona, Mission, RoleBuilder, AgentBuilder } from "@agentic-patterns/core";
import { AgentRunner, AgentEventBus } from "@agentic-patterns/runtime";
import { anthropic } from "@ai-sdk/anthropic";

const role = new RoleBuilder("assistant")
  .withPersona(new Persona({ identity: "a helpful assistant", tone: "concise" }))
  .build();

const agent = new AgentBuilder(role)
  .withMission(new Mission({ objective: "Help the user" }))
  .build();

const runner = new AgentRunner(anthropic("claude-sonnet-4-20250514"), new AgentEventBus());
const result = await runner.run(agent, "Hello!");
console.log(result.response);
```

## Monorepo Development

```bash
git clone https://github.com/pattern-stack/agentic-patterns-ts
cd agentic-patterns-ts
bun install
bun run build
bun run test
```

## Building an Agent

Agents are composed from small, frozen primitives. Each primitive
answers one question about the agent's behavior.

### Persona -- WHO the agent is

```typescript
import { Persona } from "@agentic-patterns/core";

const persona = new Persona({
  identity: "a research assistant specializing in data analysis",
  tone: "professional and precise",
  priorities: ["accuracy over speed"],
});
```

### Mission -- WHAT the agent is doing

```typescript
import { Mission } from "@agentic-patterns/core";

const mission = new Mission({
  objective: "Analyze the provided dataset and produce a summary.",
  successCriteria: [
    "Identify top 3 trends",
    "Include statistical backing",
  ],
  constraints: ["Only use provided data, no external sources"],
});
```

### Judgment -- HOW the agent decides

```typescript
import { Judgment } from "@agentic-patterns/core";

const sourceQuality = new Judgment({
  domain: "source-quality",
  heuristics: [
    "Prefer peer-reviewed sources",
    "Cross-reference statistics across multiple sources",
  ],
  escalationTriggers: [
    "Contradictory data from equally credible sources",
  ],
});
```

### Role -- reusable agent template

A Role composes primitives into a reusable template. Build one with
the fluent `RoleBuilder`.

```typescript
import { RoleBuilder, Responsibility } from "@agentic-patterns/core";

const role = new RoleBuilder("research-assistant")
  .withPersona(persona)
  .withJudgment(sourceQuality)
  .withResponsibility(new Responsibility({
    key: "analysis",
    name: "Data Analysis",
    description: "Produce accurate, well-sourced quantitative analysis",
  }))
  .build();
```

### Agent -- role + runtime context

An Agent is a Role instantiated with a Mission and optional context.

```typescript
import { AgentBuilder } from "@agentic-patterns/core";

const agent = new AgentBuilder(role)
  .withMission(mission)
  .withModel("claude-sonnet-4-20250514")
  .build();
```

### SessionScope -- per-conversation configuration

Agents that need to know WHO they're running for -- a tenant, an operator, a plan tier -- declare a `SessionScope`: named, Zod-validated fields with optional defaults and presets.

```typescript
import { scopeItem, sessionScope } from "@agentic-patterns/core";
import { z } from "zod";

const scope = sessionScope({
  workspace: scopeItem(z.string().min(1), { description: "Tenant workspace" }),
  user: scopeItem(z.string().email(), { description: "Acting user" }),
});
```

Declare it on an agent registration and the framework handles the rest of the arc: the server or CLI **validates** an incoming scope against the schema, **injects** the parsed value onto the run (`RunOptions.host.scope`), and any tool or prompt-render function **reads** it back -- `requireScope(ctx)` in a tool, `Awareness.fromScope(scope, fn)` in a prompt. See [docs/adr/0005-session-scope.md](./docs/adr/0005-session-scope.md) for the full design.

## Running an Agent

The runtime package provides `AgentRunner`, an event bus, and
exporters for observability.

```typescript
import {
  AgentRunner,
  AgentEventBus,
  ConsoleExporter,
} from "@agentic-patterns/runtime";

const bus = new AgentEventBus();
const exporter = new ConsoleExporter(bus);
exporter.start();

const runner = new AgentRunner(model, bus);
const result = await runner.run(agent, "Analyze Q4 revenue trends.");

console.log(result.response);
exporter.stop();
```

## Workflows

The workflow layer provides composable patterns for multi-step and
iterative agent execution. Everything below composes through one typed
contract — `Node<TIn, TOut>` — so leaves and composites nest freely.

### sequentialAgent -- agents and nodes in sequence, typed end to end

Stages share one Scratchpad, each later stage's prompt implicitly carries
the prior emission, and per-stage tool executors derive from each agent's
own capabilities. A stage may be a bare agent, a spec with knobs
(`output`/`slot`/`onEmit`/`stop`/`retry`/…), or a `{ node }` — a
`CoordinatorStep` spine, a deterministic `FunctionStep` tail.

```typescript
import { type Node, sequentialAgent } from "@agentic-patterns/runtime";

// A COMPOSITE-designated emitting stage types the pipeline: its output IS
// that stage's emission (zero casts), and input:'prior' hands the tail the
// spine's emission — a compiler-checked seam, no nullable slot read.
const pipeline: Node<string, AnswerContract> = sequentialAgent<AnswerContract, string>(
  [{ node: coordinatorSpine }, { node: answerTail, input: "prior" }],
  { emit: "answer" },
);
```

### parallelAgent -- fixed-branch fan-out with a deterministic join

Named branches over a shared input, joined in declaration order. A failed
branch becomes a `{ succeeded: false, error }` outcome inside the join —
one bad branch never fails the fan-out. (`FanOut` remains the tool for
dynamic-N over runtime lists.)

```typescript
import { parallelAgent } from "@agentic-patterns/runtime";

const sections = parallelAgent<{ overview: string; pricing: Pricing }>(
  [
    { agent: overviewDrafter },
    { agent: pricingDrafter, output: PricingShape },
  ],
  { maxConcurrency: 2 },
);
// → Node<unknown, ParallelAgentResult<…>>: { branches, failed, stopped }
```

### Sequential -- chain agents in order

```typescript
import { Sequential } from "@agentic-patterns/runtime";

const pipeline = new Sequential([
  { agent: researcher, messageTemplate: "Research: {{topic}}" },
  { agent: writer, messageTemplate: (ctx) => `Write about: ${ctx.research}`, outputKey: "draft" },
  { agent: editor, messageTemplate: (ctx) => `Edit: ${ctx.draft}` },
]);

const result = await pipeline.run({ topic: "AI trends" }, { runner });
```

### Parallel -- fan-out with concurrency control

```typescript
import { Parallel, collectByName } from "@agentic-patterns/runtime";

const fanout = new Parallel(
  [
    { agent: analystA, messageTemplate: "Analyze market", name: "market" },
    { agent: analystB, messageTemplate: "Analyze competitors", name: "competitors" },
    { agent: analystC, messageTemplate: "Analyze technology", name: "tech" },
  ],
  { maxConcurrency: 2, consolidator: collectByName },
);

const result = await fanout.run({}, { runner });
// result.consolidatedOutput => { market: "...", competitors: "...", tech: "..." }
```

### TaskLoop -- goal-driven iteration

Run an agent iteratively toward a goal, evaluating progress each turn.

```typescript
import { TaskLoop, SimpleGoalEvaluator } from "@agentic-patterns/runtime";

const evaluator = new SimpleGoalEvaluator({
  successPatterns: ["TASK_COMPLETE"],
  failurePatterns: ["CANNOT_PROCEED"],
});

const loop = new TaskLoop(agent, evaluator, { maxIterations: 5 });
const result = await loop.run("Fix the failing test suite", {}, { runner });
// result.exitReason => "goal_achieved" | "max_iterations" | "explicit_stop" | "error"
```

### EvaluatorLoop -- producer-evaluator refinement

Self-critique loop: a producer generates, an evaluator scores and
critiques, and the producer refines.

```typescript
import { EvaluatorLoop, RubricEvaluator } from "@agentic-patterns/runtime";

const evaluator = new RubricEvaluator([
  { name: "clarity", description: "Writing is clear and concise", weight: 0.4 },
  { name: "accuracy", description: "Claims are factually correct", weight: 0.6 },
], { runner });

const loop = new EvaluatorLoop(writer, evaluator, {
  maxRefinements: 3,
  qualityThreshold: 0.8,
});
const result = await loop.run("Write a technical blog post about RAG");
// result.bestOutput => highest-scoring version across all refinements
```

### RetryLoop -- backoff + retry

Generic retry wrapper for any async operation. Not agent-specific.

```typescript
import { RetryLoop, ExponentialBackoff } from "@agentic-patterns/runtime";

const retry = new RetryLoop({
  maxAttempts: 5,
  backoff: new ExponentialBackoff({ initialMs: 100, maxMs: 5000 }),
  retryableErrors: [RateLimitError],
  timeoutMs: 30_000,
});

const result = await retry.run(() => callExternalAPI());
```

### ConversationLoop -- multi-turn orchestration

Multi-turn conversation with external input/output callbacks.

```typescript
import { ConversationLoop } from "@agentic-patterns/runtime";

const loop = new ConversationLoop(agent, {
  maxExchanges: 10,
  exitPhrases: ["goodbye", "exit"],
  inputFn: async () => getUserInput(),
  outputFn: async (response) => displayToUser(response),
});

const result = await loop.run({ runner });
// result.exitReason => "exit_phrase" | "max_exchanges" | "error"
```

## Testing with MockRunner

`MockRunner` enables deterministic testing without LLM calls.

```typescript
import { MockRunner } from "@agentic-patterns/runtime";

const mock = new MockRunner()
  .addResponse("analyze", { content: "Analysis: revenue up 15%" })
  .addResponse("*", { content: "Default response" });

const result = await mock.run(agent, "analyze Q4 data");
// result.response => "Analysis: revenue up 15%"

// Verify interactions
console.log(mock.callHistory); // [{ message, agentName, model, timestamp }]
```

## Multi-Agent Teams

For coordination across multiple agents, define an Agency and run it
with the `AgencyRuntime`.

```typescript
import { Agency } from "@agentic-patterns/core";
import { AgencyRuntime } from "@agentic-patterns/runtime";

const agency = new Agency({
  name: "sales-team",
  description: "Coordinates lead research and outreach",
  agents: [
    { role: "coordinator", isCoordinator: true, model: "claude-sonnet-4-20250514" },
    { role: "researcher", isCoordinator: false, model: "claude-sonnet-4-20250514" },
  ],
});

const runtime = new AgencyRuntime(agency, runner);
await runtime.start();
await runtime.injectCoordinator("Research Acme Corp");
await runtime.stop();
```

## Architecture

```
Agent = Role x Background x Awareness x Mission

Role = Persona + Judgments + Capabilities + Responsibilities
Capability = Toolbox + Manual + Playbook
```

### Layer Hierarchy

| Layer | Package | Location | Purpose |
|-------|---------|----------|---------|
| 0 | core | `src/atoms/` | Frozen Zod-validated models with `toPrompt()` |
| 1 | core | `src/protocols/` | Vendor-agnostic domain interfaces |
| 2 | core | `src/molecules/` | Toolbox, Manual, Capability, Playbook, ToolSchema |
| 3 | core | `src/rendering/` | PromptRenderer with composable sections |
| 4 | core | `src/organisms/` | RoleBuilder, AgentBuilder, Role, Agent |
| 5 | runtime | `src/events/` | Typed EventBus, AgentEventBus |
| 6 | runtime | `src/gates/` | Safety, approval, rate-limit, audit |
| 7 | runtime | `src/runner/` | AgentRunner (Vercel AI SDK), MockRunner, ClaudeCodeRunner |
| 8 | runtime | `src/transport/` | InProcessTransport, MessagingToolbox |
| 9 | runtime | `src/runtime/` | AgentNode, AgencyRuntime |
| 10 | runtime | `src/workflows/` | sequentialAgent, parallelAgent, Sequential, Parallel, FanOut, Loop, Retry, TaskLoop, EvaluatorLoop, ConversationLoop |
| 11 | runtime | `src/conversation/` | Conversation, ConversationStore, InMemoryConversationStore |
| 12 | runtime | `src/exporters/` | Console, Langfuse, OpenTelemetry |
| 13 | runtime | `src/presets/` | Pre-built roles, judgments, responsibilities |

### Key Conventions

- **Zod schemas** for all data models -- define schema, `z.infer<>` for types
- **Immutability** -- `Object.freeze()` + `Readonly<>` on atom data
- **ESM-first** -- tsup produces both ESM and CJS outputs
- **Strict TypeScript** -- `noUncheckedIndexedAccess`, `noUnusedLocals`
- **Async throughout** -- all protocol methods return `Promise<T>`
- **Fluent builders** -- `.with*()` methods return `this` for chaining

## Development

```bash
bun run build       # tsup compile both packages
bun run typecheck   # tsc --noEmit strict mode
bun run test        # vitest run all tests
bun run lint        # biome check
bun run check       # all of the above
```

## Releasing

The four public packages -- `@agentic-patterns/{core,runtime,server,cli}` -- are
versioned in lockstep and published to npm automatically. `@agentic-patterns/dashboard`
is `private: true` and never publishes.

**To cut a release:**

```bash
bash scripts/bump.sh patch        # 0.1.13 -> 0.1.14 (also: minor | major | --to=X.Y.Z)
git commit -am "chore(release): vX.Y.Z"
# open a PR, merge to main
```

On merge to `main`, CI's `publish` job (`.github/workflows/ci.yml`) publishes -- gated
on green `check`. It is **idempotent**: each package publishes only if its version
isn't already on npm, so a merge without a bump is a no-op, and a re-run after a
mid-publish failure resumes cleanly.

**Auth is npm trusted publishing (OIDC)** -- no `NPM_TOKEN` secret, and provenance
attestations are generated automatically. Packages pin each other with `workspace:^`,
so CI `bun pm pack`s each package (rewriting `workspace:^` -> concrete caret pins)
then `npm publish`es the tarball. Before any upload, a **tarball smoke gate**
(`test/post-publish/run-tarball-smoke.ts`) installs the tarballs into a throwaway
project and verifies the ESM/CJS import, type, and CLI-bin contract -- so a broken
tarball aborts the release instead of reaching npm.

**Dry-run / pre-flight locally:**

```bash
bash scripts/publish.sh check          # plan: what would publish vs skip
bash scripts/publish.sh ci --dry-run   # full CI path incl. smoke gate, no upload
bun test/post-publish/run-tarball-smoke.ts   # smoke only (after `bun run build`)
```

**Onboarding a new public package:** add it to the `PACKAGES` arrays in
`scripts/bump.sh` + `scripts/publish.sh`, and register a trusted publisher for it on
npmjs.com (package → Settings → Trusted Publisher → org/repo
`pattern-stack/agentic-patterns-ts`, workflow `ci.yml`). Without that, its first CI
publish fails with an auth error.

## Dependencies

- **zod** -- schema validation and type inference
- **ai** (Vercel AI SDK) -- LLM provider abstraction
- **tsup** -- bundler (ESM + CJS)
- **vitest** -- test runner
- **biome** -- formatter and linter
- **TypeScript 5.7+** -- strict mode compilation

## License

MIT

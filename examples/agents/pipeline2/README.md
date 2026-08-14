# pipeline2 — an `asAgent`-promoted pipeline

A tiny "tip curator": you send a topic (e.g. `testing`), the pipeline looks
up matching tips from an in-memory catalog, curates them into a short
digest, and formats a reply. No network, no clock, no randomness — fully
reproducible teaching material.

## Run it

```bash
bun install                                  # once, from the repo root — links
                                              # @pattern-stack/agentic-* into examples/agents
                                              # (examples/agents/package.json makes it
                                              # a workspace member; also sets "type":
                                              # "module" so the .ts imports resolve)
ap playground examples                       # default — deterministic, no API key
AP_EXAMPLE_LIVE=1 ap playground examples      # live — curate calls the model
```

`Pipeline2` shows up in the agent list (discovered via `agent.ts` under
`examples/agents/`) and can be chatted with exactly like a hand-written
agent — `asAgent()` promotion is what makes that true.

## The hierarchy this example maps onto

Built **inside out** — read top-to-bottom as construction order, NOT as
nesting (the outermost thing `ap` actually sees is the promoted `Agent` at
the bottom; the `Role` at the top is the innermost primitive it's built from):

```
Role (Persona + Judgment + Responsibility)      subagents/curator.ts
  built into ↓
Subagent (curatorAgent, an AgentStep leaf)      subagents/curator.ts  (live mode only)
  nested in ↓
SequentialAgent (fetch → curate → respond)      agent.ts
  promoted to ↓
Agent (asAgent() promotion)                     agent.ts (default export — what `ap` discovers)
```

`Role x Mission` composition (the same primitives any top-level agent uses)
builds the `curate` subagent. `agent.ts` wires that subagent into a
`Sequential` pipeline as one leaf among two purely deterministic
`FunctionStep`s. `asAgent()` then promotes the whole pipeline to something
`ap` can discover and run as if it were an agent in its own right.

## Files

| File | What it demonstrates |
|---|---|
| `agent.ts` | `Sequential` + `.then()` typed seams; `FunctionStep` (fetch, respond); `retry()`; `provideDeps()`; `asAgent()` promotion + default export (the discoverable agent) |
| `deps.ts` | `depKey` — the DI channel for the in-memory tip catalog, read via `ctx.deps` with no closures |
| `subagents/curator.ts` | `AgentStep` leaf built from a real `RoleBuilder`/`AgentBuilder` agent, live-gated behind `AP_EXAMPLE_LIVE`, with a deterministic `FunctionStep` fallback (no `slot`/Scratchpad here — that lives in `agent.ts`) |
| `README.md` | this file |

## Primitive-by-primitive map

| Primitive | Where |
|---|---|
| `Sequential` + `.then()` | `agent.ts` — `Sequential.start(fetchWithRetry).then(curateStep).then(respond)` |
| `FunctionStep` | `agent.ts` (`fetchTips`, `respond`); `subagents/curator.ts` (deterministic curate fallback) |
| `AgentStep` | `subagents/curator.ts` (`curateStep`, live mode only) |
| `depKey` / `provideDeps` | `deps.ts` (key), `agent.ts` (`provideDeps().set(catalogKey, CATALOG).build()`) |
| `retry()` | `agent.ts` — wraps `fetchTips`, `maxAttempts: 2` |
| `slot` / Scratchpad | `agent.ts` — `attemptSlot`, a run-scoped counter that resets every chat turn |
| `asAgent()` | `agent.ts` — promotes the built pipeline to the default export `ap` discovers |

## Why default mode runs without an API key

`ap playground` builds its runner via `createRunner()`, which throws if it
can't construct one — that is a property of the CLI, not this example. Given
a runner exists (a provider key, or the `claude` CLI on `PATH`), **default
mode never calls it**: the `curate` step is a deterministic `FunctionStep`,
so a chat turn flows `fetch → curate → respond` invoking no model at all. Set
`AP_EXAMPLE_LIVE=1` to swap in the real `AgentStep` and exercise the model.

See `.ai-docs/stacks/closed-composition/specs/114.md` for the full spec and
`.ai-docs/stacks/closed-composition/specs/97.md` / `98.md` / `100.md` for the
underlying `asAgent` / `depKey` / `retry` designs.

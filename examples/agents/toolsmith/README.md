# toolsmith — a capability-bearing example agent

A small hand-built agent (`RoleBuilder`/`AgentBuilder` — the same primitives
`presets/agents/calculator.ts` uses) whose only job is to carry a demoable
`Capability`, so the dashboard's Tool Workbench (`/capabilities`) has
something to inspect and invoke without a live model backend. `pipeline2`
(the sibling example) declares no capabilities at all, so before this file
the Workbench had nothing to demo key-free.

## Run it

```bash
bun install                 # once, from the repo root
ap playground examples      # deterministic, no API key
```

Open the dashboard, go to `/capabilities`, pick **toolsmith-utilities**.

## The tools

| Tool | Params | Demonstrates |
|---|---|---|
| `slugify` | `text: string`, `uppercase?: boolean` | required string + optional boolean (omit-empty-optionals) |
| `date_diff` | `from: string`, `to: string` | two required strings (deterministic, no clock reliance) |
| `vector_add` | `a: {x,y}`, `b: {x,y}` | an object param — type invalid JSON into `a` to see the server's flattened Zod rejection |

Every tool is pure and deterministic: no network, no clock, no randomness.
Calling one through the Workbench's **Run tool** button POSTs to
`POST /capabilities/:id/tools/:tool/invoke` (S3), which calls
`toolbox.execute()` directly — no model in the loop.

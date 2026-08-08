---
title: "Agentic Patterns"
description: "Composable primitives for building LLM agents — TypeScript."
template: splash
hero:
  tagline: "Composable primitives for building LLM agents. Frozen, immutable atoms compose upward into roles and agents, executed by a runtime with typed events, gates, and exporters."
  actions:
    - text: "Get the packages"
      link: "https://www.npmjs.com/org/agentic-patterns"
      icon: external
      variant: primary
    - text: "GitHub"
      link: "https://github.com/pattern-stack/agentic-patterns-ts"
      icon: github
---

## The shape of the framework

```
Agent = Role × Background × Awareness × Mission
Role  = Persona + Judgments + Capabilities + Responsibilities
Capability = Toolbox + Manual
```

Everything composes upward through layers — atoms → protocols → molecules →
rendering → organisms in `@agentic-patterns/core`, then events → gates →
runner → transport → runtime → exporters → presets in
`@agentic-patterns/runtime`. Core never imports runtime.

## Install

```sh
bun add @agentic-patterns/core @agentic-patterns/runtime
```

The server (`@agentic-patterns/server`) and CLI (`@agentic-patterns/cli`)
version in lockstep with the runtime; core floats independently.

## Where to start

- **Guides** — authoring toolboxes, runners, the store family, agent packages.
- **Memory** — cross-session memory: the store, the recall surface, and the
  evolution cookbook.
- **Reference** — the SSE event catalog, generated from the runtime manifest.
- **Architecture Decisions** — the ADR trail, from the constellation dashboard
  to compositional memory.

Live API surfaces ship with the server itself: Scalar API docs at `/docs` and
an `llms.txt` at `/llms.txt` on any running instance.

---
title: "Agentic Patterns"
description: "Composable primitives for building LLM agents — TypeScript."
template: splash
hero:
  tagline: "Composable primitives for building LLM agents. Frozen, immutable atoms compose upward into roles and agents, executed by a runtime with typed events, gates, and exporters."
  actions:
    - text: "Get started"
      link: "/getting-started/"
      icon: rocket
      variant: primary
    - text: "GitHub"
      link: "https://github.com/pattern-stack/agentic-patterns-ts"
      icon: github
---

## The shape of the framework

```
Agent = Role × Background × Awareness × Mission
Role  = Persona + Judgments + Capabilities + Responsibilities
Capability = Toolbox + Manual + Playbook
```

Everything composes upward through layers — atoms → protocols → molecules →
rendering → organisms in `@pattern-stack/agentic-core`, then events → gates →
runner → transport → runtime → workflows → conversation → exporters →
presets in `@pattern-stack/agentic-runtime`. Core never imports runtime.

## Install

```sh
bun add @pattern-stack/agentic-core @pattern-stack/agentic-runtime
```

The server (`@pattern-stack/agentic-server`) and CLI (`@pattern-stack/agentic-cli`)
version in lockstep with the runtime; core floats independently.

## Where to start

- **[Getting started](getting-started.md)** — zero to a running agent, with or
  without an API key.
- **Guides** — authoring toolboxes and plays; the runner & provider strategy.
- **Memory** — cross-session memory: the store, the recall surface, and the
  evolution cookbook.
- **Reference** — the SSE event catalog (generated from the runtime manifest)
  and playground event persistence.
- **Architecture Decisions** — the ADR trail, from the constellation dashboard
  to compositional memory.
- **Design notes** — dated design and planning documents, kept honest and
  clearly separated from shipped API.

Live API surfaces ship with the server itself: Scalar API docs at `/docs` and
an `llms.txt` at `/llms.txt` on any running instance.

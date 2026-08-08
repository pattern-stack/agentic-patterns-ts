---
title: "ADR 0003 — `delegateTo` pad sharing is default-on through a fork"
---

- **Status:** Accepted (2026-07-15) — ratified for
  [#269](https://github.com/pattern-stack/agentic-patterns-ts/issues/269).
- **Date:** 2026-07-15
- **Context owner:** Doug
- **Scope:** `@agentic-patterns/runtime` agent-as-tool delegation (`delegateTo` /
  `NodeToolbox`), runner `ToolExecutionContext` threading, and the scratchpad
  contract documented for consumers.

## Context

#124 established one host-passthrough chain across the agent-as-tool seam:
`AgentStep` places the live scratchpad, dependencies, and event bus in
`RunOptions.host`; a runner copies that host onto each `ToolExecutionContext`;
and `nodeTool` forks the inherited scratchpad before entering the delegated
node. Run-scoped entries are shared by reference through that fork, while
branch-scoped entries start fresh per delegated call. `join()` / merge-back is
deliberately absent at this seam.

The live `AgentRunner` already carried that context, but `MockRunner` dispatched
tools without it. No-LLM tests therefore observed a fresh-pad behavior that was
different from production. At the same time, `sequentialAgent`'s published docs
still said subagent teams could not see the pad, even though #124 had made the
sharing ambient.

Consumer evidence favors visibility. dealbrain kept evidence pools in closures
because state appeared unavailable across delegation, while aloevera-ts
hand-built team plumbing to make pad-aware briefs. Both are symptoms of an
unstated or inconsistently exercised contract, not requests for stronger
isolation.

## Decision

Run-scoped share-through-fork is the default for `delegateTo` and `NodeToolbox`
under every runner that threads `ToolExecutionContext`:

- Each delegated call receives a fork of the live caller's scratchpad, never an
  alias of the caller's branch state.
- Run-scoped slots are shared by reference across the delegation tree.
- Branch-scoped slots are isolated across every fork, including parallel and
  delegated branches.
- No team-level `sharePad` or `padSharing` option is added. Slot scope is the
  existing isolation control at the state declaration. It does not provide a
  middle setting for "shared across stages but isolated only across
  delegation"; that narrower control will be designed only if a real consumer
  needs it.
- `join()` / merge-back remains outside the delegation seam.

`MockRunner` therefore builds the same minimal context needed at its two tool
dispatch sites: `runId`, `traceId`, `parentToolCallId`, and the caller's `host`.
The workflow docs state the contract, and the #269 regression suite pins it on
both the mock and live runner rails.

### Alternatives rejected

- **`SubagentSpec.sharePad` or `delegateTo(opts.padSharing)`** — rejected as a
  second, coarser switch over behavior already declared by each slot's scope.
  It would also leave the unrequested stage-shared/delegation-isolated middle
  ground unresolved.
- **Explicit construction-time `scratchpad` threading** — rejected because it
  captures build-time state instead of inheriting the live run. The live host
  wins by design, as pinned by host-propagation Test 5; construction-time state
  remains only the no-host fallback.

## Consequences

- The workflow docs and generated declarations are the public contract:
  run-scoped state crosses delegation by reference, branch-scoped state stays
  per fork, and no join crosses the seam.
- Consumers can retire closure-based evidence pools and hand-threaded
  construction-time scratchpads when the state belongs to the run.
- Isolation-sensitive state should use `scope: "branch"`. Consumers needing
  separate run-scoped pools can key separate packs or slots.
- Branch scope isolates across all forks, not delegation alone. A future
  team-specific isolation control requires consumer evidence and a separate
  design decision.
- `join()` / merge-back remains a v2 concern because call-and-return delegation
  has no defined deterministic merge order.

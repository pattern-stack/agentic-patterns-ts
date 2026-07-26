---
title: "ADR-0006 render artifacts — runtime slice"
stack: render-artifacts
phase: spec
date: 2026-07-26
adr: docs/adr/0006-render-artifacts.md   # Accepted on the docs/adr-render-artifacts branch,
                                          # not yet merged into this worktree's branch
                                          # (feat/render-artifacts, based on main). Full text
                                          # pulled via `git show docs/adr-render-artifacts:...`.
provenance: >
  Core slice (packages/agent-core/src/molecules/render-artifact.ts) already lands
  RenderArtifact/TableArtifactData/tableArtifact/isTableArtifact/artifactMarker/
  DEFAULT_ARTIFACT_BYTE_CEILING, exported from core's barrel, 21 passing tests.
  This spec covers the remaining runtime slice: the emission seam on
  ToolExecutionContext, the two new event fields, the runner wiring across all
  three tool-dispatch sites, and transport-side ceiling enforcement.
---

# Spec — ADR-0006 runtime slice

## Scope confirmed against real line numbers (2026-07-26, branch `feat/render-artifacts` @ de52e44)

- `packages/agent-core/src/molecules/toolbox.ts:29-46` — `ToolExecutionContext`.
  Already has `emit?`, `runId?`, `traceId?`, `parentToolCallId?`, `host?`. No
  `publishArtifact` yet — needs adding.
- `packages/agent-runtime/src/events/types.ts:64-78` (`MessageCompleteEvent`),
  `:140-151` (`ToolCallEndEvent`) — neither has `artifacts`. Neither has
  `structuredContent` either (needed for ADR §9).
- `packages/agent-runtime/src/runner/types.ts:118-191` (`RunOptions`) — no
  publication gate yet.
- `packages/agent-runtime/src/runner/agent-runner.ts`:
  - `buildToolCtx` (`:247-289`) is the **single seam** all three tool-dispatch
    sites already funnel through (`:635`, `:950`, `:1728`) — confirmed via
    grep, matches the doc comment "single adapter so the three call sites
    don't drift." This is where `publishArtifact` gets wired once.
  - `run()`'s terminal-tool exit: `:690-733`. The flattening bug is real —
    `:694-697` — `typeof terminalHit.result === "string" ? ... :
    JSON.stringify(...)`.
  - `convertExecutableTools()` (`:896-989`, used by `runStructured()`'s
    SDK-driven tool loop) has its own `tool.end` emission (`:968-983`) but
    **no terminal-tool concept at all** — `runStructured()` never flattens a
    terminal result this way (its own tiered logic elsewhere handles that).
    So ADR §9 (structured terminal content) does not apply here; only the
    artifact-collection wiring does.
  - `stream()`'s terminal-tool exit: `:1784-1827`, with the **identical**
    flattening bug at `:1787-1790`, explicitly commented "parity with run()".
    Fixing only `run()` and leaving `stream()` broken would break that
    documented parity, so both get the ADR §9 fix.
- `packages/agent-runtime/src/transport/sse-formatter.ts`:
  - `mapEventToSSE` (`:154`), `agent.tool.end` case (`:235-245`),
    `agent.message.complete` case (`:173-186`) — neither forwards `artifacts`
    today (confirms the ADR's own claim: "the formatter has no truncation
    helper at all").
  - `SSE_WIRE_EVENT_NAMES` / `SSE_EVENT_NAMES` are **event-name** manifests,
    not field manifests — adding a payload field to an existing event needs no
    entry there. No change needed to those.
- `packages/agent-server/src/sse.ts` — delegates to `toSSEMapping(event)`
  (verified, confirmed zero-change as CLAUDE.md's task brief already claimed).

## 1. Core: emission seam

`ToolExecutionContext` (`toolbox.ts`) gains:

```ts
readonly publishArtifact?: (artifact: RenderArtifact) => void;
```

Fire-and-forget, same philosophy comment as `emit?`. Deliberately independent
of the tool's return value (ADR §1) — core never awaits or inspects it, never
validates the artifact, never touches `Toolbox.execute`'s try/catch. Imports
`RenderArtifact` from `./render-artifact.js` (sibling molecule, no layering
issue).

## 2. Events

`packages/agent-runtime/src/events/types.ts`:

- `ToolCallEndEvent` gains `readonly artifacts?: readonly RenderArtifact[];`
- `MessageCompleteEvent` gains `readonly artifacts?: readonly RenderArtifact[];`
  **and** `readonly structuredContent?: unknown;` (ADR §9 — the un-flattened
  terminal result, carried alongside the still-stringified `content`).

Both optional on both events per ADR §3 ("neither is mandatory"). Import
`RenderArtifact` type-only from `@agentic-patterns/core`.

Scope note: this spec does NOT add `structuredContent` to `RunResult`
(`runner/types.ts`). The ADR's own Scope section names `events/types.ts`,
`transport/sse-formatter.ts`, and the runner's terminal-tool exit — not the
synchronous `RunResult` return value. "The envelope" in ADR §9 means the wire
event; `RunResult.response` stays string-only, unchanged, as today.

## 3. Runner

### 3a. Opt-in gate

`RunOptions` (`runner/types.ts`) gains:

```ts
/**
 * Turn on the render-artifact publication channel for this run (ADR-0006 §2).
 * A tool DECLARES what it can publish (already true today via
 * `ToolDefinition.displayType`); this flag is the other half — the
 * CALLER/registration deciding whether publication is actually wired for a
 * given run. Default `false`: publication costs bytes and may carry data a
 * given surface should not receive, so it must be turned on deliberately
 * rather than leaking by default. When `false`, `ToolExecutionContext.
 * publishArtifact` is omitted entirely (not a no-op function) so a tool can
 * cheaply skip building an artifact it won't be allowed to publish.
 */
publishArtifacts?: boolean;
```

**Why a `RunOptions` flag and not a per-toolbox/per-tool setting:** ADR §2 is
explicit that the tool declares (shape, via `displayType`) and the *caller*
decides whether publication is on — the caller is whoever calls
`run()`/`stream()`/`runStructured()` with a `RunOptions`, i.e. exactly the
seam that already carries `host`, `eventBus`, `abortSignal`. A per-toolbox
flag would leak the decision into tool-authoring code, which ADR §1/§2 say is
the wrong place for a rendering concern.

### 3b. `buildToolCtx` wiring

`buildToolCtx` takes an additional optional `onArtifact?: (artifact:
RenderArtifact) => void` and includes `publishArtifact: a.onArtifact` on the
returned `ToolExecutionContext` **only when `onArtifact` is provided** (so the
gate-off case really does omit the key, per the doc comment above).

Each of the three dispatch sites (`run()` `:632-642`, `convertExecutableTools()`
`:946-957`, `stream()` `:1725-1735`) declares a per-call
`const publishedArtifacts: RenderArtifact[] = [];` in the same closure/loop
body that already scopes that call's `toolResult`/`errorMsg`, and passes:

```ts
onArtifact: options?.publishArtifacts
  ? (a) => publishedArtifacts.push(a)
  : undefined,
```

Then attaches `...(publishedArtifacts.length > 0 ? { artifacts: publishedArtifacts } : {})`
to that call's own `agent.tool.end` event (`run()` `:656-673`,
`convertExecutableTools()` `:968-983`, `stream()` `:1766-1779`) — additive,
same spread-if-present style already used for `displayType`.

Out of scope for this slice: aggregating tool-published artifacts onto
`message.complete`. The ADR allows it (§3, "may also carry artifacts... or for
artifacts with no single producing tool") but does not require it, and no
current producer needs it — `message.complete.artifacts` is wired end-to-end
(type + transport) and ready for a future increment, but `agent-runner.ts`
does not populate it today.

### 3c. ADR §9 — preserve structured terminal output

At both terminal-exit sites (`run()` `:693-697`, `stream()` `:1787-1790`):

```ts
const structuredContent =
  terminalHit.result !== undefined && typeof terminalHit.result !== "string"
    ? terminalHit.result
    : undefined;
const content =
  typeof terminalHit.result === "string"
    ? terminalHit.result
    : JSON.stringify(terminalHit.result ?? "");
```

`content` computation is **byte-identical to today** — same ternary, same
`JSON.stringify(... ?? "")` fallback. `structuredContent` is new and only
attached to the `agent.message.complete` event
(`...(structuredContent !== undefined ? { structuredContent } : {})`) — never
to `RunResult` (see §2 scope note). A string terminal result never sets
`structuredContent` (omitted key, not `undefined` field) — degrades to
exactly today's behavior for every existing consumer.

## 4. Transport

`packages/agent-runtime/src/transport/sse-formatter.ts`:

- `agent.tool.end` case gains `artifacts` in its payload when present.
- `agent.message.complete` case gains `artifacts` **and** `structured_content`
  (snake_case, mirroring `finish_reason`/`cost_usd`) when present.
- Wire shape per artifact (pinned): `{ id, display_type, data?, title?,
  truncated? }` — snake_case `display_type`, matching the existing
  `ToolSchema.displayType → display_type` precedent at `:223`/`:243`.
- Ceiling enforcement (ADR §4): a new local helper serializes each artifact
  (`JSON.stringify(artifact)`, UTF-8 byte length via a local `TextEncoder` —
  same technique as `workflows/state-events.ts`'s `byteLength`, duplicated
  locally rather than imported, since `transport` does not currently depend on
  `workflows` and importing it would risk a reverse-layering violation for a
  three-line helper). A `JSON.stringify` throw (circular/BigInt) is treated as
  an automatic breach (`Infinity` bytes) — same "hard drop over guesswork" as
  every other rule in this ADR.
  - Under the ceiling: ship the artifact as-is (mapped to wire shape).
  - Over the ceiling: replace with `artifactMarker(artifact)` (core helper —
    identity + type, no `data`, `truncated: true`) and `console.error` the
    breach (id, displayType, size, ceiling) — loud, never silent, never a
    partial reshape.
- **Configurable, not hardcoded**: `toSSEMapping(event, opts?)` gains an
  optional second parameter `{ artifactByteCeiling?: number }`
  (default `DEFAULT_ARTIFACT_BYTE_CEILING` from core). `SSEFormatter`'s
  constructor accepts the same options object and threads it through
  `format()`/`extractPayload()`. Every existing call site
  (`toSSEMapping(event)`, `new SSEFormatter()`, `SSEFormatter.
  extractPayload(event)` in `agent-server/src/sse.ts`, `exporters/sse.ts`,
  `conversation/conversation.ts`, `streaming/stdio-adapter.ts`) keeps
  compiling unchanged and gets the default ceiling — purely additive.
- Omit the `artifacts` key entirely when a call published none (additive,
  non-breaking — the #324 precedent named in the brief).

## 5. Tests (new)

- `packages/agent-core/src/molecules/__tests__/toolbox.test.ts` —
  `ToolExecutionContext.publishArtifact` is optional, fire-and-forget, never
  invoked or interpreted by `Toolbox.execute`.
- `packages/agent-runtime/src/runner/__tests__/agent-runner.test.ts` /
  `agent-runner-stream.test.ts`:
  - `publishArtifacts: false` (default) → `ctx.publishArtifact` is
    `undefined` at the dispatch site.
  - `publishArtifacts: true` → a tool calling `ctx.publishArtifact(...)`
    surfaces on that call's `agent.tool.end.artifacts`; a call that never
    calls it emits no `artifacts` key.
  - `run()` and `stream()`: a non-string terminal result attaches
    `structuredContent` to `agent.message.complete` and leaves `content`
    exactly as today (`JSON.stringify` of the same value); a string terminal
    result has no `structuredContent` key at all.
- `packages/agent-runtime/src/transport/__tests__/sse-formatter.test.ts`:
  - `tool.end`/`message.complete` forward `artifacts` (snake_case
    `display_type`) when present, omit the key when absent.
  - `message.complete` forwards `structured_content` when present.
  - An artifact over the ceiling is replaced by a marker
    (`data` absent, `truncated: true`) and logs via `console.error`; a custom
    `artifactByteCeiling` option changes the breach threshold.

## Out of scope (per task brief)

- `packages/agent-dashboard/**`, `packages/agent-server/**` (verified
  zero-change).
- Run-state persistence, prose-ref expansion beyond `[#N]`, JSON-shaped-answer
  fallback — all explicit ADR Follow-ups, not this slice.

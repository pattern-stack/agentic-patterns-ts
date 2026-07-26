# ADR 0006 — Render artifacts: a second data channel on the response envelope

- **Status:** Proposed (2026-07-26)
- **Date:** 2026-07-26
- **Context owner:** Doug
- **Scope:** `@agentic-patterns/core` (`molecules/tool-schema.ts` — the
  `displayType` convention), `@agentic-patterns/runtime`
  (`events/types.ts`, `transport/sse-formatter.ts`, `runner/agent-runner.ts`
  terminal-tool exit), `@agentic-patterns/server` (wire grammar passthrough),
  and `@agentic-patterns/dashboard` (chat render + ref expansion).

## Context

An agent answered `"List all deals we closed in may"` with:

```json
{"answer":"We closed 23 deals in May 2026. [ref_key: crm_table:e891ce4dd…]"}
```

The chat rendered that verbatim — raw JSON, with the reference as inert text —
even though the run had genuinely produced the table: the trace shows
`run_select` dropping a row into `backpack.evidence-pool` (`0 → 1`, `drop #0`).

Three separate mechanisms are tangled in that one screenshot. Pulling them
apart is the whole point of this ADR, because only **one** of them is actually
missing.

### 1. What a tool returns to the agent — not our concern

A tool may return a ref, a preview, or the full dataset. That is the tool
author's decision, driven by token cost and the model's needs. The framework
has, and should keep, **no opinion** here.

An earlier draft of this design proposed a knob on the tool's return value
(`ref | inline | both`). That was wrong: it puts a rendering concern inside
the model's data path, where it does not belong.

### 2. What the response envelope carries to the client — **the gap**

Today the envelope has exactly one data path, and it is welded 1:1 to what the
model saw. `tool.end` forwards the tool's return value verbatim and uncapped
(`transport/sse-formatter.ts:239` — `result: event.result`; the formatter has
no truncation helper at all). So:

- If a tool returns a **ref** (cheap, correct for the model), the client
  receives only that ref and can render nothing.
- If a tool returns the **full dataset** so the client can render it, that
  payload is also pushed through the model's context, where it is pure cost.

There is no channel for *data the client should render that the model never
saw*. That is the missing primitive.

The state surfaces do not close the gap either, by deliberate design:

- `agent.backpack.drop` (`events/types.ts:384`) carries **counts and indexes
  only** — `accepted`, `merged`, `skipped`, `indexes`, `sizeBefore`,
  `sizeAfter`. No entry content.
- `agent.scratchpad.write` / `.read` carry **byte-capped previews**
  (`after`, `preview`).

`chat/parts.tsx:417-420` already records this as a known, accepted limitation:

> the wire carries byte-capped ENTRY previews only — no raw TIn payload — so
> the mockup's per-row expansion pane (raw → expand() → entry) cannot be
> rendered without fabricating data

That byte-cap is a good decision for a telemetry stream and this ADR does not
reverse it. Render artifacts are a **separate, opt-in channel** — not a
loosening of the state events.

### 3. Refs written into prose, expanded by the client — partly built

`chat/parts.tsx:50` (`linkifyCites`) already rewrites **`[#N]`** into clickable
`.cite` chips that seek the backpack entry which minted index `N`. The agent
above used `[ref_key: crm_table:<hash>]`, which matches nothing and stays inert.

So the convention exists but is (a) index-only and (b) expands by *seeking the
rail*, never by rendering — because of the gap in §2.

### What already exists and is unused

`ToolSchema.displayType` (`molecules/tool-schema.ts:54-57`, "Opaque to core;
convention: `code | diff | bash`") flows end-to-end today:
`ToolDefinition` → `AgentRunner`'s `displayTypes` map (`agent-runner.ts:358`)
→ stamped on `tool.start`/`tool.end` → emitted as `display_type` over SSE
(`sse-formatter.ts:223,243`), shipped in #352.

**The dashboard consumes it in zero non-test files.** The label is already on
the wire; nothing reads it.

### A second, smaller defect

A terminal tool's return value *is* the run's final message, and the runner
flattens it (`runner/agent-runner.ts:694`):

```ts
const content = typeof terminalHit.result === "string"
  ? terminalHit.result
  : JSON.stringify(terminalHit.result ?? "");
```

A terminal tool returning a structured result is legitimate, but its structure
is destroyed before it reaches any client — which is why the answer above
renders as a JSON blob. Any client-side unwrapping would be guesswork against
a shape the framework threw away.

## Decision

**Add a render-artifact channel to the response envelope, independent of the
tool's return value to the model.**

1. **Artifact envelope.** A framework-level shape describing something a client
   can render directly, without resolution:

   ```ts
   interface RenderArtifact {
     readonly id: string;              // correlation handle (e.g. "crm_table:e891…")
     readonly displayType: string;     // "table" | "code" | "diff" | … (open)
     readonly data: unknown;           // shape implied by displayType
     readonly title?: string;
     readonly truncated?: boolean;     // set when the producer capped `data`
   }
   ```

   For `displayType: "table"` the canonical `data` shape is
   `{ columns: string[]; rows: unknown[][] }`. `displayType` stays an open
   string, extending the existing `code | diff | bash` convention rather than
   closing it into an enum.

2. **Publication is two-layer.** The **tool declares** what it can publish (it
   alone knows the shape — this is `displayType`'s existing role); the
   **caller/registration decides whether** publication is on. Emission costs
   bytes and may carry data a given surface should not receive, so it is opt-in
   at the seam that knows the deployment, not baked into the tool.

3. **The agent is not involved.** Artifacts ride alongside the agent's response.
   No prompt change, no output-schema change, no cooperation from the model —
   consistent with the observation that this is a data-return decision
   *alongside* an agent call, not part of it.

4. **Envelope extension is additive.** Artifacts attach to the existing
   envelope as an optional block, following the precedent set by #324, which
   added `cost_usd` / `finish_reason` to `message.complete` as
   "additive, non-breaking". Clients that ignore the block behave exactly as
   they do today.

5. **Refs and artifacts compose.** An agent may still write a bare ref in its
   prose. A client that receives a matching artifact `id` may expand it inline;
   a client that does not simply shows the text. `[#N]` cites keep working
   unchanged. This makes §3 useful without requiring it.

6. **Preserve structured terminal output.** The runner stops discarding the
   structure of a terminal tool's result. The structured value is carried on
   the envelope so a client can render prose + data properly, instead of
   receiving a stringified blob.

## Consequences

**Good**

- The model's context and the client's rendering stop competing. A tool can
  return a two-token ref to the model *and* publish a 500-row table to the UI.
- No new route, no id-resolution round-trip, no client-side fetch state. The
  payload arrives render-ready and is inserted immediately.
- Reuses `displayType`, which is already plumbed end-to-end and currently
  wasted.
- The telemetry byte-cap survives untouched; artifacts are a distinct, opt-in
  channel.
- Purely additive on the wire — existing clients are unaffected.

**Costs / risks**

- **Payload size.** Artifacts can be large. Producers must be able to cap and
  mark `truncated`; the opt-in default keeps streams lean when unused.
- **A second source of truth.** An artifact can drift from what the model was
  told. Mitigated by the correlation `id` and by artifacts being derived from
  the same tool execution.
- **Redaction.** Artifacts bypass the model, so anything the model was not
  allowed to see could still reach a surface. Publication must respect the same
  scope/redaction rules as the rest of the envelope
  ([ADR-0005](0005-session-scope.md)).
- **Open-string `displayType`** means clients must degrade gracefully on
  unknown types (render JSON, never crash).

## Alternatives considered

- **Fetch-on-demand state API** (`GET /conversations/:id/state?key=…`).
  Rejected: adds a route, an auth surface, client fetch/loading state, and a
  round-trip before anything renders — to deliver data the producer already had
  in hand at emit time.
- **Fatten `backpack.drop` / `scratchpad.write` with full payloads.**
  Rejected: reverses a deliberate byte-cap on a high-frequency telemetry
  stream, and taxes every run to serve the rare renderable one.
- **A `ref | inline | both` knob on the tool's return value.** Rejected: puts a
  rendering concern in the model's data path; conflates §1 with §2.
- **Require terminal tools to return strings.** Rejected: pushes a framework
  limitation onto every agent author and discards legitimately structured
  output.
- **Client-side heuristic unwrapping of JSON-looking answers.** Rejected as the
  primary fix: guesswork against a shape the framework discarded. May still be
  worth a narrow, conservative fallback for agents that never adopt artifacts.

## Open questions

- Does an artifact attach to `tool.end`, to `message.complete`, or to both?
  Tool-scoped is the natural producer; message-scoped is what a chat bubble
  renders. Likely both, with the message block referencing tool-produced ids.
- Should artifact publication be capped/paginated at the framework level, or
  left to the producer with only the `truncated` flag as the contract?
- Do artifacts persist? `ConversationStore` currently stores message parts;
  replaying a stored conversation with artifacts is unspecified.

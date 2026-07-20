# In-process terminal approval loop for `ap run` — feasibility

All paths relative to `/Users/dug/Projects/sandbox/agentic-patterns-ts/.claude/worktrees/atomic-soaring-taco`.

## Verdict

Fully feasible, in-process only, no server/runtime changes. The entire mechanism (gate blocks inside `bus.publish`, request delivered by bus subscription, answer delivered by `registry.resolve`) is transport-agnostic by design — the HTTP leg in `agent-server` is just one transport. The CLI can be another with ~80–120 LOC in `packages/agent-cli/src/commands/run.ts`.

## How the blocking mechanism works (verified)

1. **Runner parks inside publish.** `AgentRunner.emitIntent` (`packages/agent-runtime/src/runner/agent-runner.ts:162-185`, call sites :531/:819/:1462) does `await this.eventBus.publish(intent)`. `AgentEventBus.publish` (`packages/agent-runtime/src/events/agent-event-bus.ts:54-79`) detects `.intent`-suffixed events and runs `await gate.check(currentEvent)` for each gate **before** publishing. So yes — the runner's event loop (the async generator) stalls inside `publish` while a gate is pending. On block it emits `agent.tool.rejected` and returns `[]`; the runner detects the block via a temporary `agent.tool.rejected` subscription correlated by `originalIntent.toolCallId` (not by publish return value).

2. **The gate awaits a registry promise.** `createHumanInputApprovalGate` (`packages/agent-runtime/src/interaction/approval-gate.ts:52-91`): `approvalFn` registers `registry.create(toolCallId, {kind:"approval", timeoutMs})` **first**, then fire-and-forgets (`void bus.publish(...)`) an `agent.input.request` event carrying `traceId`, `runId`, `correlationId` (= `toolCallId`), `prompt`, `toolName`, `arguments`. It then awaits the registry promise; `approve → allow`, anything else → block. In-flight decisions are memoized per `toolCallId` because the runner gate-checks each intent twice (observability `emit` then `emitIntent` — approval-gate.ts:14-19); one human answer settles both.

3. **Resolution is a plain in-memory Map.** `PendingInputRegistry` (`packages/agent-runtime/src/interaction/pending-input-registry.ts:49-128`): `create()` parks a promise keyed by correlationId (optional timeout → auto-DENY with `timedOut:true`, fail closed); `resolve(correlationId, {decision})` settles it and returns `false` for orphans; `denyAll()` for teardown. It "neither emits the outbound event nor knows about HTTP" (doc, lines 10-13).

4. **`conversation.stream()` can never surface the request.** `Conversation.stream` (`packages/agent-runtime/src/conversation/conversation.ts:211-322`) only yields what `this.runner.stream(...)` yields (plus its own `conversation.start/end`). When the gate blocks, the runner generator is parked inside `publish`, so `stream()`'s `for await` is awaiting a `.next()` that won't resolve — the `agent.input.request` exists **only** as a bus publication. This is exactly why the server route bridges via `eventBus.subscribe("agent.input.request", ...)`.

5. **Reference implementation** (`packages/agent-server/src/routes/conversations.ts:363-444`): subscribe before draining; filter with `turnTraceId ??= event.traceId` then `if (e.traceId !== turnTraceId) return` so a concurrent conversation's prompt never bleeds in; track `pendingForTurn` correlationIds; in `finally`, unsubscribe and `inputRegistry.resolve(id, {decision:"deny"})` each still-pending id (fail-closed teardown). The answer leg (`POST /conversations/:id/input`, :454+) is nothing but `inputRegistry.resolve(correlation_id, response)` — the `:id` is addressing sugar.

## (a) Exact wiring for `ap run`

In `runRunCommand` (`packages/agent-cli/src/commands/run.ts:68-198`), after `const eventBus = getAgentEventBus()` (line 118) — mirroring `playground.ts:93-112`:

```ts
const inputRegistry = new PendingInputRegistry();
const approvalTools = parseApprovalTools(process.env.AP_APPROVAL_TOOLS); // hoist/export from playground.ts:623 (or duplicate ~8 lines)
if (approvalTools.size > 0) {
  eventBus.addGate(createHumanInputApprovalGate({
    bus: eventBus, registry: inputRegistry, tools: approvalTools,
    // optional AP_APPROVAL_TIMEOUT_MS, same as playground
  }));
}
```

Both `PendingInputRegistry` and `createHumanInputApprovalGate` are already exported from `@agentic-patterns/runtime` (playground.ts imports them at :26/:30). The runner resolved by `ExecutionService.resolveRunner({eventBus,...})` (run.ts:120) already carries this same bus, and `conversation.stream(line)` with no `eventBus` option falls back to `getAgentEventBus()` (conversation.ts:222) — the **same singleton**. So gate, runner, and stream all share one bus with zero plumbing changes.

**Per-turn subscription** (inside `streamOnce`/`runRepl`, wrapped around `renderStream`, run.ts:386-433):

```ts
let turnTraceId: string | undefined;            // set from first streamed event in renderStream
const pendingForTurn = new Set<string>();
const onInputRequest = async (ev: BaseEvent) => {
  const e = ev as AgentEvent;
  if (e.type !== "agent.input.request") return;
  if (turnTraceId !== undefined && e.traceId !== turnTraceId) return;
  pendingForTurn.add(e.correlationId);
  const decision = await select({
    message: `${e.prompt}  ${dim(formatArgs(e.arguments))}`,
    options: [{ value: "approve", label: "approve" }, { value: "deny", label: "deny" }],
  });
  inputRegistry.resolve(e.correlationId, {
    decision: isCancel(decision) ? "deny" : (decision as "approve" | "deny"),
  });
};
eventBus.subscribe("agent.input.request", onInputRequest);
try {
  await renderStream(...);   // renderStream sets turnTraceId ??= event.traceId on each event
} finally {
  eventBus.unsubscribe("agent.input.request", onInputRequest);
  for (const id of pendingForTurn) inputRegistry.resolve(id, { decision: "deny" }); // fail closed on abort/error
}
```

**Filter / id availability:** filter by `traceId`, exactly like the server. The request event carries `intent.traceId` (approval-gate.ts:71), which equals the conversation's `traceId` because `Conversation.stream` passes `traceId` into the runner (conversation.ts:265) — and the first event `renderStream` sees (`agent.conversation.start`, conversation.ts:230-236) carries that same traceId. In practice `ap run` has exactly one conversation on the bus so the filter is belt-and-braces, but it keeps parity with the reference and protects against nested/multi-agent bleed. `renderStream` needs a one-line addition (or a callback/shared ref) to capture `turnTraceId` from the first event.

Cosmetics: also add an `agent.tool.rejected` case to `renderEvent` (currently ignored at run.ts:511-513) so a deny prints e.g. `✗ blocked: Human declined approval for 'X'` instead of silence.

## (b) Can @clack/prompts `select()` run while `renderStream` is mid-iteration?

**Yes — no restructuring of the stream needed.** When the gate blocks, the whole chain (`renderStream`'s `for await` → `conversation.stream().next()` → `runner.stream().next()` → `emitIntent`'s awaited `publish`) is one parked promise chain; the JS event loop is idle. The `agent.input.request` is delivered through `void bus.publish(requestEvent)` (approval-gate.ts:83) — `EventBus.publish` (`packages/agent-runtime/src/events/event-bus.ts:130-137`) awaits each handler, so the async `onInputRequest` handler runs inside that floating promise, can freely `await select(...)`, and its eventual `registry.resolve()` unparks the gate → runner → renderStream.

Terminal contention is also safe: no clack prompt is active during `renderStream` (the REPL's `text()` already settled, run.ts:406), and **no stdout writes race the select** — the runner is blocked, so no chunks arrive while the prompt is up (same invariant the server route relies on, conversations.ts:387). The select just appears after whatever partial output exists; write a leading `\n` for cleanliness. Handler exceptions are swallowed by `EventBus.publish`'s per-handler try/catch (event-bus.ts:134-136), so pair the gate with a `timeoutMs` (or rely on the teardown deny) so a crashed prompt can't hang the run forever.

One caveat: Ctrl+C during the prompt is captured by clack (→ `isCancel` → resolve deny), not by the REPL's SIGINT/AbortController path (run.ts:418-422); the abort-check inside `renderStream` (run.ts:449) can't run while parked, which is another reason the `finally` deny-sweep above matters.

## (c) Is in-process `registry.resolve()` sufficient?

**Yes.** The HTTP `POST /conversations/:id/input` route does nothing beyond `inputRegistry.resolve(correlation_id, response)` plus validation/404 sugar (conversations.ts:447-460+). The registry is explicitly transport-agnostic (pending-input-registry.ts:5-14). Same-process resolve is exactly what the fail-closed teardown in the server already does (conversations.ts:438-442). No HTTP leg, no server, no SSE.

## (d) Effort size

**Small — S (~half a day, one PR), CLI-only.**
- `packages/agent-cli/src/commands/run.ts`: gate/registry setup (~12 LOC), per-turn subscribe/prompt/teardown (~35 LOC), `turnTraceId` capture in `renderStream` (~3 LOC), `agent.tool.rejected` render case (~5 LOC), `select` import.
- Hoist `parseApprovalTools` from `playground.ts:623` into a shared CLI helper (~10 LOC move).
- Tests: gate-block → prompt → approve/deny → teardown-deny, against a mock runner (~100 LOC).
- Zero changes to `@agentic-patterns/runtime` or `agent-server`; all primitives are already exported.

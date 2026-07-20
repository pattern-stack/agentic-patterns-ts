# Scout dossier — TS server pre-work: N5 torn-stream fix + cancellation

Scope: the two strategy-neutral server prerequisites from the harness-cockpit plan
(gap-analysis §2.6.4 / §4 pre-work): (A) fix the torn SSE stream on pre-token runner failure
(N5), (B) design `POST /conversations/:id/cancel`. Every claim below is grounded in files read
at commit `10d5c0b` (worktree `atomic-soaring-taco`, clean). All paths are repo-relative to
the worktree root unless noted.

Verified anchors from the prior reports (all still hold at 10d5c0b):

| Claim (report) | Anchor re-verified |
|---|---|
| Drain loop has no catch, no SSE error frame | `packages/agent-server/src/routes/conversations.ts:391-406` — `try { for await … writeSSE(done) } finally { … }`, no `catch` |
| `done` terminator carries `{run_id}` | `conversations.ts:403-406` |
| Server has no cancel route | `conversations.ts` (full read: only POST create :63, 4 read routes, POST messages :331, POST input :454); `app.ts:26-85` mounts nothing else conversation-shaped |
| React "Stop" = fetch abort, aborted ≠ error | `packages/agent-dashboard/src/chat/useChat.ts:135-186, 198-204`; `api/chat-client.ts:227-236` (signal → fetch) |
| `agent.message.cancel` exists in vocab but nothing emits it | type `packages/agent-runtime/src/events/types.ts:203-206`; wire mapping `transport/sse-formatter.ts:103-104, 371`; collector consumer `admin/collector.ts:335`; grep over runtime/server/cli non-test sources: **zero production emitters** |
| RunOptions has no abort slot | `packages/agent-runtime/src/runner/types.ts:112-141` (full `RunOptions` read — no signal field) |

---

## Part A — N5: torn SSE stream on pre-token runner failure

### A.1 Failure mechanics (exact, code-level)

The failing path, end to end:

1. **Injection point** — `AgentRunner.stream` resolves the model **before its first yield**:
   `packages/agent-runtime/src/runner/agent-runner.ts:1123`
   `const model = await this._resolver.resolve(agent.getModel());`
   Throw sources inside `resolve`:
   - agent declares no model under a resolver-backed runner → `Promise.reject` at
     `packages/agent-runtime/src/providers/model-resolver.ts:266-275`;
   - unknown/unresolvable model id → `throw new Error(this._unknownIdError(modelId))` at
     `model-resolver.ts:299`;
   - provider load for a known-vendor id can throw (e.g. `AI_LoadAPIKeyError` from provider
     instantiation) via `PROVIDERS[inferred].load(modelId)` at `model-resolver.ts:297`.
   Other pre-yield throw sites in the same window: `convertTools` (:1129),
   `agent.renderInitialPrompt` (:1134). First yield is only at :1157 (`conversation.start`).
   `ap playground` runs resolver mode by default (`packages/agent-cli/src/commands/playground.ts:123-140`,
   `resolveAgentModel: true`), so this path is live in the exact deployment the TUI targets.

2. **Conversation wrapper** — `Conversation.stream`
   (`packages/agent-runtime/src/conversation/conversation.ts:211-322`):
   yields its own `agent.conversation.start` (:236) *before* touching the runner, then the
   `for await` over `runner.stream(...)` (:255) rejects at first `next()`. The catch (:286-288)
   records the error, an Exchange is still built and pushed (:290-302), persisted if a store is
   wired (:304-305), `agent.conversation.end` `{reason:"error"}` is yielded (:309-315), and the
   error is **rethrown** (:319-321).

3. **Route drain loop** — `packages/agent-server/src/routes/conversations.ts:391-406`: the
   `for await` forwards `conversation.start` and `conversation.end`, then rethrows. There is no
   `catch` → the `done` write at :403-406 is skipped and the `streamSSE` callback rejects.

4. **Hono swallows it** — hono 4.12.31 (`node_modules/.bun/hono@4.12.31/…/dist/helper/streaming/sse.js`),
   internal `run()`: with no `onError` argument (the route passes none) a rejected callback is
   just `console.error(e)` + `stream.close()`. **No `error` frame, no `done`, HTTP status was
   already 200.** Every mid-stream LLM failure, by contrast, is already well-formed: the
   `fullStream` `case "error"` at `agent-runner.ts:1313-1343` emits `llm.end` + `agent.error`,
   then `hadError` ends the run cleanly with `conversation.end` and a normal `return`
   (:1366-1376) — so the route writes `done`. **N5 is exclusively about throws outside the
   fullStream loop** (pre-token resolver/setup failures, plus any unexpected throw).

Note on the live-observed "exactly 14 bytes `data: {"conver`": frame loss on this path is
confirmed by the code (no catch, no done), but the specific truncation *mid-frame, with the
`event:` line missing* is a flush/close race inside hono/node-server we could not fully derive
from source (`StreamingApi.write` enqueues whole frames; `close()` in `run()`'s finally races
the response pull loop). Not load-bearing: after the fix below the callback resolves normally,
`close()` happens only after all `writeSSE` promises settle, and nothing is torn.

### A.2 The fix — catch in the drain loop, write `error` + `done`

Change site: `packages/agent-server/src/routes/conversations.ts` — wrap the existing
`try { for await … done } finally { … }` (:391-443) with a `catch` between them.

Proposed diff (shape-exact; payload matches the canonical `agent.error` wire shape from
`toSSEMapping`, `sse-formatter.ts:204-212`, which the dashboard already decodes at
`agent-dashboard/src/chat/model.ts:522-525` and chat-patterns parses as an `error` event):

```ts
      try {
        for await (const event of conversation.stream(content, { eventBus, maxIterations })) {
          // …unchanged…
        }

        await stream.writeSSE({
          event: "done",
          data: JSON.stringify(turnRunId ? { run_id: turnRunId } : {}),
        });
      } catch (err) {
        // N5 fix: a runner failure BEFORE the first token (model-resolution
        // reject, provider construction failure) rethrows out of
        // Conversation.stream — without this catch the stream tears with no
        // `error` frame and no `done`, and every lenient client renders an
        // empty *successful* reply. Emit the canonical error shape
        // (`toSSEMapping`'s agent.error payload) + the `done` terminator so
        // the turn is honestly failed, then swallow: the failure is already
        // on the wire, hono's run() must not also console.error + tear.
        const message = err instanceof Error ? err.message : String(err);
        const errorType = err instanceof Error ? err.name : "Error";
        try {
          await stream.writeSSE({
            event: "error",
            data: JSON.stringify({ error_type: errorType, message, recoverable: false }),
          });
          await stream.writeSSE({
            event: "done",
            data: JSON.stringify(turnRunId ? { run_id: turnRunId } : {}),
          });
        } catch {
          // client already gone — nothing to deliver to
        }
      } finally {
        // …unchanged (run-metadata stamp, unsubscribe, deny sweep)…
      }
```

Notes:

- **Do not use hono's `onError` third argument instead.** `streamSSE(c, cb, onError)` would
  call `onError` *and then write its own* `event: error` frame whose `data` is the **raw
  message string** (sse.js `run()`), i.e. non-JSON. The dashboard's `parseFrame` drops
  unparseable-data frames (`chat-client.ts:305-315`) and the Go parser expects JSON — hono's
  built-in frame is at best noise, at worst a duplicate. Catch inside the callback and keep
  full control of the frame shape.
- **Optionally also publish** a synthesized `agent.error` on the bus so the admin firehose /
  collector see the failure (pre-token throws today never hit the bus — no exporter records
  anything). `createEvent` is exported from `@agentic-patterns/runtime` (the server's own
  tests import it, `__tests__/conversations.test.ts:13`). Guard on `turnTraceId !== undefined`
  (set from the first forwarded event — `conversation.start` always arrives, :393). This is a
  nice-to-have; the wire fix must not depend on it. Recommended: include it.
- The wire on a fixed pre-token failure becomes:
  `conversation.start` → `conversation.end {reason:"error"}` → `error {error_type,message,recoverable:false}` → `done {}`.
  (`run_id` is absent in `done` because no `agent.message.start` was ever observed —
  `turnRunId` stays undefined, :394-396. Correct and honest.)
- Frame **order** decision: error-after-conversation.end is what falls out naturally (the
  wrapper yields conversation.end before rethrowing). Clients fold on `error` regardless of
  position; do not try to reorder.

### A.3 Persistence / registry state on the failure path

Checked both stores of state:

1. **Server conversation registry** (`Map<string, ConversationEntry>`, `app.ts:28`): the entry
   is written at create time (:201-206) and untouched by the failure — the `Conversation`
   object remains valid and a subsequent `POST …/messages` works. **No cleanup needed.**
2. **`ConversationStore` persistence + in-memory history — real pollution exists.**
   `Conversation.stream`'s catch does NOT skip the bookkeeping: on a pre-token failure it still
   pushes an Exchange with `assistant: ""`, 0 tokens (:290-302) and, when a store is wired
   (playground always wires SQLite unless `AP_PERSISTENCE=0`), `_persistExchange` (:359-390)
   writes a `request` message + an **empty** `response` message. Consequences:
   - session replay shows a phantom empty assistant turn;
   - worse, `_toMessageHistory()` (:395-417) feeds the empty assistant turn back into every
     subsequent LLM call of that conversation.
   Contrast: `send()` (:173-203) throws **before** building the Exchange — nothing recorded.
   `stream()` is inconsistent with its sibling.
   **Recommendation**: as part of this pre-work (small runtime companion change, same PR or a
   stacked one), skip history-push + persistence in `stream()` when
   `error !== undefined && fullResponse === ""` (i.e. the turn produced nothing). Keep
   recording partial-text errored turns (the user saw those tokens; matches React's
   aborted≠error posture). Exact site: guard :290-306 in
   `packages/agent-runtime/src/conversation/conversation.ts`. Also revert the
   `this._exchangeCount += 1` (:219) in that branch so numbering stays dense.
   This is a behavior change in runtime → lands under the lockstep bump anyway (see A.5).

### A.4 Regression test plan

Existing coverage today (see §C for full inventory): **nothing exercises a throwing runner**
on the messages route; `conversations.test.ts` only streams a well-behaved mock.

Unit tests (the cheap, deterministic injection — preferred over a bogus-model fixture):

- File: `packages/agent-server/src/__tests__/conversations-stream-error.test.ts` (or extend
  `conversations.test.ts`; it already has the exact idioms: `makeStreamingRunner` :29-58,
  `mkApp` :60-76, full-body SSE reads).
- Runner double for the pre-token case — throws before first yield, mirroring the
  `resolver.resolve` reject at `agent-runner.ts:1123`:

  ```ts
  const throwingRunner = {
    async run() { throw new Error("run() unused"); },
    // biome: require-yield off — throw-before-first-yield IS the case under test
    async *stream(): AsyncGenerator<AgentEvent> {
      throw new Error('ModelResolver: cannot resolve model id "bogus-9000"');
    },
  };
  ```

  Note: the route drains `conversation.stream(...)` (the wrapper), so the test still sees
  `conversation.start`/`conversation.end` frames before the error — assert all four frames.
- Cases:
  1. *pre-token throw*: POST create → POST messages → read `await res.text()`; assert the body
     contains, in order: `event: conversation.start`, `event: conversation.end` with
     `"reason":"error"`, `event: error` whose data JSON-parses to
     `{error_type: "Error", message: /cannot resolve model id/, recoverable: false}`, and a
     final `event: done` with data `{}` (no `run_id`). Assert `done` is the LAST frame.
  2. *mid-stream throw* (runner yields `agent.message.start` with a runId, then throws):
     assert `error` + `done` present and `done` data is `{"run_id":"<that id>"}`.
  3. *response status/content-type unchanged*: 200 + `text/event-stream` (documents that the
     fix is frame-level, status can't change post-streaming — this is why contracttest passes
     on torn streams).
  4. *(if A.3 recommendation adopted — runtime test, `packages/agent-runtime/src/conversation/__tests__/conversation.test.ts`)*:
     `Conversation.stream` over a throw-before-first-yield runner with an
     `InMemoryConversationStore` → rejects, AND `history.length === 0`, `exchangeCount === 0`,
     store has no messages. Partial-text variant (yield one chunk, then throw) → exchange IS
     recorded with the partial text.

E2E / manual repro (matches the live smoke test):

- No fixture agent currently declares a model (`examples/agents/`: `scope-echo` and
  `toolsmith` are deliberately model-free per their headers; `support-desk`, `workspace`,
  `pipeline2` declare none either — grep for `withModel` in `examples/agents/*/agent.ts` is
  empty). Add `examples/agents/broken-model/agent.ts` with `.withModel("bogus-model-9000")`
  (builder: `packages/agent-core/src/organisms/agent.ts:218`) — under playground's default
  resolver mode this hits `model-resolver.ts:299` exactly. Then:
  `curl -N -X POST :PORT/conversations -d '{"agent_id":"broken-model"}'` → id →
  `curl -N -X POST :PORT/conversations/<id>/messages -d '{"content":"hi"}'` and eyeball the
  four frames. Decide whether the fixture ships permanently (it's also the N5 canary for the
  Go contracttest in R1) — recommended: yes, name it so its purpose is self-evident.

### A.5 Ship notes

- Files touched (minimal fix): `packages/agent-server/src/routes/conversations.ts` + one test
  file. With the A.3 companion: + `packages/agent-runtime/src/conversation/conversation.ts` +
  its test.
- Also fix the stale comment at `conversations.ts:414-416` claiming "`stream.writeSSE` rejects
  mid-loop" on client disconnect — false under hono 4.12.31: `StreamingApi.write` swallows all
  write errors (`dist/utils/stream.js`, `catch {}`), see B.1. Comments that mis-state the
  teardown model will mislead the cancel implementation.
- Versioning: runtime/server/cli bump in lockstep (CLAUDE.md); server-only fix still rides a
  lockstep bump. `main` is protected — lands via PR.

---

## Part B — Cancellation: `POST /conversations/:id/cancel`

### B.1 Ground truth — what happens today when anyone tries to stop a turn

- **The runner cannot be aborted.** `RunOptions`
  (`packages/agent-runtime/src/runner/types.ts:112-141`) has no signal field;
  `AgentRunner.stream`'s `streamText` call (`agent-runner.ts:1208-1213`) passes no
  `abortSignal`. The installed AI SDK (`ai@5.0.216`, runtime dep `^5.0.0`) supports both
  `abortSignal` on `streamText` and an `'abort'` part type in `fullStream`
  (`ai/dist/index.d.ts:1341, 1834`).
- **React "Stop" only stops the client.** `useChat.abort()` aborts the fetch
  (`useChat.ts:198-200`); server-side, @hono/node-server cancels `responseReadable` →
  `StreamingApi.cancel → abort()` sets `aborted=true` and fires `abortSubscribers` — but the
  route registers no `onAbort`, and `write()` swallows errors, so **the drain loop keeps
  pulling runner events to completion**. A stopped turn burns tokens to the end. (This also
  falsifies the `conversations.ts:414-416` comment.)
- **Worse: disconnect during a blocked approval hangs the run forever.** The fail-closed deny
  sweep lives in `finally` (:438-442), which only runs when the generator settles — but a
  gate-blocked run is parked inside `bus.publish` and never settles without a registry
  resolution. Disconnect resolves nothing → the run (and its gate promise) leak until a gate
  `timeoutMs`, if any. The cancel work must fix this via `stream.onAbort`.
- **The CLI's abort is also cosmetic**: `run.ts:419-431` + `renderStream` (:443-457) call
  `stream.return()` and admit "the runner will eventually settle" — generator teardown does
  not reliably abort the provider HTTP call. The same `RunOptions.abortSignal` seam fixes the
  CLI later (R1+, not this pre-work).
- **The event vocabulary is already cancel-shaped, end to end, with zero emitters**:
  `MessageCancelEvent` (`events/types.ts:203-206`), wire name `message.cancel`
  (`sse-formatter.ts:103-104`), `ConversationEndEvent.reason` includes `"cancelled"`
  (`types.ts:196`), UX/DEBUG event profiles list it (`event-profiles.ts:35,91`), the admin
  collector transitions trace status on it (`collector.ts:335`). Emitting it lights up
  existing consumers for free.

### B.2 Options

**Option 1 — bless connection-drop as the cancel contract (what React de-facto does).**
Wire `stream.onAbort` in the messages route to abort the run + deny-sweep pending inputs.
- Pros: no new route; fixes token-burn and the approval-hang for every client including
  today's React.
- Cons: no acknowledgment, client can't distinguish "server stopped it" from "socket died";
  fragile through buffering proxies; un-testable from the Go contracttest without socket
  gymnastics; can't cancel someone else's stuck turn (admin/ops); leaves nothing on the wire
  or in the trace (the disconnect client can't see frames by definition, and without an
  emitter the collector never learns the turn was cancelled — unless the runner emits on
  abort, which is exactly Option 2's machinery).

**Option 2 — explicit `POST /conversations/:id/cancel` + AbortSignal plumbed through the
runtime.**
- Pros: acknowledged, addressable (a second connection/tab/tool can cancel), testable, emits
  canonical `message.cancel`/`conversation.end{cancelled}` frames that the connected stream
  and every exporter observe; the exact contract the Go TUI codes against in R1 (its
  `SendMessage` currently uses `context.Background()` — chat-patterns `chat/model.go:568` per
  gap-analysis §1.1, to be re-verified in the Go scout).
- Cons: new runtime API surface (`RunOptions.abortSignal`), touches the runner loop.

**Recommendation: both, in one server PR — Option 2 as the contract, Option 1's `onAbort`
wiring as the safety net.** The gap-analysis (§2.6.2) frames it as either/or; the code says
they share 90% of the machinery (the AbortController + deny sweep), and drop-hardening is
needed regardless because React today never calls a cancel route.

### B.3 Exact seams (implementation-ready)

**1. Runtime — `RunOptions.abortSignal`** (`packages/agent-runtime/src/runner/types.ts`,
after `parentSpanId` ~:130):

```ts
  /**
   * Abort the run cooperatively: forwarded to the provider call
   * (`streamText({ abortSignal })`) and checked between iterations and before
   * each tool dispatch. On abort the runner emits `agent.message.cancel` +
   * `agent.conversation.end {reason:"cancelled"}` and returns — it does NOT throw.
   */
  abortSignal?: AbortSignal;
```

**2. Runtime — `AgentRunner.stream`** (`agent-runner.ts`), four touches:

- pass `abortSignal: options?.abortSignal` into `streamText` (:1208-1213);
- add `case "abort":` to the `fullStream` switch (:1237-1349) — ai@5 emits it when the signal
  fires mid-provider-call; treat like a soft stop: set an `aborted = true` local, `break`;
- top-of-iteration guard (loop head :1177) and pre-tool-dispatch guard (tool loop :1450):
  `if (options?.abortSignal?.aborted) { …emit cancel + conversation.end(cancelled); return; }`;
- the cancel emission block (single helper, both guards + post-fullStream `aborted` check):

  ```ts
  const cancelEv = createEvent("agent.message.cancel", {
    traceId: effectiveTraceId, runId, parentSpanId: rootSpanId,
    reason: "cancelled by client",
  });
  await this.emit(cancelEv); yield cancelEv;
  const convEnd = createEvent("agent.conversation.end", {
    traceId: effectiveTraceId, runId, conversationId, reason: "cancelled" as const,
  });
  await this.emit(convEnd); yield convEnd;
  return;
  ```

  Decision: the **runner** owns the emission (not the route) so the bus/exporters/collector
  see it on every transport, HTTP or in-process. Return-don't-throw keeps
  `Conversation.stream` on its happy path (partial exchange recorded — aborted ≠ error,
  matching React).
- Also catch provider `AbortError` around the `fullStream` drive as belt-and-braces (some
  providers throw instead of emitting the abort part): `err.name === "AbortError"` → same
  cancel block.

**3. Runtime — `Conversation.stream`** (`conversation.ts:211-267`): accept
`options?.signal?: AbortSignal`, forward as `abortSignal: options.signal` in the
`runner.stream` options (:255-267), and stamp its own trailing `conversation.end` honestly:
`reason: error ? "error" : options?.signal?.aborted ? "cancelled" : "completed"` (:313).
(Today the wire carries two `conversation.start`/`.end` pairs — Conversation's and the
runner's; clients tolerate this; do not try to dedupe in this arc.)

**4. Server — `ConversationEntry.activeTurn`** (`routes/conversations.ts:35-50`):

```ts
export interface ConversationEntry {
  conversation: Conversation;
  agentId: string;
  context?: Record<string, unknown>;
  contextRedacted?: readonly string[];
  /** Set while a POST …/messages turn is streaming; cleared in its finally. */
  activeTurn?: { controller: AbortController; runId?: string; startedAt: number };
}
```

**5. Server — messages route** (`conversations.ts:331-445`):

- at the top of the `streamSSE` callback: create `const controller = new AbortController()`;
  set `entry.activeTurn = { controller, startedAt: Date.now() }`; when `turnRunId` is captured
  (:394-396) mirror it onto `entry.activeTurn.runId`;
- pass the signal: `conversation.stream(content, { eventBus, maxIterations, signal: controller.signal })`;
- **disconnect hardening**: `stream.onAbort(() => onCancel());` where `onCancel` both
  `controller.abort()`s and deny-sweeps: `for (const id of pendingForTurn) inputRegistry?.resolve(id, { decision: "deny" })`
  — this unparks a gate-blocked run so the generator can wind down (fixes the B.1 hang);
  register the same `onCancel` on `controller.signal` (`addEventListener("abort", …, { once: true })`)
  so route-initiated cancels also unblock gates;
- in `finally`: `delete entry.activeTurn` (before the existing unsubscribe/deny lines is fine —
  the existing deny sweep stays as the belt for the natural-completion path);
- concurrency guard (recommended, see B.5-D2): before `streamSSE`, if `entry.activeTurn` is
  set → `409 {"error":"a turn is already streaming for this conversation"}`.

**6. Server — the cancel route** (new, in `conversationRoutes` next to the input route :454):

```ts
// POST /conversations/:id/cancel — abort the in-flight turn, if any.
app.post("/conversations/:id/cancel", (c) => {
  const entry = conversations.get(c.req.param("id"));
  if (!entry) return c.json({ error: "Conversation not found" }, 404);
  const turn = entry.activeTurn;
  if (!turn) return c.json({ error: "no active turn" }, 409);
  turn.controller.abort();
  return c.json({ ok: true, ...(turn.runId ? { run_id: turn.runId } : {}) }, 202);
});
```

- 404/409/202 grammar mirrors the input route's (404 JSON shape, addressing-sugar `:id`).
- Idempotency: `AbortController.abort()` is idempotent; a second cancel while the turn is
  still winding down returns 202 again; after the turn's `finally` clears `activeTurn` it
  returns 409. Document both in the route comment.
- No auth exists anywhere on this server (parity ceiling §1.9) — cancel is no more privileged
  than send; fine for now.

**7. Wire contract for a cancelled turn** (what R1's Go client should expect on the still-open
POST stream): `…message.delta*` → `message.cancel {reason}` →
`conversation.end {reason:"cancelled"}` (runner's) → `conversation.end {reason:"cancelled"}`
(Conversation's) → `done {run_id}`. The cancel POST itself returns `202 {ok, run_id}`.
Dashboard impact: none required (its parser passes unknown-name frames through,
`chat-client.ts:304`; `model.ts` has no `message.cancel` case yet — R3 polish can render it).

### B.4 Test plan

Runtime (`packages/agent-runtime/src/runner/__tests__/agent-runner-stream.test.ts` idiom —
`MockLanguageModelV2` from `ai/test` is already the house pattern, `agent-runner.test.ts:8`):

1. pre-aborted signal → `stream()` yields `conversation.start`, `message.start`, then
   `message.cancel` + `conversation.end{cancelled}`; no `llm.start`; generator returns, never
   throws.
2. abort between iterations: mock tool executor that fires `controller.abort()` during
   `execute` of iteration 0's tool → assert no second `agent.llm.start`, cancel pair emitted.
3. abort mid-provider-stream: `MockLanguageModelV2.doStream` whose ReadableStream never closes;
   abort after first chunk → assert `'abort'`-part / AbortError handling produces the cancel
   pair (this pins the ai@5 behavior we rely on).
4. `Conversation.stream` with `signal`: trailing conversation.end reason `"cancelled"`;
   exchange recorded with partial text.

Server (`packages/agent-server/src/__tests__/` — new `conversations-cancel.test.ts`, reusing
`conversations.test.ts` `mkApp`/mock-runner idioms):

5. cancel route grammar: 404 unknown conversation; 409 when idle; 202 `{ok:true}` mid-turn
   (mock runner that parks on a promise until its options' `abortSignal` fires, then emits the
   cancel pair and returns — mirrors the real runner's contract).
6. cancelled turn's SSE body ends `message.cancel` … `done` (drain full body after issuing the
   cancel from a second `app.request`).
7. deny-sweep-on-cancel: wire a `PendingInputRegistry`, mock runner that publishes an
   `agent.input.request` then parks on the registry promise → POST cancel → assert the
   registry resolved deny and the stream terminated with `done`
   (`conversations-input.test.ts:158-186` has the delivery scaffolding to crib).
8. disconnect hardening: `app.request(...)` then `res.body.getReader().cancel()` (this drives
   hono's `responseReadable.cancel → abort() → onAbort`) → assert the runner double observed
   its abort signal and any pending input was denied.
9. concurrency guard (if adopted): second POST …/messages during an active turn → 409.

### B.5 Open decisions (each with a recommendation)

- **D1 — Who emits `agent.message.cancel`.** Runner (recommended, B.3-2) vs route-synthesized.
  Runner emission is transport-agnostic and feeds the collector (`collector.ts:335`) on the
  in-process path too; route emission would be invisible to `ap run` later.
- **D2 — Concurrent sends on one conversation.** Today unguarded (nothing stops two
  simultaneous `POST …/messages`; they'd interleave history writes). `activeTurn` gives a free
  guard. Recommend: add the 409 (no known client sends concurrently; it also makes
  `activeTurn` unambiguous for cancel). If rejected, `activeTurn` must become a Set and cancel
  aborts all.
- **D3 — Cancel status code.** 202 (accepted, cancellation is asynchronous — the stream winds
  down cooperatively) vs 200. Recommend 202; the body `{ok:true, run_id?}` is the contract.
- **D4 — Does cancel also fire for `agent.input.request`-blocked turns via the input route
  instead?** No — keep them orthogonal: cancel = abort whole turn (deny sweep included);
  `POST …/input {decision:"deny"}` = answer one prompt, run continues. Both must coexist.
- **D5 — A.3 persistence-pollution companion.** Recommend shipping it inside this pre-work
  (small, testable, and the N5 regression test otherwise has to assert the polluted behavior
  as "expected").
- **D6 — CLI adoption of `abortSignal`** (replace `safeReturn` in `run.ts:419-457`): defer to
  R1+; the runtime seam ships now, dormant for the CLI.

### B.6 Ship notes

- Files: `agent-runtime/src/runner/types.ts`, `runner/agent-runner.ts`,
  `conversation/conversation.ts`, `agent-server/src/routes/conversations.ts` + tests. Runtime
  API addition + server route → lockstep bump (runtime/server/cli), core untouched.
- Sequencing: land N5 (Part A) first — it's independent and un-blocks honest error rendering
  for every client; cancel (Part B) stacks on it (same file, adjacent hunks — stack the PRs).
- The docs routes introspect `app.routes` (`app.ts:70-77`), so the cancel route appears in
  `/openapi.json` automatically; add a route doc comment in the house style.

---

## C — Existing test inventory around these routes (verified by read)

| File (`packages/agent-server/src/__tests__/`) | Covers | Relevant idioms to reuse |
|---|---|---|
| `conversations.test.ts` | 4 read routes (503/404/shapes), store→Conversation wiring, runId/traceId threading through the SSE stream | `makeStreamingRunner` (:29-58) — mock runner mirroring the real traceId/runId contract; `mkApp` (:60-76) mounts `conversationRoutes` alone; full-body SSE reads |
| `conversations-input.test.ts` | input route grammar (501/400/404/approve/value-implies-approve), inline `input.request` delivery + foreign-traceId filtering (:158-186) | pending-registry + bus scaffolding for B.4-7 |
| `approval-round-trip.test.ts` | `createServer` + real gate: APPROVE runs tool, DENY errors run (:200-220) | end-to-end SSE frame grepping (`event: input.request` line counts) |
| `sse.test.ts` | `agentEventToSSE` formatting | — |
| `app.test.ts`, `events.test.ts` | route mounting, admin stream | — |

**Gaps this pre-work fills**: no test drives a throwing runner through POST …/messages (N5);
no test exercises disconnect/teardown (`onAbort`); no cancel tests (route doesn't exist); no
runtime test passes an AbortSignal (option doesn't exist).

Runtime-side neighbors: `agent-runtime/src/conversation/__tests__/conversation.test.ts`
(Conversation.stream contract — extend for A.3/B.4-4),
`runner/__tests__/agent-runner-stream.test.ts` (streaming loop — extend for B.4-1..3).

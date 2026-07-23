/**
 * Conversation routes — create conversations, stream messages via SSE, and
 * (spec `.ai-docs/stacks/playground-upgrades/port-map.md` § 4.1) read back
 * persisted conversations/messages/parts once a `ConversationStore` is wired.
 *
 * The four read routes reuse the `runs.ts` 503 persistence-not-configured
 * grammar. Response shapes are hand-shaped to the dashboard's mirrored
 * contract (`agent-dashboard/src/api/types.ts` `ConversationSummary` /
 * `ConversationDetail` / `ConversationMessage` / `ConversationMessagePart`) —
 * several fields there (`agentConfigId`, message-level `metadata`, lifecycle
 * `status`/`error`/`completedAt`) have no equivalent in this runtime's
 * `ConversationStore` protocol; they're synthesized as constants/`null`
 * (honest-degradation §6 of the port-map — never invent, always say "not
 * modeled") rather than left undefined.
 */

import type {
  AgentEvent,
  AgentEventBus,
  AgentLike,
  BaseEvent,
  ConversationStore,
  PendingInputRegistry,
  RunStore,
  StoredMessagePart,
} from "@agentic-patterns/runtime";
import {
  Conversation,
  buildScopeHost,
  createEvent,
  deriveToolboxExecutor,
} from "@agentic-patterns/runtime";
import { type Context, Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { AgentRegistration } from "../config.js";
import { agentEventToSSE } from "../sse.js";
import { isPlainRecord, redactContext } from "./redact.js";

/** Entry in the per-server conversation registry. */
export interface ConversationEntry {
  conversation: Conversation;
  agentId: string;
  /**
   * The redacted effective context/scope this conversation was bound with
   * (#268, widened #308) — `undefined` when the registration has neither an
   * `instantiate` hook nor a declared `scope`. Immutable for the
   * conversation's lifetime (Decision 2): scope is fixed at creation. Arms
   * the run-metadata stamp below (`entry.context !== undefined`) — a
   * scope-declaring, hook-less registration MUST populate this too, or its
   * runs are silently never stamped.
   */
  context?: Record<string, unknown>;
  /** Top-level `context` keys that were redacted (Decision 3), when any were. */
  contextRedacted?: readonly string[];
}

export function conversationRoutes(
  agents: AgentRegistration[],
  conversations: Map<string, ConversationEntry>,
  eventBus: AgentEventBus,
  store: ConversationStore | undefined,
  inputRegistry?: PendingInputRegistry,
  runStore?: RunStore,
): Hono {
  const app = new Hono();

  // POST /conversations — create a new conversation
  app.post("/conversations", async (c) => {
    const body = await c.req.json<{ agent_id: string; scope?: unknown; context?: unknown }>();
    const agentId = body.agent_id;

    const reg = agents.find((a) => a.id === agentId);
    if (!reg) {
      return c.json({ error: "Agent not found" }, 404);
    }

    // `scope` (#308) supersedes the deprecated `context` alias — `scope`
    // wins when both are sent. `suppliedKey` names whichever one the caller
    // actually used, so error messages below stay accurate for either.
    const suppliedKey =
      body.scope !== undefined ? "scope" : body.context !== undefined ? "context" : undefined;
    const rawScope = body.scope !== undefined ? body.scope : body.context;

    // Shape (mirrors composition.ts:733's grammar — an explicit `null` is
    // rejected same as any other non-object, never silently coerced to
    // "absent").
    if (
      rawScope !== undefined &&
      (typeof rawScope !== "object" || rawScope === null || Array.isArray(rawScope))
    ) {
      return c.json({ error: `\`${suppliedKey}\` must be a JSON object` }, 400);
    }

    const hasHook = typeof reg.instantiate === "function";
    const hasScope = reg.scope !== undefined;
    if (rawScope !== undefined && !hasHook && !hasScope) {
      return c.json(
        { error: `Agent has no instantiate hook — ${suppliedKey} is not accepted` },
        400,
      );
    }

    // Hook-less AND scope-less registrations are byte-identical to before
    // this feature: `agent` binds as-is, no instantiate call, no
    // `context`/`scope` in the response.
    let agentToBind: AgentLike = reg.agent;

    // No explicit scope/context → compose with the registration's declared
    // defaults (scope.defaults wins over the deprecated instantiateDefaults),
    // so the echoed value always states what was actually resolved (mirror
    // composition.ts:744-745).
    //
    // Shallow-copy the defaults before handing them anywhere — SessionScope
    // freezes `.defaults` (a mutating `instantiate` hook would THROW on a
    // frozen object rather than silently corrupt it) and `reg.
    // instantiateDefaults` is ONE shared object across every conversation
    // this registration ever creates. `undefined` (no defaults declared
    // either way) is preserved as-is so the "no defaults" vs. "empty object"
    // distinction survives.
    const declaredDefaults = reg.scope?.defaults ?? reg.instantiateDefaults;
    let effectiveContext: Record<string, unknown> | undefined =
      (rawScope as Record<string, unknown> | undefined) ??
      (declaredDefaults ? { ...declaredDefaults } : undefined);

    // Scope validation (#308) — the registration's declared shape wins over
    // ad hoc context: parse the effective value against `scope.schema` (zod
    // defaults/coercions applied), 400 on failure. A registration that
    // declares REQUIRED fields with no defaults turns a bare
    // `POST /conversations` into a deliberate 400 (decisions.md D11) — the
    // agent said it needs a scope. The PARSED value replaces
    // `effectiveContext` for every downstream consumer: `instantiate`,
    // redaction, the run-metadata stamp, and `buildScopeHost` injection.
    if (reg.scope) {
      try {
        effectiveContext = reg.scope.parse(effectiveContext ?? {});
      } catch (err) {
        // Duck-typed detection: zod is a `^3.25.0 || ^4.1.8` peer dep and the
        // throwing zod may be `@agentic-patterns/core`'s copy, not the
        // server's — never `instanceof ZodError` / `.flatten()` (v3-only
        // shape) across that module boundary (decisions.md D3).
        if (err && Array.isArray((err as { issues?: unknown }).issues)) {
          return c.json(
            { error: "scope validation failed", issues: (err as { issues: unknown[] }).issues },
            400,
          );
        }
        throw err;
      }
      if (!isPlainRecord(effectiveContext)) {
        // A real SessionScope can't get here (z.object parses to an object);
        // only a malformed hand-rolled registration scope can — 502 names the
        // registration bug instead of crashing redaction with a raw 500.
        return c.json({ error: "scope.parse returned a non-object — malformed scope" }, 502);
      }
    }

    if (typeof reg.instantiate === "function") {
      try {
        agentToBind = await reg.instantiate(effectiveContext);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return c.json({ error: `instantiate failed: ${message}` }, 502);
      }
    }

    // Redact keys are the union of the scope's declared redactions and the
    // deprecated `contextRedactKeys` — a hook-only registration's redaction
    // keeps working unchanged when it later adds a `scope`.
    const redactKeys = Array.from(
      new Set([...(reg.scope?.redactKeys ?? []), ...(reg.contextRedactKeys ?? [])]),
    );
    const { context: redactedContext, redactedKeys } = redactContext(effectiveContext, redactKeys);

    // Wire a ToolExecutor so AgentRunner can actually execute tool calls
    // from the agent's Capability toolboxes (not just format them for the LLM).
    //
    // DERIVE, don't force-create: `deriveToolboxExecutor` returns `undefined`
    // for a capability-less agent. That matters for a PromotedAgent (asAgent()),
    // whose synthetic role has NO capabilities — `createToolboxExecutor` would
    // hand back a truthy-but-EMPTY executor that throws `Tool "X" not found` for
    // every call, and (as a set `RunOptions.toolExecutor`) would BEAT the
    // AgentStep-level `deriveToolboxExecutor(agent)` fallback that arms the
    // nested agent's own tools. Leaving it `undefined` restores that per-agent
    // derivation; real-capability agents still get their executor here.
    //
    // Derived from the BOUND (delivered-or-declared) instance, not always
    // `reg.agent` — a hook-bearing registration's delivered instance is the
    // one whose tools actually execute (#268).
    const toolExecutor = deriveToolboxExecutor(
      agentToBind as unknown as Parameters<typeof deriveToolboxExecutor>[0],
    );
    // `host.scope` (#308) — carries the PARSED scope value across every run
    // this conversation makes (`Conversation` forwards `_host` verbatim into
    // every `send()`/`stream()`), so tools can read it via `readScope`/
    // `requireScope` (`@agentic-patterns/runtime`, `workflows/scope-host.js`).
    // Only scope-declaring registrations get a host — hook-only (no scope)
    // registrations keep today's hostless behavior.
    const host = hasScope ? buildScopeHost(effectiveContext ?? {}) : undefined;
    // `store` (when configured) makes `Conversation._persistExchange` actually
    // write request/response messages — previously accepted and never used.
    const conversation = new Conversation(agentToBind, reg.runner, {
      toolExecutor,
      store,
      ...(host ? { host } : {}),
    });
    conversations.set(conversation.id, {
      conversation,
      agentId,
      ...(hasHook || hasScope ? { context: redactedContext } : {}),
      ...(redactedKeys ? { contextRedacted: redactedKeys } : {}),
    });

    if (!hasHook && !hasScope) {
      return c.json({ id: conversation.id, agent_id: agentId }, 201);
    }
    return c.json(
      {
        id: conversation.id,
        agent_id: agentId,
        // Kept as the deprecated alias — the dashboard's existing chip
        // (`useChat.ts:142`) depends on `context` staying populated whether
        // the registration used a hook, a scope, or both.
        context: redactedContext ?? null,
        // Forward-looking name, present only for scope-declaring
        // registrations — same (redacted) value as `context` (D8).
        ...(hasScope ? { scope: redactedContext ?? null } : {}),
        ...(redactedKeys ? { context_redacted: redactedKeys } : {}),
      },
      201,
    );
  });

  // GET /admin/conversations — ConversationSummary[]
  app.get("/admin/conversations", async (c) => {
    if (!store) return notConfigured(c);
    const summaries = await store.listConversations();
    return c.json(
      summaries.map((s) => ({
        conversationId: s.conversationId,
        agentName: s.agentName,
        messageCount: s.messageCount,
        tokenCount: s.tokenCount,
        startedAt: s.startedAt.toISOString(),
        lastMessageAt: s.lastMessageAt?.toISOString(),
        status: s.status,
      })),
    );
  });

  // GET /conversations/:id — ConversationDetail
  app.get("/conversations/:id", async (c) => {
    if (!store) return notConfigured(c);
    const id = c.req.param("id");
    const conv = await store.getConversation(id);
    if (!conv) {
      return c.json({ error: `conversation "${id}" not found` }, 404);
    }
    const messages = await store.getMessages(id);
    const tokenCount = messages.reduce((sum, m) => sum + m.inputTokens + m.outputTokens, 0);
    const lastMessage = messages.at(-1);
    return c.json({
      id: conv.id,
      // Our system has no per-conversation "agent config" concept (swe-brain's
      // Drizzle row carries one; this framework only tracks agentName/model) —
      // honestly null, never invented.
      agentConfigId: null,
      // No lifecycle tracking is wired yet (nothing ever transitions a
      // conversation away from "active" in this slice) — constant, not faked.
      status: "active",
      agentName: conv.agentName,
      model: conv.model,
      tokenCount,
      messageCount: messages.length,
      startedAt: conv.createdAt.toISOString(),
      completedAt: null,
      error: null,
      createdAt: conv.createdAt.toISOString(),
      updatedAt: (lastMessage?.createdAt ?? conv.updatedAt).toISOString(),
    });
  });

  // GET /conversations/:id/messages — ConversationMessage[] ASC, no 404 for an
  // unknown id (mirrors ConversationStore.getMessages: empty array, no throw).
  app.get("/conversations/:id/messages", async (c) => {
    if (!store) return notConfigured(c);
    const id = c.req.param("id");
    const messages = await store.getMessages(id);
    return c.json(
      messages.map((m) => ({
        id: m.id,
        conversationId: m.conversationId,
        kind: m.kind,
        runId: m.runId ?? null,
        inputTokens: m.inputTokens,
        outputTokens: m.outputTokens,
        content: derivePreviewContent(m.parts),
        // No message-level metadata concept in the protocol (only parts carry
        // metadata) — honestly null rather than merging parts' metadata into
        // a shape nothing actually models.
        metadata: null,
        createdAt: m.createdAt.toISOString(),
        // No message-update path exists — updatedAt mirrors createdAt.
        updatedAt: m.createdAt.toISOString(),
      })),
    );
  });

  // GET /messages/:id/parts — ConversationMessagePart[] ASC by position, no
  // 404 for an unknown id (mirrors ConversationStore.getMessageParts).
  app.get("/messages/:id/parts", async (c) => {
    if (!store) return notConfigured(c);
    const id = c.req.param("id");
    const parts = await store.getMessageParts(id);
    return c.json(
      parts.map((p) => {
        // Parts share their owning message's createdAt (written atomically,
        // never independently updated) — protocol producers that predate
        // #S7's `StoredMessagePart.createdAt` addition fall back to "now"
        // rather than surfacing `undefined` over the wire.
        const createdAt = (p.createdAt ?? new Date()).toISOString();
        return {
          id: p.id,
          messageId: p.messageId,
          type: p.type,
          content: p.content ?? null,
          metadata: p.metadata,
          position: p.position ?? 0,
          createdAt,
          updatedAt: createdAt,
        };
      }),
    );
  });

  // POST /conversations/:id/messages — send message, stream SSE response
  app.post("/conversations/:id/messages", async (c) => {
    const convId = c.req.param("id");
    const entry = conversations.get(convId);

    if (!entry) {
      return c.json({ error: "Conversation not found" }, 404);
    }

    const body = await c.req.json<{ content: string; maxIterations?: number }>();
    const content = body.content;

    if (!content || typeof content !== "string") {
      return c.json({ error: "content is required" }, 400);
    }

    // Optional per-message cap on the agent tool-loop (clamped to a sane range);
    // omitted → the runner's own default applies.
    const maxIterations =
      typeof body.maxIterations === "number" && Number.isFinite(body.maxIterations)
        ? Math.min(Math.max(1, Math.trunc(body.maxIterations)), 50)
        : undefined;

    const { conversation } = entry;

    if (!conversation.runner.stream) {
      return c.json({ error: "Streaming not supported by this runner" }, 501);
    }

    // SSE streaming response. We pass the server's shared eventBus so
    // emitted events reach every attached exporter (collector, SSE
    // broadcast, etc.) in addition to flowing through the generator for
    // this client stream.
    return streamSSE(c, async (stream) => {
      // Human-in-the-loop delivery: an approval gate BLOCKS the run inside
      // `bus.publish`, so the runner generator (which this loop drains) is
      // parked and can't yield the prompt itself. The gate instead PUBLISHES
      // an `agent.input.request` on the bus; we surface it onto THIS turn's
      // stream, correlated by traceId so a concurrent conversation's prompt
      // never bleeds in. The client answers via `POST /conversations/:id/input`
      // (below), which resolves the registry and unblocks the gate.
      let turnTraceId: string | undefined;
      // The turn's TOP-LEVEL run id — the id `RunStoreExporter` keys the run
      // row by, i.e. the FIRST `agent.message.start`'s runId (the conversation
      // wrapper stamps its own runId on `conversation.start`, which never gets
      // a row; nested sub-agent runs carry their own). Emitted on the `done`
      // frame so the client can link straight to this turn's persisted trace
      // (`/run?run=<id>`) without waiting for the session store to round-trip.
      let turnRunId: string | undefined;
      // The runId off the FIRST event this turn observes at all (conversation
      // wrapper's own runId, since `conversation.start` always arrives first —
      // :393 below). Used only to give a synthesized `agent.error` bus publish
      // a runId to key on when the turn never reaches `agent.message.start`
      // (pre-token failure ⇒ `turnRunId` stays undefined). Exporters must
      // tolerate this runId having no run row.
      let turnBusRunId: string | undefined;
      const pendingForTurn = new Set<string>();
      const onInputRequest = async (ev: BaseEvent): Promise<void> => {
        const e = ev as AgentEvent;
        if (e.type !== "agent.input.request") return;
        if (turnTraceId !== undefined && e.traceId !== turnTraceId) return;
        pendingForTurn.add(e.correlationId);
        const msg = agentEventToSSE(e);
        // The runner is blocked here, so no concurrent writeSSE races this.
        if (msg) await stream.writeSSE(msg);
      };
      eventBus.subscribe("agent.input.request", onInputRequest);

      try {
        for await (const event of conversation.stream(content, { eventBus, maxIterations })) {
          turnTraceId ??= event.traceId;
          turnBusRunId ??= event.runId;
          if (turnRunId === undefined && event.type === "agent.message.start") {
            turnRunId = event.runId;
          }
          const msg = agentEventToSSE(event);
          if (msg) {
            await stream.writeSSE(msg);
          }
        }

        await stream.writeSSE({
          event: "done",
          data: JSON.stringify(turnRunId ? { run_id: turnRunId } : {}),
        });
      } catch (err) {
        // N5: the drain loop above can throw before yielding a single event
        // (model-resolution reject, provider construction failure — any
        // pre-yield setup throw in the runner) or mid-stream. Either way the
        // stream must be honestly torn on the wire, never silently swallowed
        // by hono: write the canonical `error` frame (byte-compatible with
        // `toSSEMapping`'s `agent.error` payload, `sse-formatter.ts:301-309`)
        // then the `done` terminator, in that order, then swallow. We do NOT
        // use `streamSSE`'s `onError` callback — it writes its own
        // `event: error` frame whose data is the raw message STRING, not
        // JSON, which the dashboard's `parseFrame` drops and the Go parser
        // can't decode. Owning the frame shape here keeps both happy.
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
          // Client gone — nothing left to tell. Belt-and-braces only: under
          // hono 4.12.31 `StreamingApi.write` already swallows write errors
          // (`catch {}` in `dist/utils/stream.js`), so this rarely fires.
        }

        // Bus visibility (non-load-bearing for the wire fix): a pre-token
        // throw never reaches the event bus otherwise — no exporter records
        // anything — so synthesize an `agent.error` for the admin
        // firehose/collector/exporters. Guarded on turnTraceId: it is set
        // from the first forwarded event, and `conversation.start` always
        // arrives first, so this only fails to fire if the wrapper itself
        // never yielded anything at all.
        if (turnTraceId !== undefined && turnBusRunId !== undefined) {
          const errorEvent = createEvent("agent.error", {
            traceId: turnTraceId,
            runId: turnBusRunId,
            errorType,
            message,
            recoverable: false,
            context: {},
          });
          try {
            await eventBus.publish(errorEvent);
          } catch (publishErr) {
            console.error("conversations: agent.error bus publish failed:", publishErr);
          }
        }
      } finally {
        // Run-metadata stamp (#268) — the redacted effective context this
        // conversation is bound to, written onto the turn's run row. Lives in
        // `finally`, NOT after the drain loop inside `try`: when a turn
        // errors mid-run, `Conversation.stream` yields `conversation.end`
        // then RE-THROWS, so the `for await` above throws too and a
        // try-scoped stamp would never run — exactly the runs an operator
        // most needs to inspect. A client disconnect is NOT the same kind of
        // teardown: under hono 4.12.31, `StreamingApi.write` silently
        // swallows write errors on a closed connection, so the drain loop
        // above keeps pulling runner events to completion regardless — it
        // does not throw, and nothing here stops the runner from finishing
        // its work server-side. #341's `onAbort` wiring is what will
        // actually short-circuit the runner on disconnect. `updateRunMetadata` is a
        // local DB write independent of the broken stream/generator and
        // status-independent (it stamps a still-`running` row the same as a
        // finalized one, see its doc comment) — it lands on whatever the row
        // ended up as, success or error, as long as `agent.message.start`
        // was ever observed (`turnRunId` set). Best-effort: a store failure
        // is logged, never allowed to shadow whatever this `finally` is
        // unwinding from — matches the exporter's own failure posture.
        if (runStore && turnRunId !== undefined && entry.context !== undefined) {
          try {
            runStore.updateRunMetadata(turnRunId, {
              context: entry.context,
              ...(entry.contextRedacted ? { context_redacted: entry.contextRedacted } : {}),
            });
          } catch (err) {
            console.error(`conversations: updateRunMetadata failed for run ${turnRunId}:`, err);
          }
        }

        eventBus.unsubscribe("agent.input.request", onInputRequest);
        // Fail closed: if the client disconnects mid-approval, deny any of THIS
        // turn's still-pending requests so the blocked gate resolves (deny)
        // instead of hanging the run forever.
        if (inputRegistry) {
          for (const correlationId of pendingForTurn) {
            inputRegistry.resolve(correlationId, { decision: "deny" });
          }
        }
      }
    });
  });

  // POST /conversations/:id/input — the return leg of a human-in-the-loop
  // round-trip. Resolves an `agent.input.request` (delivered on the message
  // stream above) by `correlation_id`, unblocking the gate that is holding the
  // run. Per-conversation by URL, but the registry is keyed by the globally
  // unique `correlation_id` (the guarded tool call's id) — the `:id` is
  // addressing sugar, not a second key. 501 when no registry is wired (no gate
  // is active, so nothing is ever blocked awaiting input).
  app.post("/conversations/:id/input", async (c) => {
    if (!inputRegistry) {
      return c.json(
        {
          error: "human-input not configured",
          hint: "start `ap playground` with AP_APPROVAL_TOOLS set to enable approval gating",
        },
        501,
      );
    }

    const body = await c.req.json<{
      correlation_id?: string;
      decision?: "approve" | "deny";
      value?: string;
    }>();

    const correlationId = body.correlation_id;
    if (!correlationId || typeof correlationId !== "string") {
      return c.json({ error: "correlation_id is required" }, 400);
    }

    // Approval semantics: an explicit decision wins; otherwise a supplied
    // `value` (a select/text answer) implies approval, and a bare call denies.
    const decision: "approve" | "deny" =
      body.decision ?? (body.value !== undefined ? "approve" : "deny");

    const resolved = inputRegistry.resolve(correlationId, {
      decision,
      ...(body.value !== undefined ? { value: body.value } : {}),
    });

    if (!resolved) {
      return c.json({ error: "no pending input for correlation_id", correlationId }, 404);
    }

    return c.json({ ok: true, correlationId, decision }, 200);
  });

  return app;
}

// ---------------------------------------------------------------------------
// Helpers (file-local — small helpers are deliberately not shared across
// route files, the `routes/runs.ts` precedent)
// ---------------------------------------------------------------------------

function notConfigured(c: Context): Response {
  return c.json(
    {
      error: "persistence not configured",
      hint: "start `ap playground` with AP_PERSISTENCE != 0 to enable conversation history queries",
    },
    503,
  );
}

/**
 * `ConversationMessage.content` (`agent-dashboard/src/api/types.ts`) is a
 * denormalized preview — the protocol's `StoredMessage` only carries the
 * full `parts` array. `Conversation._persistExchange` always writes a single
 * `user_prompt`/`text` part per message, so joining every part's content
 * with non-empty text reconstructs exactly that; a future multi-part
 * producer degrades gracefully to a multi-line preview rather than losing
 * content.
 */
function derivePreviewContent(parts: StoredMessagePart[]): string | null {
  const joined = parts
    .map((p) => p.content)
    .filter((c): c is string => typeof c === "string" && c.length > 0)
    .join("\n\n");
  return joined.length > 0 ? joined : null;
}

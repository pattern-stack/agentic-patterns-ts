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
  BaseEvent,
  ConversationStore,
  PendingInputRegistry,
  StoredMessagePart,
} from "@agentic-patterns/runtime";
import { Conversation, createToolboxExecutor } from "@agentic-patterns/runtime";
import { type Context, Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { AgentRegistration } from "../config.js";
import { agentEventToSSE } from "../sse.js";

/** Entry in the per-server conversation registry. */
export interface ConversationEntry {
  conversation: Conversation;
  agentId: string;
}

export function conversationRoutes(
  agents: AgentRegistration[],
  conversations: Map<string, ConversationEntry>,
  eventBus: AgentEventBus,
  store: ConversationStore | undefined,
  inputRegistry?: PendingInputRegistry,
): Hono {
  const app = new Hono();

  // POST /conversations — create a new conversation
  app.post("/conversations", async (c) => {
    const body = await c.req.json<{ agent_id: string }>();
    const agentId = body.agent_id;

    const reg = agents.find((a) => a.id === agentId);
    if (!reg) {
      return c.json({ error: "Agent not found" }, 404);
    }

    // Wire a ToolExecutor so AgentRunner can actually execute tool calls
    // from the agent's Capability toolboxes (not just format them for the LLM).
    const toolExecutor = createToolboxExecutor(
      reg.agent as unknown as Parameters<typeof createToolboxExecutor>[0],
    );
    // `store` (when configured) makes `Conversation._persistExchange` actually
    // write request/response messages — previously accepted and never used.
    const conversation = new Conversation(reg.agent, reg.runner, { toolExecutor, store });
    conversations.set(conversation.id, { conversation, agentId });

    return c.json({ id: conversation.id, agent_id: agentId }, 201);
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
      } finally {
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

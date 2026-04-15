/**
 * Conversation routes — create conversations and stream messages via SSE.
 */

import type { AgentEventBus } from "@pattern-stack/agent-runtime";
import { Conversation, createToolboxExecutor } from "@pattern-stack/agent-runtime";
import { Hono } from "hono";
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
    const conversation = new Conversation(reg.agent, reg.runner, { toolExecutor });
    conversations.set(conversation.id, { conversation, agentId });

    return c.json({ id: conversation.id, agent_id: agentId }, 201);
  });

  // POST /conversations/:id/messages — send message, stream SSE response
  app.post("/conversations/:id/messages", async (c) => {
    const convId = c.req.param("id");
    const entry = conversations.get(convId);

    if (!entry) {
      return c.json({ error: "Conversation not found" }, 404);
    }

    const body = await c.req.json<{ content: string }>();
    const content = body.content;

    if (!content || typeof content !== "string") {
      return c.json({ error: "content is required" }, 400);
    }

    const { conversation } = entry;

    if (!conversation.runner.stream) {
      return c.json({ error: "Streaming not supported by this runner" }, 501);
    }

    // SSE streaming response. We pass the server's shared eventBus so
    // emitted events reach every attached exporter (collector, SSE
    // broadcast, etc.) in addition to flowing through the generator for
    // this client stream.
    return streamSSE(c, async (stream) => {
      for await (const event of conversation.stream(content, { eventBus })) {
        const msg = agentEventToSSE(event);
        if (msg) {
          await stream.writeSSE(msg);
        }
      }

      await stream.writeSSE({ event: "done", data: "{}" });
    });
  });

  return app;
}

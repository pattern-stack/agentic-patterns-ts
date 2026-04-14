/**
 * useChat — owns one conversation's lifecycle and message history.
 *
 * Creates a conversation on demand, streams the assistant's response,
 * and accumulates deltas / tool calls / thinking into a structured
 * message list suitable for rendering.
 */

import { useCallback, useRef, useState } from "react";
import { type AgentSummary, createConversation, streamMessage } from "../api/chat-client";
import type { ClientEvent } from "../api/sse-events";

export interface ToolCall {
  id: string;
  name: string;
  arguments: unknown;
  result?: unknown;
  error?: string;
  durationMs?: number;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  thinking?: string;
  toolCalls: ToolCall[];
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  /** Still streaming into this message. */
  streaming?: boolean;
  /** Stream ended with an error payload. */
  error?: string;
}

export interface UseChatResult {
  conversationId: string | null;
  messages: ChatMessage[];
  streaming: boolean;
  error: string | null;
  send: (content: string) => Promise<void>;
  reset: () => void;
}

let _idCounter = 0;
const nextId = () => `m-${Date.now()}-${_idCounter++}`;

export function useChat(agent: AgentSummary | null): UseChatResult {
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setConversationId(null);
    setMessages([]);
    setStreaming(false);
    setError(null);
  }, []);

  const send = useCallback(
    async (content: string) => {
      if (!agent) {
        setError("Select an agent first");
        return;
      }
      if (!content.trim()) return;

      setError(null);
      const userMsg: ChatMessage = {
        id: nextId(),
        role: "user",
        content,
        toolCalls: [],
      };
      const assistantId = nextId();
      const assistantMsg: ChatMessage = {
        id: assistantId,
        role: "assistant",
        content: "",
        toolCalls: [],
        streaming: true,
      };
      setMessages((prev) => [...prev, userMsg, assistantMsg]);
      setStreaming(true);

      let activeConvId = conversationId;
      try {
        if (!activeConvId) {
          const created = await createConversation(agent.id);
          activeConvId = created.id;
          setConversationId(activeConvId);
        }

        const controller = new AbortController();
        abortRef.current = controller;

        for await (const event of streamMessage(activeConvId, content, controller.signal)) {
          applyEvent(setMessages, assistantId, event);
          if (event.name === "done") break;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        setError(msg);
        setMessages((prev) =>
          prev.map((m) => (m.id === assistantId ? { ...m, streaming: false, error: msg } : m)),
        );
      } finally {
        setStreaming(false);
        abortRef.current = null;
        setMessages((prev) =>
          prev.map((m) => (m.id === assistantId ? { ...m, streaming: false } : m)),
        );
      }
    },
    [agent, conversationId],
  );

  return { conversationId, messages, streaming, error, send, reset };
}

// ---------------------------------------------------------------------------
// Event -> message state reducer
// ---------------------------------------------------------------------------

function applyEvent(
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>,
  assistantId: string,
  event: ClientEvent,
): void {
  setMessages((prev) => prev.map((m) => (m.id === assistantId ? reduce(m, event) : m)));
}

function reduce(msg: ChatMessage, event: ClientEvent): ChatMessage {
  switch (event.name) {
    case "message.delta":
      return { ...msg, content: msg.content + event.data.delta };
    case "message.complete":
      return {
        ...msg,
        content: event.data.content || msg.content,
        model: event.data.model,
        inputTokens: event.data.input_tokens,
        outputTokens: event.data.output_tokens,
      };
    case "thinking":
    case "thinking.complete":
      return { ...msg, thinking: event.data.content };
    case "tool.start":
      return {
        ...msg,
        toolCalls: [
          ...msg.toolCalls,
          {
            id: event.data.tool_call_id,
            name: event.data.tool_name,
            arguments: event.data.arguments,
          },
        ],
      };
    case "tool.end":
      return {
        ...msg,
        toolCalls: msg.toolCalls.map((tc) =>
          tc.id === event.data.tool_call_id
            ? {
                ...tc,
                result: event.data.result,
                error: event.data.error,
                durationMs: event.data.duration_ms,
              }
            : tc,
        ),
      };
    case "tool.rejected":
      return {
        ...msg,
        toolCalls: [
          ...msg.toolCalls,
          {
            id: nextId(),
            name: event.data.tool_name,
            arguments: {},
            error: `Rejected by ${event.data.gate_name}: ${event.data.reason}`,
          },
        ],
      };
    case "error":
      return { ...msg, error: event.data.message };
    // Lifecycle-only events that don't mutate assistant message state.
    case "conversation.start":
    case "conversation.end":
    case "message.start":
    case "message.cancel":
    case "thinking.start":
    case "tool.intent":
    case "tool.progress":
    case "done":
      return msg;
    default: {
      const _: never = event;
      void _;
      return msg;
    }
  }
}

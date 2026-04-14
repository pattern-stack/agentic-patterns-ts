/**
 * useChat — owns one conversation's lifecycle and message history.
 *
 * Messages are modeled as ordered `parts[]` (mirroring
 * pattern-stack/chat-patterns) so tool calls, thinking, and text can be
 * interleaved in arrival order rather than flattened onto separate
 * fields. Parts:
 *   - { kind: "text",      content }
 *   - { kind: "thinking",  content, complete }
 *   - { kind: "tool_call", id, name, arguments, result?, error?, durationMs? }
 *   - { kind: "error",     errorType, message }
 *
 * Streaming reducer routes each ClientEvent to the active message's
 * parts array.
 */

import { useCallback, useRef, useState } from "react";
import { type AgentSummary, createConversation, streamMessage } from "../api/chat-client";
import type { ClientEvent } from "../api/sse-events";

export type Part =
  | { kind: "text"; content: string }
  | { kind: "thinking"; content: string; complete: boolean }
  | {
      kind: "tool_call";
      id: string;
      name: string;
      arguments: unknown;
      result?: unknown;
      error?: string;
      durationMs?: number;
    }
  | { kind: "error"; errorType: string; message: string };

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  parts: Part[];
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  /** Still streaming content into this message. */
  streaming?: boolean;
  /** Streaming aborted by the user. */
  aborted?: boolean;
}

export interface UseChatResult {
  conversationId: string | null;
  messages: ChatMessage[];
  streaming: boolean;
  error: string | null;
  exchangeCount: number;
  send: (content: string) => Promise<void>;
  abort: () => void;
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

  const abort = useCallback(() => {
    abortRef.current?.abort();
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
        parts: [{ kind: "text", content }],
      };
      const assistantId = nextId();
      const assistantMsg: ChatMessage = {
        id: assistantId,
        role: "assistant",
        parts: [],
        streaming: true,
      };
      setMessages((prev) => [...prev, userMsg, assistantMsg]);
      setStreaming(true);

      let activeConvId = conversationId;
      const controller = new AbortController();
      abortRef.current = controller;

      try {
        if (!activeConvId) {
          const created = await createConversation(agent.id);
          activeConvId = created.id;
          setConversationId(activeConvId);
        }

        for await (const event of streamMessage(activeConvId, content, controller.signal)) {
          applyEvent(setMessages, assistantId, event);
          if (event.name === "done") break;
        }
      } catch (err) {
        const wasAborted = controller.signal.aborted;
        if (wasAborted) {
          setMessages((prev) =>
            prev.map((m) => (m.id === assistantId ? { ...m, streaming: false, aborted: true } : m)),
          );
        } else {
          const msg = err instanceof Error ? err.message : "Unknown error";
          setError(msg);
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId
                ? {
                    ...m,
                    streaming: false,
                    parts: [
                      ...m.parts,
                      { kind: "error", errorType: "stream_failed", message: msg },
                    ],
                  }
                : m,
            ),
          );
        }
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

  // Exchange count = number of user messages sent on this conversation.
  const exchangeCount = messages.reduce((n, m) => n + (m.role === "user" ? 1 : 0), 0);

  return {
    conversationId,
    messages,
    streaming,
    error,
    exchangeCount,
    send,
    abort,
    reset,
  };
}

// ---------------------------------------------------------------------------
// Event -> message-parts reducer
// ---------------------------------------------------------------------------

function applyEvent(
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>,
  assistantId: string,
  event: ClientEvent,
): void {
  setMessages((prev) => prev.map((m) => (m.id === assistantId ? reduceMessage(m, event) : m)));
}

function reduceMessage(msg: ChatMessage, event: ClientEvent): ChatMessage {
  switch (event.name) {
    case "message.delta":
      return appendTextDelta(msg, event.data.delta);
    case "message.complete":
      return {
        ...msg,
        model: event.data.model,
        inputTokens: event.data.input_tokens,
        outputTokens: event.data.output_tokens,
      };
    case "thinking":
      return upsertThinking(msg, event.data.content, false);
    case "thinking.complete":
      return upsertThinking(msg, event.data.content, true);
    case "tool.start":
      return {
        ...msg,
        parts: [
          ...msg.parts,
          {
            kind: "tool_call",
            id: event.data.tool_call_id,
            name: event.data.tool_name,
            arguments: event.data.arguments,
          },
        ],
      };
    case "tool.end":
      return {
        ...msg,
        parts: msg.parts.map((p) =>
          p.kind === "tool_call" && p.id === event.data.tool_call_id
            ? {
                ...p,
                result: event.data.result,
                error: event.data.error,
                durationMs: event.data.duration_ms,
              }
            : p,
        ),
      };
    case "tool.rejected":
      return {
        ...msg,
        parts: [
          ...msg.parts,
          {
            kind: "tool_call",
            id: nextId(),
            name: event.data.tool_name,
            arguments: {},
            error: `Rejected by ${event.data.gate_name}: ${event.data.reason}`,
          },
        ],
      };
    case "error":
      return {
        ...msg,
        parts: [
          ...msg.parts,
          { kind: "error", errorType: event.data.error_type, message: event.data.message },
        ],
      };
    // Lifecycle-only events that don't mutate part list.
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

/** Append a delta to the last text part, or start a new one if the last
 *  part is a different kind (tool call / thinking / error). */
function appendTextDelta(msg: ChatMessage, delta: string): ChatMessage {
  const parts = msg.parts;
  const last = parts[parts.length - 1];
  if (last?.kind === "text") {
    return {
      ...msg,
      parts: [...parts.slice(0, -1), { kind: "text", content: last.content + delta }],
    };
  }
  return { ...msg, parts: [...parts, { kind: "text", content: delta }] };
}

/** Upsert the trailing thinking part (replace if it's the last part and
 *  still incomplete; otherwise append a new one). */
function upsertThinking(msg: ChatMessage, content: string, complete: boolean): ChatMessage {
  const parts = msg.parts;
  const last = parts[parts.length - 1];
  if (last?.kind === "thinking" && !last.complete) {
    return {
      ...msg,
      parts: [...parts.slice(0, -1), { kind: "thinking", content, complete }],
    };
  }
  return { ...msg, parts: [...parts, { kind: "thinking", content, complete }] };
}

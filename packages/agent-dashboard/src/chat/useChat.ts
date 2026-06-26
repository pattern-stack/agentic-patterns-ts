/**
 * useChat — the streaming chat driver, rewired onto the FRAMEWORK transport.
 *
 * Phase B: this replaces the cockpit's bespoke `askStream`/`lib/api` driver with
 * the dashboard's named-SSE seam (Phase A):
 *   1. `createConversation(agentId)` ONCE per thread — the id is reused for
 *      follow-ups (true conversational memory, server-threaded).
 *   2. `streamMessage(convId, content, signal)` yields typed `ClientEvent`s.
 *   3. each event → `toEventLike` → folded into the assistant message's parts
 *      via `applyParts` (streaming-first).
 *
 * An `AbortController` per turn distinguishes a user-pressed Stop (AbortError →
 * mark the message `aborted`) from a real transport failure (→ `error`).
 */
import { useCallback, useRef, useState } from "react";
import { createConversation, streamMessage } from "../api/chat-client";
import { toEventLike } from "../api/event-adapter";
import { type ChatMessage, applyParts } from "./model";

export interface UseChatResult {
  messages: ChatMessage[];
  streaming: boolean;
  error: string | null;
  /** The server conversation id for this thread (null until the first send). */
  conversationId: string | null;
  send: (content: string) => Promise<void>;
  abort: () => void;
  reset: () => void;
}

export function useChat(agentId: string | null): UseChatResult {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const convIdRef = useRef<string | null>(null);
  const seq = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  const nextId = useCallback(() => `m${++seq.current}`, []);

  // Apply a mutation to a specific assistant message by id (immutably).
  const patch = useCallback((mid: string, fn: (m: ChatMessage) => ChatMessage) => {
    setMessages((prev) => prev.map((m) => (m.id === mid ? fn(m) : m)));
  }, []);

  const send = useCallback(
    async (content: string) => {
      const q = content.trim();
      if (!q || streaming || !agentId) return;
      setError(null);
      const at = Date.now();
      const assistantId = nextId();
      setMessages((prev) => [
        ...prev,
        { id: nextId(), role: "user", parts: [{ kind: "text", content: q }], at },
        { id: assistantId, role: "assistant", parts: [], at: Date.now(), streaming: true },
      ]);
      setStreaming(true);
      const ctrl = new AbortController();
      abortRef.current = ctrl;

      try {
        // Create the conversation once per thread; reuse the id for follow-ups.
        let convId = convIdRef.current;
        if (!convId) {
          const created = await createConversation(agentId);
          convId = created.id;
          convIdRef.current = convId;
          setConversationId(convId);
        }

        for await (const ev of streamMessage(convId, q, ctrl.signal)) {
          const e = toEventLike(ev);
          patch(assistantId, (m) => {
            const r = applyParts(m.parts, e);
            return { ...m, parts: r.parts, ...(r.meta ?? {}) };
          });
        }
        patch(assistantId, (m) => ({ ...m, streaming: false }));
      } catch (e) {
        // AbortError (user pressed Stop) is expected — mark aborted, not errored.
        const aborted = e instanceof DOMException && e.name === "AbortError";
        patch(assistantId, (m) => ({ ...m, streaming: false, aborted }));
        if (!aborted) setError(e instanceof Error ? e.message : "stream dropped");
      } finally {
        setStreaming(false);
        abortRef.current = null;
      }
    },
    [streaming, agentId, patch, nextId],
  );

  const abort = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    convIdRef.current = null;
    setConversationId(null);
    setMessages([]);
    setStreaming(false);
    setError(null);
  }, []);

  return { messages, streaming, error, conversationId, send, abort, reset };
}

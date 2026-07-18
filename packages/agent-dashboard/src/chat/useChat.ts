/**
 * useChat — the streaming chat driver, rewired onto the FRAMEWORK transport.
 *
 * Phase B: this replaces the cockpit's bespoke `askStream`/`lib/api` driver with
 * the dashboard's named-SSE seam (Phase A):
 *   1. `createConversation(agentId)` ONCE per thread — the id is reused for
 *      follow-ups (true conversational memory, server-threaded).
 *   2. `streamMessage(convId, content, signal)` yields decoded `WireFrame`s
 *      (name + data, NO name allowlist — the reducer decides what renders).
 *   3. each event → `toEventLike` → folded into the assistant message's parts
 *      via `applyParts` (streaming-first).
 *
 * An `AbortController` per turn distinguishes a user-pressed Stop (AbortError →
 * mark the message `aborted`) from a real transport failure (→ `error`).
 */
import { useCallback, useRef, useState } from "react";
import {
  type ConversationCreated,
  ScopeValidationError,
  type ScopeValidationIssue,
  type SendOptions,
  createConversation,
  sendInputResponse,
  streamMessage,
} from "../api/chat-client";
import { toEventLike } from "../api/event-adapter";
import type { EventLike } from "../graph/trace-from-events";
import type { InputAnswer } from "./input-responder";
import { type ChatMessage, applyParts } from "./model";

/** `useChat`'s creation-time-only extension of `SendOptions` (#268) — `context`
 *  is read ONCE, at the first `send()` (the call that creates the
 *  conversation), and ignored thereafter: scope is immutable per conversation
 *  (spec Decision 2). Everything else in `SendOptions` still applies per turn. */
export interface UseChatOptions extends SendOptions {
  context?: Record<string, unknown>;
}

export interface UseChatResult {
  messages: ChatMessage[];
  streaming: boolean;
  error: string | null;
  /** The server conversation id for this thread (null until the first send). */
  conversationId: string | null;
  /**
   * The redacted effective context this thread's conversation was bound with
   * (#268) — the CREATE RESPONSE's echo, never the caller's draft `context`
   * option. `null` until a conversation exists, OR once it does, for a
   * hook-bearing registration with no scope ("(no scope)" — the `null` echo
   * IS the honest answer, not "unknown"). Callers that need to distinguish
   * "not yet known" from "known and empty" should key off `conversationId`.
   */
  context: Record<string, unknown> | null;
  /** Top-level context keys the server redacted, when any were (#268). */
  contextRedacted: string[] | null;
  /**
   * The per-field zod issues from the most recent `createConversation` 400
   * (#308's `scope.parse` rejection) — reset at the start of every `send()`
   * so a stale rejection never lingers past a corrected retry. `null` when
   * the create hasn't failed with `issues` (either it hasn't run yet, it
   * succeeded, or it failed some OTHER way — that case still lands in
   * `error` above as a flat string).
   */
  scopeIssues: ScopeValidationIssue[] | null;
  send: (content: string) => Promise<void>;
  /** Answer an inline `input_request` (approval gate / tool ask) for this thread. */
  respondInput: (correlationId: string, answer: InputAnswer) => Promise<void>;
  abort: () => void;
  reset: () => void;
  /**
   * The raw event stream for the CURRENT (most recent) live turn — reset at
   * the start of every `send()`. Console's trace rail (port-map §4.2.3) feeds
   * this through `eventsToSteps` for the live-turn waterfall/log; the fold
   * already tolerates the live camelCase shape (`graph/trace-from-events.ts`).
   * Purely additive — no existing consumer of `useChat` reads this field.
   */
  traceEvents: EventLike[];
  /**
   * The persisted run id of the most recent COMPLETED live turn — from the
   * `done` frame's `run_id` (the turn's top-level run, written by
   * `RunStoreExporter`). Null until a turn finishes, reset on every `send()`.
   * Feeds the trace rail's "Full trace" deep link (`/run?run=<id>`).
   */
  lastRunId: string | null;
}

export function useChat(agentId: string | null, runOptions?: UseChatOptions): UseChatResult {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [context, setContext] = useState<Record<string, unknown> | null>(null);
  const [contextRedacted, setContextRedacted] = useState<string[] | null>(null);
  const [scopeIssues, setScopeIssues] = useState<ScopeValidationIssue[] | null>(null);
  const [traceEvents, setTraceEvents] = useState<EventLike[]>([]);
  const [lastRunId, setLastRunId] = useState<string | null>(null);
  const convIdRef = useRef<string | null>(null);
  // Two `send()` calls landing in the same synchronous frame (a double-click,
  // Enter+click racing) both read `convIdRef.current === null` and would
  // otherwise each fire their own `createConversation` — two real server-side
  // `instantiate` side effects for one conversation (Gate 2.5 review note 6).
  // Set SYNCHRONOUSLY (a plain assignment, not a state update) before the
  // first `await`, so a same-frame second caller sees it immediately and
  // awaits the SAME in-flight promise instead of starting a new create.
  const creatingRef = useRef<Promise<ConversationCreated> | null>(null);
  // keep run options current without re-creating `send` each render.
  const runOptionsRef = useRef<UseChatOptions | undefined>(runOptions);
  runOptionsRef.current = runOptions;
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
      setScopeIssues(null);
      const at = Date.now();
      const assistantId = nextId();
      setMessages((prev) => [
        ...prev,
        { id: nextId(), role: "user", parts: [{ kind: "text", content: q }], at },
        { id: assistantId, role: "assistant", parts: [], at: Date.now(), streaming: true },
      ]);
      setStreaming(true);
      setTraceEvents([]); // this turn's trace rail starts fresh
      setLastRunId(null);
      const ctrl = new AbortController();
      abortRef.current = ctrl;

      try {
        // Create the conversation once per thread; reuse the id for follow-ups.
        // `context` is read from the ref HERE ONLY — this is the one moment a
        // draft context becomes a bound scope (#268 Decision 2: immutable
        // thereafter, regardless of what the caller's `context` option does
        // on later renders/sends).
        let convId = convIdRef.current;
        if (!convId) {
          // `creatingRef` may already hold a same-frame sibling's in-flight
          // promise (see its doc comment) — join it instead of firing a
          // second `createConversation`.
          creatingRef.current ??= createConversation(agentId, runOptionsRef.current?.context);
          try {
            const created = await creatingRef.current;
            convId = created.id;
            convIdRef.current = convId;
            setConversationId(convId);
            setContext(created.context ?? null);
            setContextRedacted(created.context_redacted ?? null);
          } finally {
            creatingRef.current = null;
          }
        }

        for await (const ev of streamMessage(convId, q, runOptionsRef.current, ctrl.signal)) {
          if (ev.name === "done" && typeof ev.data.run_id === "string") {
            setLastRunId(ev.data.run_id);
          }
          const e = toEventLike(ev);
          setTraceEvents((prev) => [...prev, e]);
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
        // A scope-validation 400 (#308) carries per-field `issues` in
        // addition to the flat message — expose both so a caller with a
        // typed form can map issues onto rows, while `error` still reads
        // sanely for anyone only rendering the flat string.
        if (e instanceof ScopeValidationError) setScopeIssues(e.issues);
        if (!aborted) setError(e instanceof Error ? e.message : "stream dropped");
      } finally {
        setStreaming(false);
        abortRef.current = null;
      }
    },
    [streaming, agentId, patch, nextId],
  );

  const respondInput = useCallback(async (correlationId: string, answer: InputAnswer) => {
    const convId = convIdRef.current;
    if (!convId) return;
    await sendInputResponse(convId, correlationId, answer);
  }, []);

  const abort = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    convIdRef.current = null;
    creatingRef.current = null;
    setConversationId(null);
    setContext(null);
    setContextRedacted(null);
    setScopeIssues(null);
    setMessages([]);
    setStreaming(false);
    setError(null);
    setTraceEvents([]);
    setLastRunId(null);
  }, []);

  return {
    messages,
    streaming,
    error,
    conversationId,
    context,
    contextRedacted,
    scopeIssues,
    send,
    respondInput,
    abort,
    reset,
    traceEvents,
    lastRunId,
  };
}

/**
 * Stored-parts -> `Part` adapter (port-map §4.2.2) — maps a persisted
 * conversation's `ConversationMessage` + `ConversationMessagePart[]` (the
 * `GET /conversations/:id/messages` + `GET /messages/:id/parts` rows) onto
 * the SAME `Part` union `chat/model.ts`'s live SSE reducer builds, so session
 * replay renders through the identical `ChatPanel`/`MessageRow`/`PartView`
 * stack as a live turn — no second rendering path.
 *
 * This is a companion to `chat/model.ts`'s `applyParts`/`eventsToAssistantMessage`
 * (which fold live/persisted EVENTS), not a replacement — the source shape here
 * is already-structured stored PARTS, not raw events, so the fold is simpler
 * (no delta accumulation, no llm.start/end pairing).
 *
 * Honest note on today's actual data (verified against
 * `packages/agent-runtime/src/conversation/conversation.ts` `_persistExchange`):
 * the ONLY part types this runtime ever writes are `user_prompt` (request) and
 * `text` (response) — `Exchange.toolCalls` is always `[]`, so `tool_call` /
 * `tool_result` / `agent_step` parts are never actually produced yet. This
 * mapper still honors the fuller protocol-implied vocabulary (the
 * `ConversationStore.addMessage` parts type is an open `string`, and
 * `ConversationDetailPage` already renders tool_call/tool_result generically)
 * so a future producer that DOES persist them "just works" without a second
 * migration of this file. Field-name variants are read tolerantly
 * (snake_case AND camelCase), matching `graph/trace-from-events.ts`'s /
 * `chat/model.ts`'s accessor style, since no real row has ever exercised them.
 * Any part type outside this vocabulary degrades to a neutral text rendering
 * that names the type — it never silently disappears (port-map §6, mechanism 3).
 */
import type { ConversationMessage, ConversationMessagePart } from "../api/types";
import type { ChatMessage, Part, Role } from "./model";

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);
const meta = (p: ConversationMessagePart): Record<string, unknown> => p.metadata ?? {};

function roleOf(kind: ConversationMessage["kind"]): Role {
  return kind === "request" ? "user" : "assistant";
}

/**
 * Fold one message's ordered parts (by `position`) into the `Part[]` the chat
 * organism renders. `tool_call` + a later `tool_result` sharing an id fold
 * into ONE `tool_call` Part (fill semantics, mirroring `model.ts`'s live
 * tool.start/tool.end pairing) — keyed by `tool_call_id`/`toolCallId`,
 * falling back to the part's own row id when no such key is present.
 */
export function storedPartsToParts(parts: ConversationMessagePart[]): Part[] {
  const sorted = parts.slice().sort((a, b) => a.position - b.position);
  const result: Part[] = [];
  // id -> index of its `tool_call` Part in `result`, for the tool_result fill.
  const toolIndexById = new Map<string, number>();

  for (const part of sorted) {
    const m = meta(part);
    switch (part.type) {
      case "user_prompt":
      case "text": {
        result.push({ kind: "text", content: part.content ?? "" });
        break;
      }
      case "tool_call": {
        const id = str(m.tool_call_id) ?? str(m.toolCallId) ?? part.id;
        toolIndexById.set(id, result.length);
        result.push({
          kind: "tool_call",
          id,
          name: str(m.tool_name) ?? str(m.toolName) ?? "tool",
          arguments: m.arguments,
        });
        break;
      }
      case "tool_result": {
        const id = str(m.tool_call_id) ?? str(m.toolCallId) ?? part.id;
        const idx = toolIndexById.get(id);
        const existing =
          idx !== undefined ? (result[idx] as Extract<Part, { kind: "tool_call" }>) : undefined;
        const filled: Part = {
          kind: "tool_call",
          id,
          name: existing?.name ?? str(m.tool_name) ?? str(m.toolName) ?? "tool",
          arguments: existing?.arguments ?? m.arguments,
          result: part.content ?? m.result,
          error: str(m.error),
          durationMs: num(m.duration_ms) ?? num(m.durationMs),
        };
        if (idx !== undefined) result[idx] = filled;
        else result.push(filled);
        break;
      }
      case "agent_step": {
        // Stored parts are flat (no parent/child linkage persisted) —
        // `children` is honestly empty rather than fabricating nesting.
        result.push({
          kind: "agent_step",
          id: str(m.span_id) ?? str(m.spanId) ?? part.id,
          name: str(m.step_name) ?? str(m.stepName) ?? "step",
          agentName: str(m.agent_name) ?? str(m.agentName),
          arguments: m.arguments,
          result: m.result,
          error: str(m.error),
          durationMs: num(m.duration_ms) ?? num(m.durationMs),
          children: [],
        });
        break;
      }
      default: {
        // Unknown part type — degrade to a neutral text rendering that names
        // the type, never drop it (port-map §6, mechanism 3).
        const body = part.content ?? (Object.keys(m).length > 0 ? JSON.stringify(m) : "");
        result.push({ kind: "text", content: body ? `[${part.type}] ${body}` : `[${part.type}]` });
      }
    }
  }
  return result;
}

/** One stored message + its parts -> one `ChatMessage`. */
export function storedMessageToChatMessage(
  message: ConversationMessage,
  parts: ConversationMessagePart[],
): ChatMessage {
  const at = Date.parse(message.createdAt);
  return {
    id: message.id,
    role: roleOf(message.kind),
    parts: storedPartsToParts(parts),
    at: Number.isNaN(at) ? undefined : at,
    inputTokens: message.inputTokens,
    outputTokens: message.outputTokens,
  };
}

/**
 * A full session's messages (ASC by `createdAt`) + a parts-by-message-id map
 * -> the `ChatMessage[]` `ChatPanel` renders read-only (`onSend` omitted).
 */
export function storedMessagesToChat(
  messages: ConversationMessage[],
  partsByMessageId: Map<string, ConversationMessagePart[]>,
): ChatMessage[] {
  return messages
    .slice()
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
    .map((m) => storedMessageToChatMessage(m, partsByMessageId.get(m.id) ?? []));
}

/**
 * Rehydration (#480) — the inverse of `Conversation._persistExchange`.
 *
 * `_persistExchange` flattens one `Exchange` into TWO `StoredMessage`s (a
 * `request` carrying a `user_prompt` part, then a `response` carrying the
 * answer `text` plus any `state_delta` frames). Nothing zipped them back, so
 * `ConversationStore` was write-only in practice: a stored conversation could
 * be listed and read, never continued. This module closes that loop, which is
 * what lets a chat outlive the process that created it.
 *
 * Deliberately a pure function over the `ConversationStore` protocol — it
 * takes `StoredMessage[]`, not a store — so it works against any
 * implementation and is testable without one.
 */

import type { Exchange } from "./conversation.js";
import type { StoredMessage, StoredMessagePart } from "./store.js";

/**
 * Rebuild the `Exchange` history from a conversation's stored messages.
 *
 * Pairing: messages are walked in stored order and zipped request→response.
 * The store guarantees insertion order via `seq` (SQLite) / array order
 * (in-memory), and `_persistExchange` always writes the pair together in one
 * transaction, so alternation holds in practice — but this is written to
 * survive violations rather than assume them:
 *
 * - A `request` with no following `response` (the last turn errored before
 *   producing text, or the process died mid-turn) is DROPPED. Keeping it
 *   would feed a user message with no assistant reply into
 *   `_toMessageHistory()`, and the resumed run would send two consecutive
 *   user turns to the provider — an alternation violation that several
 *   providers reject outright.
 * - A `response` with no preceding `request` is skipped for the same reason.
 * - Consecutive `request`s drop all but the last (the earlier ones are
 *   unanswered by the rule above).
 *
 * Exchange numbers are re-derived densely from 1, matching how a live
 * `Conversation` numbers them — stored ordinals are not persisted, and a
 * dropped unpaired turn must not leave a hole.
 *
 * Not recovered: `toolCalls` (only `text`/`state_delta` parts are persisted,
 * so tool calls are not in the store to recover — the array comes back empty,
 * exactly as `_persistExchange` wrote it) and `invocationId` (per-run, never
 * persisted — a fresh one is minted so the field stays non-optional).
 */
export function exchangesFromMessages(messages: readonly StoredMessage[]): Exchange[] {
  const exchanges: Exchange[] = [];
  let pending: StoredMessage | undefined;

  for (const message of messages) {
    if (message.kind === "request") {
      pending = message;
      continue;
    }
    if (pending === undefined) continue;

    exchanges.push({
      number: exchanges.length + 1,
      invocationId: generateUUID(),
      user: joinTextParts(pending.parts),
      assistant: joinTextParts(message.parts),
      toolCalls: [],
      // Tokens live on the RESPONSE message — `_persistExchange` writes the
      // request with the default 0/0 and the usage numbers on the response.
      inputTokens: message.inputTokens,
      outputTokens: message.outputTokens,
      timestamp: message.createdAt,
      ...(message.runId !== undefined ? { runId: message.runId } : {}),
    });
    pending = undefined;
  }

  return exchanges;
}

/**
 * Concatenate a message's human-readable content.
 *
 * Only parts that actually carry text contribute: `state_delta` frames (#226)
 * are persisted with an empty `content` precisely so they never leak into
 * previews or replayed prompt text, and the same exclusion has to hold here —
 * a Delta Frame is not something the user said or the model answered.
 * Mirrors `derivePreviewContent`'s join in `routes/conversations.ts`, so a
 * multi-part message rebuilds the same way it previews.
 */
function joinTextParts(parts: readonly StoredMessagePart[]): string {
  return parts
    .map((p) => p.content)
    .filter((c): c is string => typeof c === "string" && c.length > 0)
    .join("\n\n");
}

let _counter = 0;
function generateUUID(): string {
  if (typeof globalThis !== "undefined" && "crypto" in globalThis) {
    return (globalThis as unknown as { crypto: { randomUUID(): string } }).crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${(++_counter).toString(36)}`;
}

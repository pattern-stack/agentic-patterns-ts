/**
 * Message history conversion — canonical format to Vercel AI SDK ModelMessage[].
 *
 * Ported from Python: _convert_history_to_messages() in runners/agent.py
 */

import type { JSONValue } from "@ai-sdk/provider";
import type { ModelMessage } from "ai";
import type { CanonicalMessage } from "./types.js";

/**
 * Coerce an arbitrary tool result into a valid AI SDK JSON value before it is
 * embedded in a `tool-result` part's `output: { type: "json", value }`. The SDK
 * validates that value against `jsonValueSchema`, which rejects `undefined`,
 * non-finite numbers (`NaN`/`Infinity`), `bigint`, and functions — none of which
 * are JSON. A tool returning a row with an absent field (e.g. `occurred_at:
 * undefined`) would otherwise abort the whole run mid-loop with "messages must be
 * a ModelMessage[]". Round-trip through JSON — dropping `undefined` keys, nulling
 * non-finite numbers, stringifying `bigint` — to guarantee a conforming value.
 * (`Date` is handled by its own `toJSON`.) Falls back to a string on circular /
 * otherwise non-serializable input.
 */
export function toJsonValue(value: unknown): JSONValue {
  try {
    const json = JSON.stringify(value, (_k, v) => {
      if (typeof v === "bigint") return v.toString();
      if (typeof v === "number" && !Number.isFinite(v)) return null;
      return v;
    });
    return (json === undefined ? null : JSON.parse(json)) as JSONValue;
  } catch {
    return String(value);
  }
}

/**
 * Convert canonical internal message format to Vercel AI SDK ModelMessage[].
 *
 * Canonical format (from orchestration layer):
 *   { kind: "request", parts: [{ type: "user_prompt", content: "..." }] }
 *   { kind: "response", parts: [
 *     { type: "text", content: "..." },
 *     { type: "tool_call", tool_name: "...", tool_call_id: "...", arguments: {} },
 *     { type: "tool_return", tool_name: "...", tool_call_id: "...", content: "..." },
 *   ]}
 *
 * Vercel AI SDK (ModelMessage) format:
 *   { role: "user", content: "..." }
 *   { role: "assistant", content: [{ type: "text", text: "..." }, { type: "tool-call", input, ... }] }
 *   { role: "tool", content: [{ type: "tool-result", output: { type: "text", value }, ... }] }
 */
/**
 * Sanitize the SDK's own response messages before re-pushing them into the next iteration's
 * prompt. The runner re-pushes them VERBATIM to preserve provider metadata for multi-turn
 * continuity (Gemini's `thoughtSignature`, Anthropic thinking blocks). But Gemini 3.x can emit
 * a `reasoning` or `text` part whose payload is ONLY the signature (in `providerOptions`) with
 * no `text` — and the AI SDK's `modelMessageSchema` requires `text: string` on both — so
 * re-sending it throws "messages must be a ModelMessage[]" and aborts the run mid-loop. Coerce
 * a missing / non-string `text` to "" on reasoning and text parts — which preserves
 * `providerOptions`/`thoughtSignature` (so Gemini multi-turn keeps working) while satisfying
 * validation. Mutates in place (these messages are about to be appended and re-sent; the SDK
 * returns them as structuredClone copies, so they are safe to mutate) and returns the array.
 */
export function sanitizeResponseMessages(messages: ModelMessage[]): ModelMessage[] {
  for (const m of messages) {
    if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
    for (const part of m.content as Array<{ type?: string; text?: unknown }>) {
      if ((part?.type === "reasoning" || part?.type === "text") && typeof part.text !== "string") {
        part.text = "";
      }
    }
  }
  return messages;
}

export function convertHistory(history: CanonicalMessage[]): ModelMessage[] {
  const messages: ModelMessage[] = [];

  for (const msg of history) {
    if (msg.kind === "request") {
      // Request messages contain user prompts
      for (const part of msg.parts) {
        if (part.type === "user_prompt" && part.content) {
          messages.push({ role: "user" as const, content: part.content });
        }
        // system_prompt parts are handled separately by agent.renderInitialPrompt()
      }
    } else if (msg.kind === "response") {
      // Response messages contain assistant text and tool calls
      const textParts: string[] = [];
      const toolCalls: Array<{
        toolCallId: string;
        toolName: string;
        args: Record<string, unknown>;
      }> = [];
      const toolReturns: Array<{
        toolCallId: string;
        content: string;
      }> = [];

      for (const part of msg.parts) {
        if (part.type === "text" && part.content) {
          textParts.push(part.content);
        } else if (part.type === "tool_call") {
          toolCalls.push({
            toolCallId: part.tool_call_id ?? "",
            toolName: part.tool_name ?? "",
            args: part.arguments ?? {},
          });
        } else if (part.type === "tool_return") {
          toolReturns.push({
            toolCallId: part.tool_call_id ?? "",
            content: part.content ?? "",
          });
        }
      }

      // Build assistant message with content parts array for mixed text+tool calls
      if (textParts.length > 0 || toolCalls.length > 0) {
        if (toolCalls.length === 0) {
          // Text-only response
          messages.push({
            role: "assistant" as const,
            content: textParts.join(""),
          });
        } else {
          // Mixed text + tool calls — use content array format. ToolCallPart
          // carries the call payload under `input` (renamed from `args` at v5;
          // unchanged through v7).
          const contentParts: Array<
            | { type: "text"; text: string }
            | {
                type: "tool-call";
                toolCallId: string;
                toolName: string;
                input: unknown;
              }
          > = [];

          if (textParts.length > 0) {
            contentParts.push({ type: "text", text: textParts.join("") });
          }
          for (const tc of toolCalls) {
            contentParts.push({
              type: "tool-call",
              toolCallId: tc.toolCallId,
              toolName: tc.toolName,
              input: tc.args,
            });
          }

          messages.push({
            role: "assistant" as const,
            content: contentParts,
          });
        }
      }

      // Tool results as separate tool messages. ToolResultPart carries the
      // result under `output` as a typed union (since v5; unchanged through
      // v7); the canonical format only has a string, so we wrap it as
      // `{ type: "text", value }`.
      if (toolReturns.length > 0) {
        const toolResultParts = toolReturns.map((tr) => ({
          type: "tool-result" as const,
          toolCallId: tr.toolCallId,
          toolName: "", // not available in canonical format
          output: { type: "text" as const, value: tr.content },
        }));
        messages.push({
          role: "tool" as const,
          content: toolResultParts,
        });
      }
    }
  }

  return messages;
}

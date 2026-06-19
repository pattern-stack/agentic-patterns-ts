/**
 * Message history conversion — canonical format to Vercel AI SDK ModelMessage[].
 *
 * Ported from Python: _convert_history_to_messages() in runners/agent.py
 */

import type { ModelMessage } from "ai";
import type { CanonicalMessage } from "./types.js";

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
 * Vercel AI SDK v5 (ModelMessage) format:
 *   { role: "user", content: "..." }
 *   { role: "assistant", content: [{ type: "text", text: "..." }, { type: "tool-call", input, ... }] }
 *   { role: "tool", content: [{ type: "tool-result", output: { type: "text", value }, ... }] }
 */
/**
 * Sanitize the SDK's own response messages before re-pushing them into the next iteration's
 * prompt. The runner re-pushes them VERBATIM to preserve provider metadata for multi-turn
 * continuity (Gemini's `thoughtSignature`, Anthropic thinking blocks). But Gemini 3.x can emit
 * a `reasoning` or `text` part whose payload is ONLY the signature (in `providerOptions`) with
 * no `text` — and AI SDK v5's `modelMessageSchema` requires `text: string` on both — so
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
        // system_prompt parts are handled separately by agent.getSystemPrompt()
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
          // Mixed text + tool calls — use content array format. v5's
          // ToolCallPart carries the call payload under `input` (was `args`).
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

      // Tool results as separate tool messages. v5's ToolResultPart carries the
      // result under `output` as a typed union; the canonical format only has a
      // string, so we wrap it as `{ type: "text", value }`.
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

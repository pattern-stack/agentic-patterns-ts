/**
 * Message history conversion — canonical format to Vercel AI SDK CoreMessage[].
 *
 * Ported from Python: _convert_history_to_messages() in runners/agent.py
 */

import type { CoreMessage } from "ai";
import type { CanonicalMessage } from "./types.js";

/**
 * Convert canonical internal message format to Vercel AI SDK CoreMessage[].
 *
 * Canonical format (from orchestration layer):
 *   { kind: "request", parts: [{ type: "user_prompt", content: "..." }] }
 *   { kind: "response", parts: [
 *     { type: "text", content: "..." },
 *     { type: "tool_call", tool_name: "...", tool_call_id: "...", arguments: {} },
 *     { type: "tool_return", tool_name: "...", tool_call_id: "...", content: "..." },
 *   ]}
 *
 * Vercel AI SDK format:
 *   { role: "user", content: "..." }
 *   { role: "assistant", content: [{ type: "text", text: "..." }, { type: "tool-call", ... }] }
 *   { role: "tool", content: [{ type: "tool-result", ... }] }
 */
export function convertHistory(history: CanonicalMessage[]): CoreMessage[] {
  const messages: CoreMessage[] = [];

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
          // Mixed text + tool calls — use content array format
          const contentParts: Array<
            | { type: "text"; text: string }
            | {
                type: "tool-call";
                toolCallId: string;
                toolName: string;
                args: Record<string, unknown>;
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
              args: tc.args,
            });
          }

          messages.push({
            role: "assistant" as const,
            content: contentParts,
          });
        }
      }

      // Tool results as separate tool messages
      if (toolReturns.length > 0) {
        const toolResultParts = toolReturns.map((tr) => ({
          type: "tool-result" as const,
          toolCallId: tr.toolCallId,
          toolName: "", // not available in canonical format
          result: tr.content,
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

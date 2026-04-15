/**
 * Map Claude Code hook events to canonical AgentEvent variants.
 *
 * Only PreToolUse / PostToolUse currently map to standard events
 * (`agent.tool.start` / `agent.tool.end`). All other hook names yield
 * an empty array — consumers that want full coverage should subscribe
 * to `claude_code.hook` directly.
 */

import type { ClaudeCodeHookEvent } from "./claude-code.js";
import type { AgentEvent } from "./types.js";

function toRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

export function mapClaudeCodeHookToAgentEvents(event: ClaudeCodeHookEvent): AgentEvent[] {
  const { hookName, traceId, runId, spanId, parentSpanId, toolUseId, toolName } = event;
  const toolCallId = toolUseId ?? spanId;
  const args = toRecord(event.toolInput);

  if (hookName === "PreToolUse") {
    return [
      {
        type: "agent.tool.start",
        traceId,
        runId,
        spanId,
        parentSpanId,
        timestamp: new Date(),
        toolCallId,
        toolName: toolName ?? "unknown",
        arguments: args,
      },
    ];
  }

  if (hookName === "PostToolUse") {
    const errorVal = (event.payload as { error?: unknown }).error;
    const errorStr =
      typeof errorVal === "string"
        ? errorVal
        : errorVal !== undefined && errorVal !== null
          ? String(errorVal)
          : undefined;

    return [
      {
        type: "agent.tool.end",
        traceId,
        runId,
        spanId,
        parentSpanId,
        timestamp: new Date(),
        toolCallId,
        toolName: toolName ?? "unknown",
        arguments: args,
        result: event.toolResponse,
        durationMs: 0,
        resultTokens: 0,
        ...(errorStr !== undefined ? { error: errorStr } : {}),
      },
    ];
  }

  return [];
}

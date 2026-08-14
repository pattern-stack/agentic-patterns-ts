/**
 * Claude Code hook bridge — receive hook callbacks from the Claude Code
 * CLI and republish them on the AgentEventBus.
 *
 * The Claude Code CLI is configured (via `.claude/settings.json`) to POST
 * each hook callback as JSON to `/hooks/:eventType`. We validate the
 * event name against the known hook list, normalize the payload into a
 * `ClaudeCodeHookEvent`, publish it to the bus, then publish any derived
 * canonical events (PreToolUse → agent.tool.start, etc.).
 */

import {
  type AgentEventBus,
  type ClaudeCodeHookEvent,
  isClaudeCodeHookName,
  mapClaudeCodeHookToAgentEvents,
} from "@pattern-stack/agentic-runtime";
import { Hono } from "hono";

function newSpanId(): string {
  if (typeof globalThis !== "undefined" && "crypto" in globalThis) {
    return (globalThis as unknown as { crypto: { randomUUID(): string } }).crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function hookRoutes(eventBus: AgentEventBus): Hono {
  const app = new Hono();

  app.post("/hooks/:eventType", async (c) => {
    const eventType = c.req.param("eventType");
    if (!isClaudeCodeHookName(eventType)) {
      return c.json({ error: `unknown hook event: ${eventType}` }, 400);
    }

    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const sessionId = typeof body.session_id === "string" ? body.session_id : "unknown";

    // Runner correlation: when a ClaudeCodeRunner spawned this CC session it
    // tags every hook POST with `x-ap-runner-correlation-id`. We preserve the
    // raw hook (PreCompact, PermissionRequest, etc. give value the runner
    // doesn't emit) but SKIP deriving `agent.tool.start`/`agent.tool.end`
    // events to avoid double-counting alongside the runner's own tool events.
    const runnerCorrelationId = c.req.header("x-ap-runner-correlation-id") ?? undefined;

    const hookEvent: ClaudeCodeHookEvent = {
      type: "claude_code.hook",
      traceId: sessionId,
      runId: sessionId,
      spanId: newSpanId(),
      timestamp: new Date(),
      hookName: eventType,
      sessionId,
      transcriptPath: typeof body.transcript_path === "string" ? body.transcript_path : undefined,
      cwd: typeof body.cwd === "string" ? body.cwd : undefined,
      permissionMode: typeof body.permission_mode === "string" ? body.permission_mode : undefined,
      toolName: typeof body.tool_name === "string" ? body.tool_name : undefined,
      toolInput: body.tool_input,
      toolResponse: body.tool_response,
      toolUseId: typeof body.tool_use_id === "string" ? body.tool_use_id : undefined,
      payload: body,
      ...(runnerCorrelationId ? { runnerCorrelationId } : {}),
    };

    await eventBus.publish(hookEvent);

    if (!runnerCorrelationId) {
      const derived = mapClaudeCodeHookToAgentEvents(hookEvent);
      for (const e of derived) {
        await eventBus.publish(e);
      }
    }

    return c.json({ ok: true });
  });

  return app;
}

/**
 * Pure grouping helper: turns a flat feed of SSE stream events into a list
 * of Claude Code sessions keyed by `session_id`. Kept framework-free so it
 * can be unit-tested and memoized from the page.
 */

import type { StreamEvent } from "../hooks/useEventStream";

export interface SessionEvent {
  id: string;
  hookName: string;
  timestamp: string;
  toolName?: string;
  toolUseId?: string;
  runnerCorrelationId?: string;
  raw: Record<string, unknown>;
}

export interface SessionState {
  sessionId: string;
  firstSeen: string;
  lastSeen: string;
  cwd?: string;
  events: SessionEvent[];
  counts: Record<string, number>;
}

export const CLAUDE_CODE_EVENT_TYPE = "claude_code.hook";

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/**
 * Groups stream events into per-session buckets. Filters out anything that
 * isn't a `claude_code.hook` frame. Sorts sessions by most-recently-active
 * first (lastSeen desc). Within a session, events are kept in arrival order
 * (which matches timestamp order for a well-behaved stream).
 */
export function groupClaudeCodeEvents(events: StreamEvent[]): SessionState[] {
  const byId = new Map<string, SessionState>();

  for (const event of events) {
    if (event.type !== CLAUDE_CODE_EVENT_TYPE) continue;

    const data = event.data;
    const sessionId = str(data.session_id) ?? str(data.sessionId);
    if (!sessionId) continue;

    const hookName = str(data.hook_name) ?? str(data.hookName) ?? "unknown";
    const toolName = str(data.tool_name) ?? str(data.toolName);
    const toolUseId = str(data.tool_use_id) ?? str(data.toolUseId);
    const cwd = str(data.cwd);
    const timestamp = event.timestamp;
    const runnerCorrelationId = str(data.runner_correlation_id) ?? str(data.runnerCorrelationId);

    let session = byId.get(sessionId);
    if (!session) {
      session = {
        sessionId,
        firstSeen: timestamp,
        lastSeen: timestamp,
        events: [],
        counts: {},
      };
      if (cwd) session.cwd = cwd;
      byId.set(sessionId, session);
    }

    if (!session.cwd && cwd) session.cwd = cwd;
    if (timestamp < session.firstSeen) session.firstSeen = timestamp;
    if (timestamp > session.lastSeen) session.lastSeen = timestamp;

    const sessionEvent: SessionEvent = {
      id: event.id,
      hookName,
      timestamp,
      raw: data,
    };
    if (toolName) sessionEvent.toolName = toolName;
    if (toolUseId) sessionEvent.toolUseId = toolUseId;
    if (runnerCorrelationId) sessionEvent.runnerCorrelationId = runnerCorrelationId;

    session.events.push(sessionEvent);
    session.counts[hookName] = (session.counts[hookName] ?? 0) + 1;
  }

  return Array.from(byId.values()).sort((a, b) =>
    a.lastSeen < b.lastSeen ? 1 : a.lastSeen > b.lastSeen ? -1 : 0,
  );
}

/**
 * Coarse category for hook names so the UI can colorize consistently.
 */
export type HookCategory = "tool" | "permission" | "compact" | "session" | "notification" | "other";

export function hookCategory(hookName: string): HookCategory {
  const n = hookName.toLowerCase();
  if (n.includes("tool")) return "tool";
  if (n.includes("permission")) return "permission";
  if (n.includes("compact")) return "compact";
  if (n === "sessionstart" || n === "sessionend" || n === "stop" || n === "subagentstop") {
    return "session";
  }
  if (n.includes("notification") || n.includes("userpromptsubmit")) return "notification";
  return "other";
}

/**
 * Human-readable duration string for firstSeen→lastSeen.
 */
export function formatDuration(firstSeen: string, lastSeen: string): string {
  const ms = Math.max(0, new Date(lastSeen).getTime() - new Date(firstSeen).getTime());
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return `${m}m ${rs}s`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return `${h}h ${rm}m`;
}

/**
 * One-line summary derived from a hook event's raw payload.
 */
export function summarizeHook(event: SessionEvent): string {
  const d = event.raw;
  if (event.toolName) {
    const input = (d.tool_input ?? (d as Record<string, unknown>).toolInput) as
      | Record<string, unknown>
      | undefined;
    if (input) {
      const filePath = str(input.file_path) ?? str((input as Record<string, unknown>).filePath);
      if (filePath) return filePath;
      const command = str(input.command);
      if (command) return command.slice(0, 120);
      const pattern = str(input.pattern);
      if (pattern) return pattern;
      const url = str(input.url);
      if (url) return url;
    }
    return event.toolName;
  }
  const message = str(d.message);
  if (message) return message.slice(0, 120);
  const prompt = str(d.prompt) ?? str((d as Record<string, unknown>).user_prompt);
  if (prompt) return prompt.slice(0, 120);
  return "";
}

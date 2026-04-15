/**
 * Claude Code hook event — bridges Claude Code lifecycle hooks into the
 * AgentEventBus.
 *
 * The Claude Code CLI emits hook callbacks (PreToolUse, PostToolUse,
 * SessionStart, etc.) as JSON payloads to a configured command. The hook
 * bridge in `@pattern-stack/agent-server` receives those payloads via HTTP
 * and republishes each one as a `ClaudeCodeHookEvent`.
 *
 * The full raw hook payload is preserved on `payload` so downstream
 * consumers (dashboards, exporters) never lose information. A small
 * mappable subset (PreToolUse / PostToolUse) is also projected onto the
 * canonical `agent.tool.start` / `agent.tool.end` events by the
 * `mapClaudeCodeHookToAgentEvents` helper in
 * `./claude-code-mapper.ts` — that lives in a separate file so this
 * module stays a pure type/constant declaration.
 */

import type { BaseEvent } from "./types.js";

export const CLAUDE_CODE_HOOK_EVENTS = [
  "SessionStart",
  "InstructionsLoaded",
  "UserPromptSubmit",
  "PreToolUse",
  "PermissionRequest",
  "PermissionDenied",
  "PostToolUse",
  "PostToolUseFailure",
  "Notification",
  "SubagentStart",
  "SubagentStop",
  "TaskCreated",
  "TaskCompleted",
  "Stop",
  "StopFailure",
  "TeammateIdle",
  "ConfigChange",
  "CwdChanged",
  "FileChanged",
  "WorktreeCreate",
  "WorktreeRemove",
  "PreCompact",
  "PostCompact",
  "Elicitation",
  "ElicitationResult",
  "SessionEnd",
] as const;

export type ClaudeCodeHookName = (typeof CLAUDE_CODE_HOOK_EVENTS)[number];

/**
 * A single Claude Code hook callback, lifted into an AgentEvent.
 *
 * Every Claude Code hook invocation produces one of these. The full
 * raw payload is preserved on `payload`; common fields (sessionId,
 * cwd, toolName, ...) are also surfaced as top-level convenience
 * properties for typed consumers. PreToolUse and PostToolUse can be
 * additionally mapped to canonical `agent.tool.start` / `agent.tool.end`
 * events via `mapClaudeCodeHookToAgentEvents`.
 */
export interface ClaudeCodeHookEvent extends BaseEvent {
  readonly type: "claude_code.hook";
  readonly hookName: ClaudeCodeHookName;
  readonly sessionId: string;
  readonly transcriptPath?: string;
  readonly cwd?: string;
  readonly permissionMode?: string;
  readonly toolName?: string;
  readonly toolInput?: unknown;
  readonly toolResponse?: unknown;
  readonly toolUseId?: string;
  /** Full raw hook payload, preserved verbatim. */
  readonly payload: Record<string, unknown>;
  /**
   * Correlation id propagated from a runner (e.g. `ClaudeCodeRunner`) that
   * is already observing this session. When present, the hook route SKIPS
   * deriving `agent.tool.start`/`agent.tool.end` events — the runner
   * already emits them — while still preserving the raw hook event for
   * full fidelity (PreCompact, PermissionRequest, etc.).
   */
  readonly runnerCorrelationId?: string;
}

export function isClaudeCodeHookName(s: unknown): s is ClaudeCodeHookName {
  return typeof s === "string" && (CLAUDE_CODE_HOOK_EVENTS as readonly string[]).includes(s);
}

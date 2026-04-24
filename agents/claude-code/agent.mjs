/**
 * Claude Code chat agent — run a local `claude` subprocess as a chat agent
 * in the playground dashboard.
 *
 * Authentication: the spawned subprocess inherits this process's shell env,
 * so your usual `~/.claude` OAuth session or `ANTHROPIC_API_KEY` is picked
 * up automatically — no config here.
 *
 * Tool surface: this agent uses `ClaudeCodeAPIRunner`, which blocks the
 * Claude Code-native tools (Read, Write, Edit, Bash, Glob, Grep, Agent,
 * NotebookEdit, TodoRead, TodoWrite, WebFetch, WebSearch) so the agent
 * behaves like a plain Claude conversation with no file or shell access.
 * MCP tools from agent capabilities remain available — this agent
 * registers none. If you want full-tool Claude Code, construct
 * `ClaudeCodeRunner` (not `ClaudeCodeAPIRunner`) directly in your own
 * `agent.mjs`.
 *
 * Session continuity: we export a `runner` as a `RunnerFactory`, so each
 * new conversation gets its own `ClaudeCodeAPIRunner` instance. That
 * instance captures the SDK `session_id` on turn 1 and passes `resume`
 * on every subsequent turn, so follow-up messages in the same
 * conversation share context with prior turns.
 *
 * Tool call visibility: tool calls made by the child claude appear inline
 * on the conversation's SSE stream via the `AP_RUNNER_CORRELATION_ID`
 * env var the runner sets before each SDK call — no extra wiring needed.
 * See `packages/agent-server/src/routes/hooks.ts` for the server-side
 * mechanism.
 */

import {
  ClaudeCodeAPIRunner,
  buildClaudeCodeChatAgent,
} from "../../packages/agent-runtime/dist/index.js";

export default () => ({
  id: "claude-code",
  name: "Claude Code",
  description: "Chat with a local claude subprocess (API-mode: MCP tools only).",
  agent: buildClaudeCodeChatAgent(),
  runner: {
    forConversation(_conversationId) {
      return new ClaudeCodeAPIRunner();
    },
  },
});

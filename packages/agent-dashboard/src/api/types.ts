/**
 * Dashboard API types — aligned with @agentic-patterns/runtime admin schemas.
 *
 * These mirror the Zod-inferred types from the runtime's admin/schemas.ts,
 * representing the JSON shapes returned by the server's admin routes.
 * Dates are serialized as ISO strings over the wire.
 */

export interface ToolStats {
  toolName: string;
  callCount: number;
  errorCount: number;
  totalDurationMs: number;
  avgDurationMs: number;
  lastUsed?: string;
}

export interface AgentStats {
  agentName: string;
  status: "idle" | "running" | "error" | "completed";
  totalIterations: number;
  totalToolCalls: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalErrors: number;
  startedAt?: string;
  lastEventAt?: string;
  toolStats: ToolStats[];
}

export interface DashboardStats {
  agents: AgentStats[];
  activeAgentCount: number;
  totalTokensUsed: number;
  totalToolCalls: number;
  totalErrors: number;
  activeConversationCount: number;
  uptimeMs: number;
}

export interface ToolAnalytics {
  toolName: string;
  totalCalls: number;
  totalErrors: number;
  totalDurationMs: number;
  avgDurationMs: number;
  agentBreakdown: Array<{ agentName: string; callCount: number }>;
}

export interface TokenUsageGroup {
  key: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  conversationCount: number;
}

/**
 * Row returned by `GET /admin/conversations` — aligns with runtime
 * `ConversationSummary` emitted by DrizzleAdminService.
 */
export interface ConversationSummary {
  conversationId: string;
  agentName: string;
  messageCount: number;
  tokenCount: number;
  startedAt: string;
  lastMessageAt?: string;
  status: "active" | "completed" | "error";
}

/**
 * Record returned by Team 2's `GET /conversations/:id` — the raw Drizzle
 * row. Fields beyond the runtime `ConversationSummary` (agentConfigId,
 * completedAt, error, model, createdAt, updatedAt) are surfaced here so
 * the detail page can show duration + error banner.
 */
export interface ConversationDetail {
  id: string;
  agentConfigId: string | null;
  status: string;
  agentName: string;
  model: string;
  tokenCount: number;
  messageCount: number;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Row from `GET /conversations/:id/messages`. Parts are loaded separately
 * from `GET /messages/:id/parts` — the messages list does not embed them.
 */
export interface ConversationMessage {
  id: string;
  conversationId: string;
  kind: "request" | "response";
  runId: string | null;
  inputTokens: number;
  outputTokens: number;
  content: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationMessagePart {
  id: string;
  messageId: string;
  type: string;
  content: string | null;
  metadata: Record<string, unknown> | null;
  position: number;
  createdAt: string;
  updatedAt: string;
}

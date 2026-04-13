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

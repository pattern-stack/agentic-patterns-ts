export interface TokenUsageRow {
  agentId: string;
  agentName: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface AgentStats {
  id: string;
  name: string;
  model: string;
  conversations: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  errors: number;
  lastActive: string | null;
}

export interface ToolStats {
  name: string;
  calls: number;
  successes: number;
  failures: number;
  successRate: number;
  avgDurationMs: number;
}

export interface DashboardStats {
  agentCount: number;
  conversationCount: number;
  conversationsByState: Record<string, number>;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalTokens: number;
  errorCount: number;
  errorRate: number;
  agents: AgentStats[];
  tools: ToolStats[];
  tokenUsage: TokenUsageRow[];
}

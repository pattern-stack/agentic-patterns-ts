/**
 * Server configuration types.
 */

import type { EventBus } from "@agentic-patterns/runtime";

/**
 * Agent registration — what the server knows about each agent.
 */
export interface AgentRegistration {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  /** The agent object (minimal shape needed by Conversation). */
  readonly agent: {
    getModel(): string;
    getTools(): unknown[];
    getSystemPrompt(): string;
    renderInitialPrompt(): string;
    role: { name: string };
  };
  /** The runner for this agent. */
  readonly runner: {
    run(
      agent: {
        getModel(): string;
        getTools(): unknown[];
        getSystemPrompt(): string;
        renderInitialPrompt(): string;
        role: { name: string };
      },
      message: string,
      options?: Record<string, unknown>,
    ): Promise<{
      response: string;
      inputTokens: number;
      outputTokens: number;
      toolCallsCount: number;
      iterations: number;
      finishReason: string;
    }>;
    stream?(
      agent: {
        getModel(): string;
        getTools(): unknown[];
        getSystemPrompt(): string;
        renderInitialPrompt(): string;
        role: { name: string };
      },
      message: string,
      options?: Record<string, unknown>,
    ): AsyncGenerator<import("@agentic-patterns/runtime").AgentEvent>;
  };
}

/**
 * Admin service protocol — what the server needs for admin routes.
 */
export interface AdminServiceProtocol {
  getDashboard(): Promise<DashboardResponse>;
  listAgentStats(): Promise<AgentStatsResponse[]>;
  getToolAnalytics(): Promise<ToolStatsResponse[]>;
  getTokenUsage(params: TokenUsageParams): Promise<TokenUsageResponse[]>;
}

export interface DashboardResponse {
  activeConversations: number;
  totalConversations: number;
  totalExchanges: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  errorCount: number;
  agentCount: number;
}

export interface AgentStatsResponse {
  name: string;
  conversationCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
}

export interface ToolStatsResponse {
  toolName: string;
  callCount: number;
  successCount: number;
  failureCount: number;
  avgDurationMs: number;
}

export interface TokenUsageParams {
  groupBy: "agent" | "model";
}

export interface TokenUsageResponse {
  group: string;
  inputTokens: number;
  outputTokens: number;
  conversations: number;
}

/**
 * SSE exporter interface — structural typing for SSEExporter from runtime.
 */
export interface SSEExporterLike {
  connect(): ReadableStream<Uint8Array>;
  disconnect(stream: ReadableStream<Uint8Array>): void;
}

/**
 * Conversation store interface — structural typing for ConversationStoreProtocol.
 */
export interface ConversationStoreLike {
  get(id: string): Promise<unknown>;
  list(): Promise<unknown[]>;
}

/**
 * Server configuration.
 */
export interface ServerConfig {
  readonly agents: AgentRegistration[];
  readonly adminService: AdminServiceProtocol;
  readonly eventBus: EventBus;
  readonly sseExporter: SSEExporterLike;
  readonly store?: ConversationStoreLike;
  readonly staticDir?: string;
}

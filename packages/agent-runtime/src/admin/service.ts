/**
 * Admin service protocol and in-memory implementation.
 *
 * AdminServiceProtocol defines the async interface for admin queries.
 * InMemoryAdminService delegates to an InMemoryEventCollector.
 */

import type { InMemoryEventCollector } from "./collector.js";
import type {
  AgentStats,
  ConversationSummary,
  DashboardStats,
  DateFilters,
  TokenUsageGroup,
  ToolAnalytics,
  TraceEvent,
  TraceSummary,
} from "./schemas.js";

// ---------------------------------------------------------------------------
// Protocol
// ---------------------------------------------------------------------------

/** Async interface for admin dashboard queries. */
export interface AdminServiceProtocol {
  getDashboardStats(): Promise<DashboardStats>;
  getAgentStats(agentName: string): Promise<AgentStats | undefined>;
  getAllAgentStats(): Promise<AgentStats[]>;
  getRecentEvents(limit?: number): Promise<TraceEvent[]>;
  getTraceSummaries(): Promise<TraceSummary[]>;
  getConversations(): Promise<ConversationSummary[]>;
  getToolAnalytics(filters?: DateFilters): Promise<ToolAnalytics[]>;
  getTokenUsage(params: { groupBy: "agent" | "model" }): Promise<TokenUsageGroup[]>;
}

// ---------------------------------------------------------------------------
// In-memory implementation
// ---------------------------------------------------------------------------

/**
 * In-memory admin service backed by an InMemoryEventCollector.
 *
 * All methods delegate directly to the collector's synchronous query
 * methods, wrapped in Promise resolution for protocol compliance.
 */
export class InMemoryAdminService implements AdminServiceProtocol {
  private _collector: InMemoryEventCollector;

  constructor(collector: InMemoryEventCollector) {
    this._collector = collector;
  }

  async getDashboardStats(): Promise<DashboardStats> {
    return this._collector.getDashboardStats();
  }

  async getAgentStats(agentName: string): Promise<AgentStats | undefined> {
    return this._collector.getAgentStats(agentName);
  }

  async getAllAgentStats(): Promise<AgentStats[]> {
    return this._collector.getAllAgentStats();
  }

  async getRecentEvents(limit?: number): Promise<TraceEvent[]> {
    return this._collector.getRecentEvents(limit);
  }

  async getTraceSummaries(): Promise<TraceSummary[]> {
    return this._collector.getTraceSummaries();
  }

  async getConversations(): Promise<ConversationSummary[]> {
    return this._collector.getConversations();
  }

  async getToolAnalytics(filters?: DateFilters): Promise<ToolAnalytics[]> {
    return this._collector.getToolAnalytics(filters);
  }

  async getTokenUsage(params: { groupBy: "agent" | "model" }): Promise<TokenUsageGroup[]> {
    return this._collector.getTokenUsage(params);
  }
}

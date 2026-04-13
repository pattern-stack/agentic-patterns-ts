/**
 * In-memory event collector for admin observability.
 *
 * Extends BaseExporter to subscribe to agent events and maintain
 * live statistics, ring-buffered recent events, and per-agent state.
 */

import { EventProfile } from "../events/event-profiles.js";
import type {
  BaseEvent,
  ErrorEvent,
  IterationEndEvent,
  IterationStartEvent,
  LLMCallEndEvent,
  MessageCompleteEvent,
  MessageStartEvent,
  ToolCallEndEvent,
  ToolCallStartEvent,
} from "../events/types.js";
import { BaseExporter } from "../exporters/base.js";
import type {
  AgentStats,
  ConversationSummary,
  DashboardStats,
  ToolStats,
  TraceEvent,
  TraceSummary,
} from "./schemas.js";

// ---------------------------------------------------------------------------
// Ring buffer
// ---------------------------------------------------------------------------

class RingBuffer<T> {
  private _items: T[] = [];
  private _capacity: number;

  constructor(capacity: number) {
    this._capacity = capacity;
  }

  push(item: T): void {
    if (this._items.length >= this._capacity) {
      this._items.shift();
    }
    this._items.push(item);
  }

  toArray(): T[] {
    return [...this._items];
  }

  get length(): number {
    return this._items.length;
  }
}

// ---------------------------------------------------------------------------
// Internal mutable state
// ---------------------------------------------------------------------------

interface MutableAgentStats {
  agentName: string;
  status: "idle" | "running" | "error" | "completed";
  totalIterations: number;
  totalToolCalls: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalErrors: number;
  startedAt?: Date;
  lastEventAt?: Date;
  toolStats: Map<string, MutableToolStats>;
}

interface MutableToolStats {
  toolName: string;
  callCount: number;
  errorCount: number;
  totalDurationMs: number;
  lastUsed?: Date;
}

// ---------------------------------------------------------------------------
// InMemoryEventCollector
// ---------------------------------------------------------------------------

/**
 * Collects agent events in memory for admin dashboard queries.
 *
 * Subscribes to the UX event profile and maintains:
 * - Per-agent statistics (iterations, tokens, tool calls, errors)
 * - Per-tool statistics (call count, duration, errors)
 * - Ring buffer of recent trace events (capped at 1000)
 * - Trace summaries by traceId
 */
export class InMemoryEventCollector extends BaseExporter {
  override profile = EventProfile.UX;

  private _startedAt = new Date();
  private _agents = new Map<string, MutableAgentStats>();
  private _recentEvents = new RingBuffer<TraceEvent>(1000);
  private _traces = new Map<
    string,
    {
      agentName: string;
      startedAt: Date;
      iterationCount: number;
      totalTokens: number;
      status: "running" | "completed" | "error";
    }
  >();

  // ---------------------------------------------------------------------------
  // Query methods
  // ---------------------------------------------------------------------------

  /** Get dashboard-level aggregate statistics. */
  getDashboardStats(): DashboardStats {
    const agents = this._getAgentStatsList();
    return {
      agents,
      activeAgentCount: agents.filter((a) => a.status === "running").length,
      totalTokensUsed: agents.reduce((sum, a) => sum + a.totalInputTokens + a.totalOutputTokens, 0),
      totalToolCalls: agents.reduce((sum, a) => sum + a.totalToolCalls, 0),
      totalErrors: agents.reduce((sum, a) => sum + a.totalErrors, 0),
      uptimeMs: Date.now() - this._startedAt.getTime(),
    };
  }

  /** Get statistics for a specific agent. */
  getAgentStats(agentName: string): AgentStats | undefined {
    const internal = this._agents.get(agentName);
    if (!internal) return undefined;
    return this._toAgentStats(internal);
  }

  /** Get all agent statistics. */
  getAllAgentStats(): AgentStats[] {
    return this._getAgentStatsList();
  }

  /** Get recent trace events from the ring buffer. */
  getRecentEvents(limit?: number): TraceEvent[] {
    const all = this._recentEvents.toArray();
    if (limit !== undefined && limit < all.length) {
      return all.slice(all.length - limit);
    }
    return all;
  }

  /** Get all trace summaries. */
  getTraceSummaries(): TraceSummary[] {
    const summaries: TraceSummary[] = [];
    for (const [traceId, trace] of this._traces) {
      summaries.push({
        traceId,
        agentName: trace.agentName,
        startedAt: trace.startedAt,
        durationMs: Date.now() - trace.startedAt.getTime(),
        status: trace.status,
        iterationCount: trace.iterationCount,
        totalTokens: trace.totalTokens,
      });
    }
    return summaries;
  }

  /** Get conversations (derived from traces). */
  getConversations(): ConversationSummary[] {
    const conversations: ConversationSummary[] = [];
    for (const [traceId, trace] of this._traces) {
      conversations.push({
        conversationId: traceId,
        agentName: trace.agentName,
        messageCount: trace.iterationCount,
        tokenCount: trace.totalTokens,
        startedAt: trace.startedAt,
        status: trace.status === "running" ? "active" : trace.status,
      });
    }
    return conversations;
  }

  // ---------------------------------------------------------------------------
  // Event handlers
  // ---------------------------------------------------------------------------

  /** @internal */
  async _onMessageStart(event: MessageStartEvent): Promise<void> {
    this._recordEvent(event);
    const agent = this._ensureAgent(event.agentName);
    agent.status = "running";
    if (!agent.startedAt) {
      agent.startedAt = event.timestamp;
    }
    agent.lastEventAt = event.timestamp;

    // Track trace
    if (!this._traces.has(event.traceId)) {
      this._traces.set(event.traceId, {
        agentName: event.agentName,
        startedAt: event.timestamp,
        iterationCount: 0,
        totalTokens: 0,
        status: "running",
      });
    }
  }

  /** @internal */
  async _onMessageComplete(event: MessageCompleteEvent): Promise<void> {
    this._recordEvent(event);
    // Find agent by traceId
    const trace = this._traces.get(event.traceId);
    if (trace) {
      const agent = this._agents.get(trace.agentName);
      if (agent) {
        agent.totalInputTokens += event.inputTokens;
        agent.totalOutputTokens += event.outputTokens;
        agent.lastEventAt = event.timestamp;
      }
      trace.totalTokens += event.inputTokens + event.outputTokens;
    }
  }

  /** @internal */
  async _onIterationStart(event: IterationStartEvent): Promise<void> {
    this._recordEvent(event);
    const trace = this._traces.get(event.traceId);
    if (trace) {
      const agent = this._agents.get(trace.agentName);
      if (agent) {
        agent.lastEventAt = event.timestamp;
      }
    }
  }

  /** @internal */
  async _onIterationEnd(event: IterationEndEvent): Promise<void> {
    this._recordEvent(event);
    const trace = this._traces.get(event.traceId);
    if (trace) {
      trace.iterationCount = event.iteration + 1;
      const agent = this._agents.get(trace.agentName);
      if (agent) {
        agent.totalIterations = Math.max(agent.totalIterations, event.iteration + 1);
        agent.lastEventAt = event.timestamp;
      }
    }
  }

  /** @internal */
  async _onToolStart(event: ToolCallStartEvent): Promise<void> {
    this._recordEvent(event);
    const trace = this._traces.get(event.traceId);
    if (trace) {
      const agent = this._agents.get(trace.agentName);
      if (agent) {
        agent.lastEventAt = event.timestamp;
      }
    }
  }

  /** @internal */
  async _onToolEnd(event: ToolCallEndEvent): Promise<void> {
    this._recordEvent(event);
    const trace = this._traces.get(event.traceId);
    if (trace) {
      const agent = this._agents.get(trace.agentName);
      if (agent) {
        agent.totalToolCalls += 1;
        agent.lastEventAt = event.timestamp;

        // Update tool stats
        let toolStats = agent.toolStats.get(event.toolName);
        if (!toolStats) {
          toolStats = {
            toolName: event.toolName,
            callCount: 0,
            errorCount: 0,
            totalDurationMs: 0,
          };
          agent.toolStats.set(event.toolName, toolStats);
        }
        toolStats.callCount += 1;
        toolStats.totalDurationMs += event.durationMs;
        toolStats.lastUsed = event.timestamp;
        if (event.error) {
          toolStats.errorCount += 1;
        }
      }
    }
  }

  /** @internal */
  async _onLlmEnd(event: LLMCallEndEvent): Promise<void> {
    this._recordEvent(event);
  }

  /** @internal */
  async _onError(event: ErrorEvent): Promise<void> {
    this._recordEvent(event);
    const trace = this._traces.get(event.traceId);
    if (trace) {
      trace.status = "error";
      const agent = this._agents.get(trace.agentName);
      if (agent) {
        agent.totalErrors += 1;
        agent.status = "error";
        agent.lastEventAt = event.timestamp;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  private _ensureAgent(agentName: string): MutableAgentStats {
    let agent = this._agents.get(agentName);
    if (!agent) {
      agent = {
        agentName,
        status: "idle",
        totalIterations: 0,
        totalToolCalls: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalErrors: 0,
        toolStats: new Map(),
      };
      this._agents.set(agentName, agent);
    }
    return agent;
  }

  private _recordEvent(event: BaseEvent): void {
    this._recentEvents.push({
      type: event.type,
      timestamp: event.timestamp,
      spanId: event.spanId,
      parentSpanId: event.parentSpanId,
      data: {},
    });
  }

  private _toAgentStats(internal: MutableAgentStats): AgentStats {
    const toolStats: ToolStats[] = [];
    for (const ts of internal.toolStats.values()) {
      toolStats.push({
        toolName: ts.toolName,
        callCount: ts.callCount,
        errorCount: ts.errorCount,
        totalDurationMs: ts.totalDurationMs,
        avgDurationMs: ts.callCount > 0 ? ts.totalDurationMs / ts.callCount : 0,
        lastUsed: ts.lastUsed,
      });
    }
    return {
      agentName: internal.agentName,
      status: internal.status,
      totalIterations: internal.totalIterations,
      totalToolCalls: internal.totalToolCalls,
      totalInputTokens: internal.totalInputTokens,
      totalOutputTokens: internal.totalOutputTokens,
      totalErrors: internal.totalErrors,
      startedAt: internal.startedAt,
      lastEventAt: internal.lastEventAt,
      toolStats,
    };
  }

  private _getAgentStatsList(): AgentStats[] {
    const result: AgentStats[] = [];
    for (const internal of this._agents.values()) {
      result.push(this._toAgentStats(internal));
    }
    return result;
  }
}

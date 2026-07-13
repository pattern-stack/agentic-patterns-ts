/**
 * In-memory event collector for admin observability.
 *
 * Extends BaseExporter to subscribe to agent events and maintain
 * live statistics, ring-buffered recent events, and per-agent state.
 */

import { EventProfile } from "../events/event-profiles.js";
import type {
  AgentEvent,
  BaseEvent,
  ConversationEndEvent,
  ConversationStartEvent,
  ErrorEvent,
  IterationEndEvent,
  IterationStartEvent,
  LLMCallEndEvent,
  MessageCancelEvent,
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
  DateFilters,
  TokenUsageGroup,
  ToolAnalytics,
  ToolStats,
  TraceEvent,
  TraceSummary,
} from "./schemas.js";

// ---------------------------------------------------------------------------
// Ring buffer
// ---------------------------------------------------------------------------

/**
 * Fixed-capacity circular buffer with O(1) push and O(n) materialization.
 *
 * Uses a pre-allocated array with head index + length instead of Array.shift()
 * to avoid O(n) reindexing on every push at capacity.
 */
class RingBuffer<T> {
  private readonly _items: (T | undefined)[];
  private readonly _capacity: number;
  private _start = 0;
  private _length = 0;

  constructor(capacity: number) {
    this._capacity = capacity;
    this._items = new Array(capacity);
  }

  push(item: T): void {
    const end = (this._start + this._length) % this._capacity;
    this._items[end] = item;
    if (this._length < this._capacity) {
      this._length += 1;
    } else {
      this._start = (this._start + 1) % this._capacity;
    }
  }

  toArray(): T[] {
    const result: T[] = [];
    for (let i = 0; i < this._length; i++) {
      const item = this._items[(this._start + i) % this._capacity];
      if (item !== undefined) result.push(item);
    }
    return result;
  }

  get length(): number {
    return this._length;
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

/** Per-call log entry retained in a ring buffer for date-filtered queries. */
interface ToolCallLogEntry {
  readonly toolName: string;
  readonly agentName: string;
  readonly durationMs: number;
  readonly isError: boolean;
  readonly timestamp: Date;
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
 * - Token usage by model
 * - Active conversation tracking
 */
export class InMemoryEventCollector extends BaseExporter {
  override profile = EventProfile.UX;

  private _startedAt = new Date();
  private _agents = new Map<string, MutableAgentStats>();
  private _recentEvents = new RingBuffer<TraceEvent>(1000);
  /** Bounded log of individual tool calls, used for date-filtered analytics. */
  private _toolCallLog = new RingBuffer<ToolCallLogEntry>(10_000);
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
  private _tokensByModel = new Map<
    string,
    { input: number; output: number; conversations: Set<string> }
  >();
  private _activeConversations = new Set<string>();

  // ---------------------------------------------------------------------------
  // Query methods
  // ---------------------------------------------------------------------------

  /** Get dashboard-level aggregate statistics. */
  getDashboardStats(): DashboardStats {
    const agents = this._getAgentStatsList();
    return {
      agents,
      activeAgentCount: agents.filter((a) => a.status === "running").length,
      activeConversationCount: this._activeConversations.size,
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

  /**
   * Get cross-agent tool analytics.
   *
   * When `filters` specify a date range, aggregation runs over the
   * per-call log (bounded to the most recent 10,000 calls). Without
   * filters, uses the lifetime aggregates on each agent.
   */
  getToolAnalytics(filters?: DateFilters): ToolAnalytics[] {
    if (filters && (filters.from || filters.to)) {
      return this._getToolAnalyticsFromLog(filters);
    }

    const toolMap = new Map<
      string,
      {
        totalCalls: number;
        totalErrors: number;
        totalDurationMs: number;
        agentBreakdown: Map<string, number>;
      }
    >();

    for (const agent of this._agents.values()) {
      for (const ts of agent.toolStats.values()) {
        let entry = toolMap.get(ts.toolName);
        if (!entry) {
          entry = {
            totalCalls: 0,
            totalErrors: 0,
            totalDurationMs: 0,
            agentBreakdown: new Map(),
          };
          toolMap.set(ts.toolName, entry);
        }
        entry.totalCalls += ts.callCount;
        entry.totalErrors += ts.errorCount;
        entry.totalDurationMs += ts.totalDurationMs;
        entry.agentBreakdown.set(
          agent.agentName,
          (entry.agentBreakdown.get(agent.agentName) ?? 0) + ts.callCount,
        );
      }
    }

    const result: ToolAnalytics[] = [];
    for (const [toolName, entry] of toolMap) {
      const agentBreakdown = Array.from(entry.agentBreakdown.entries()).map(
        ([agentName, callCount]) => ({ agentName, callCount }),
      );
      result.push({
        toolName,
        totalCalls: entry.totalCalls,
        totalErrors: entry.totalErrors,
        totalDurationMs: entry.totalDurationMs,
        avgDurationMs: entry.totalCalls > 0 ? entry.totalDurationMs / entry.totalCalls : 0,
        agentBreakdown,
      });
    }
    return result;
  }

  /** Get token usage grouped by agent or model. */
  getTokenUsage(params: { groupBy: "agent" | "model" }): TokenUsageGroup[] {
    if (params.groupBy === "agent") {
      return this._getAgentStatsList().map((a) => ({
        key: a.agentName,
        inputTokens: a.totalInputTokens,
        outputTokens: a.totalOutputTokens,
        totalTokens: a.totalInputTokens + a.totalOutputTokens,
        conversationCount: 0,
      }));
    }

    // groupBy model
    const result: TokenUsageGroup[] = [];
    for (const [model, entry] of this._tokensByModel) {
      result.push({
        key: model,
        inputTokens: entry.input,
        outputTokens: entry.output,
        totalTokens: entry.input + entry.output,
        conversationCount: entry.conversations.size,
      });
    }
    return result;
  }

  // ---------------------------------------------------------------------------
  // Event dispatch (overrides BaseExporter's dynamic _on* dispatch with an
  // explicit switch so the compiler catches new event types in AgentEvent
  // that do not yet have a handler.)
  // ---------------------------------------------------------------------------

  override async handleEvent(event: BaseEvent): Promise<void> {
    const typed = event as AgentEvent;
    switch (typed.type) {
      case "agent.conversation.start":
        await this._onConversationStart(typed);
        return;
      case "agent.conversation.end":
        await this._onConversationEnd(typed);
        return;
      case "agent.message.start":
        await this._onMessageStart(typed);
        return;
      case "agent.message.complete":
        await this._onMessageComplete(typed);
        return;
      case "agent.message.cancel":
        await this._onMessageCancel(typed);
        return;
      case "agent.iteration.start":
        await this._onIterationStart(typed);
        return;
      case "agent.iteration.end":
        await this._onIterationEnd(typed);
        return;
      case "agent.tool.start":
        await this._onToolStart(typed);
        return;
      case "agent.tool.end":
        await this._onToolEnd(typed);
        return;
      case "agent.llm.end":
        await this._onLlmEnd(typed);
        return;
      case "agent.error":
        await this._onError(typed);
        return;
      // Events on the UX profile we observe but do not aggregate. Recorded
      // into the ring buffer only. Listed explicitly so adding a new event
      // type to the profile forces a choice here.
      case "agent.message.chunk":
      case "agent.reasoning":
      case "agent.thinking.start":
      case "agent.tool.intent":
      case "agent.tool.rejected":
      case "agent.tool.progress":
      case "agent.step.start":
      case "agent.step.end":
      case "agent.llm.start":
      case "claude_code.hook":
      // State-delta events (#226): observed, never aggregated — the dashboard
      // folds these client-side (timeline frames + the Scratchpad rail).
      case "agent.backpack.drop":
      case "agent.backpack.read":
      case "agent.backpack.absorb":
      case "agent.scratchpad.write":
      case "agent.scratchpad.read":
      case "agent.scratchpad.fork":
      case "agent.scratchpad.join":
        this._recordEvent(typed);
        return;
      default: {
        // Exhaustiveness check — adding a new case to AgentEvent will cause
        // this line to fail typechecking until a branch is added above.
        const _exhaustive: never = typed;
        void _exhaustive;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Event handlers
  // ---------------------------------------------------------------------------

  /** @internal */
  async _onConversationStart(event: ConversationStartEvent): Promise<void> {
    this._recordEvent(event);
    this._activeConversations.add(event.conversationId);
  }

  /** @internal */
  async _onConversationEnd(event: ConversationEndEvent): Promise<void> {
    this._recordEvent(event);
    this._activeConversations.delete(event.conversationId);
    // Update trace status if we can find it
    const trace = this._traces.get(event.traceId);
    if (trace) {
      trace.status = event.reason === "error" ? "error" : "completed";
    }
  }

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
  async _onMessageCancel(event: MessageCancelEvent): Promise<void> {
    this._recordEvent(event);
    const trace = this._traces.get(event.traceId);
    if (trace) {
      trace.status = "completed";
      const agent = this._agents.get(trace.agentName);
      if (agent) {
        agent.lastEventAt = event.timestamp;
      }
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

        // Append to per-call log so getToolAnalytics can apply date filters.
        this._toolCallLog.push({
          toolName: event.toolName,
          agentName: trace.agentName,
          durationMs: event.durationMs,
          isError: Boolean(event.error),
          timestamp: event.timestamp,
        });
      }
    }
  }

  /** @internal */
  async _onLlmEnd(event: LLMCallEndEvent): Promise<void> {
    this._recordEvent(event);

    // Track tokens by model
    let entry = this._tokensByModel.get(event.model);
    if (!entry) {
      entry = { input: 0, output: 0, conversations: new Set() };
      this._tokensByModel.set(event.model, entry);
    }
    entry.input += event.inputTokens;
    entry.output += event.outputTokens;
    const trace = this._traces.get(event.traceId);
    if (trace) {
      entry.conversations.add(event.traceId);
    }
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

  private _getToolAnalyticsFromLog(filters: DateFilters): ToolAnalytics[] {
    const from = filters.from?.getTime();
    const to = filters.to?.getTime();
    const toolMap = new Map<
      string,
      {
        totalCalls: number;
        totalErrors: number;
        totalDurationMs: number;
        agentBreakdown: Map<string, number>;
      }
    >();

    for (const entry of this._toolCallLog.toArray()) {
      const ts = entry.timestamp.getTime();
      if (from !== undefined && ts < from) continue;
      if (to !== undefined && ts > to) continue;

      let agg = toolMap.get(entry.toolName);
      if (!agg) {
        agg = {
          totalCalls: 0,
          totalErrors: 0,
          totalDurationMs: 0,
          agentBreakdown: new Map(),
        };
        toolMap.set(entry.toolName, agg);
      }
      agg.totalCalls += 1;
      if (entry.isError) agg.totalErrors += 1;
      agg.totalDurationMs += entry.durationMs;
      agg.agentBreakdown.set(entry.agentName, (agg.agentBreakdown.get(entry.agentName) ?? 0) + 1);
    }

    const result: ToolAnalytics[] = [];
    for (const [toolName, agg] of toolMap) {
      const agentBreakdown = Array.from(agg.agentBreakdown.entries()).map(
        ([agentName, callCount]) => ({ agentName, callCount }),
      );
      result.push({
        toolName,
        totalCalls: agg.totalCalls,
        totalErrors: agg.totalErrors,
        totalDurationMs: agg.totalDurationMs,
        avgDurationMs: agg.totalCalls > 0 ? agg.totalDurationMs / agg.totalCalls : 0,
        agentBreakdown,
      });
    }
    return result;
  }
}

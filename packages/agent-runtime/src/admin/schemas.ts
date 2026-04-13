/**
 * Admin Zod schemas for dashboard and observability.
 *
 * Defines validated data shapes for agent statistics,
 * token usage, conversations, and trace data.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Token usage
// ---------------------------------------------------------------------------

export const TokenUsageRowSchema = z.object({
  timestamp: z.date(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  totalTokens: z.number(),
  model: z.string(),
  agentName: z.string(),
});
export type TokenUsageRow = z.infer<typeof TokenUsageRowSchema>;

// ---------------------------------------------------------------------------
// Tool statistics
// ---------------------------------------------------------------------------

export const ToolStatsSchema = z.object({
  toolName: z.string(),
  callCount: z.number().int().nonnegative(),
  errorCount: z.number().int().nonnegative(),
  totalDurationMs: z.number().nonnegative(),
  avgDurationMs: z.number().nonnegative(),
  lastUsed: z.date().optional(),
});
export type ToolStats = z.infer<typeof ToolStatsSchema>;

// ---------------------------------------------------------------------------
// Agent statistics
// ---------------------------------------------------------------------------

export const AgentStatsSchema = z.object({
  agentName: z.string(),
  status: z.enum(["idle", "running", "error", "completed"]),
  totalIterations: z.number().int().nonnegative(),
  totalToolCalls: z.number().int().nonnegative(),
  totalInputTokens: z.number().int().nonnegative(),
  totalOutputTokens: z.number().int().nonnegative(),
  totalErrors: z.number().int().nonnegative(),
  startedAt: z.date().optional(),
  lastEventAt: z.date().optional(),
  toolStats: z.array(ToolStatsSchema),
});
export type AgentStats = z.infer<typeof AgentStatsSchema>;

// ---------------------------------------------------------------------------
// Dashboard statistics
// ---------------------------------------------------------------------------

export const DashboardStatsSchema = z.object({
  agents: z.array(AgentStatsSchema),
  activeAgentCount: z.number().int().nonnegative(),
  totalTokensUsed: z.number().int().nonnegative(),
  totalToolCalls: z.number().int().nonnegative(),
  totalErrors: z.number().int().nonnegative(),
  activeConversationCount: z.number().int().nonnegative(),
  uptimeMs: z.number().nonnegative(),
});
export type DashboardStats = z.infer<typeof DashboardStatsSchema>;

// ---------------------------------------------------------------------------
// Conversation summary
// ---------------------------------------------------------------------------

export const ConversationSummarySchema = z.object({
  conversationId: z.string(),
  agentName: z.string(),
  messageCount: z.number().int().nonnegative(),
  tokenCount: z.number().int().nonnegative(),
  startedAt: z.date(),
  lastMessageAt: z.date().optional(),
  status: z.enum(["active", "completed", "error"]),
});
export type ConversationSummary = z.infer<typeof ConversationSummarySchema>;

// ---------------------------------------------------------------------------
// Trace events
// ---------------------------------------------------------------------------

export const TraceEventSchema = z.object({
  type: z.string(),
  timestamp: z.date(),
  spanId: z.string(),
  parentSpanId: z.string().optional(),
  data: z.record(z.unknown()),
});
export type TraceEvent = z.infer<typeof TraceEventSchema>;

// ---------------------------------------------------------------------------
// Trace iteration
// ---------------------------------------------------------------------------

export const TraceIterationSchema = z.object({
  iteration: z.number().int().nonnegative(),
  events: z.array(TraceEventSchema),
  toolCalls: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
});
export type TraceIteration = z.infer<typeof TraceIterationSchema>;

// ---------------------------------------------------------------------------
// Trace response
// ---------------------------------------------------------------------------

export const TraceResponseSchema = z.object({
  traceId: z.string(),
  agentName: z.string(),
  iterations: z.array(TraceIterationSchema),
  totalDurationMs: z.number().nonnegative(),
  status: z.enum(["running", "completed", "error"]),
});
export type TraceResponse = z.infer<typeof TraceResponseSchema>;

// ---------------------------------------------------------------------------
// Trace summary
// ---------------------------------------------------------------------------

export const TraceSummarySchema = z.object({
  traceId: z.string(),
  agentName: z.string(),
  startedAt: z.date(),
  durationMs: z.number().nonnegative().optional(),
  status: z.enum(["running", "completed", "error"]),
  iterationCount: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
});
export type TraceSummary = z.infer<typeof TraceSummarySchema>;

// ---------------------------------------------------------------------------
// Date filters
// ---------------------------------------------------------------------------

export const DateFiltersSchema = z.object({
  from: z.date().optional(),
  to: z.date().optional(),
});
export type DateFilters = z.infer<typeof DateFiltersSchema>;

// ---------------------------------------------------------------------------
// Tool analytics (cross-agent aggregation)
// ---------------------------------------------------------------------------

export const ToolAnalyticsSchema = z.object({
  toolName: z.string(),
  totalCalls: z.number().int().nonnegative(),
  totalErrors: z.number().int().nonnegative(),
  totalDurationMs: z.number().nonnegative(),
  avgDurationMs: z.number().nonnegative(),
  agentBreakdown: z.array(
    z.object({
      agentName: z.string(),
      callCount: z.number().int().nonnegative(),
    }),
  ),
});
export type ToolAnalytics = z.infer<typeof ToolAnalyticsSchema>;

// ---------------------------------------------------------------------------
// Token usage group (for groupBy queries)
// ---------------------------------------------------------------------------

export const TokenUsageGroupSchema = z.object({
  key: z.string(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  conversationCount: z.number().int().nonnegative(),
});
export type TokenUsageGroup = z.infer<typeof TokenUsageGroupSchema>;

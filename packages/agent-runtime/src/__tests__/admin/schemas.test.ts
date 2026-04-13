import { describe, expect, it } from "vitest";
import {
  AgentStatsSchema,
  ConversationSummarySchema,
  DashboardStatsSchema,
  TokenUsageRowSchema,
  ToolStatsSchema,
  TraceEventSchema,
  TraceIterationSchema,
  TraceResponseSchema,
  TraceSummarySchema,
} from "../../admin/schemas.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const now = new Date();

// ---------------------------------------------------------------------------
// TokenUsageRowSchema
// ---------------------------------------------------------------------------

describe("TokenUsageRowSchema", () => {
  it("parses valid data", () => {
    const data = {
      timestamp: now,
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      model: "gpt-4",
      agentName: "agent-1",
    };
    expect(TokenUsageRowSchema.parse(data)).toEqual(data);
  });

  it("rejects missing fields", () => {
    expect(() => TokenUsageRowSchema.parse({ timestamp: now })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// ToolStatsSchema
// ---------------------------------------------------------------------------

describe("ToolStatsSchema", () => {
  it("parses valid data", () => {
    const data = {
      toolName: "search",
      callCount: 5,
      errorCount: 1,
      totalDurationMs: 500,
      avgDurationMs: 100,
    };
    expect(ToolStatsSchema.parse(data)).toEqual(data);
  });

  it("allows optional lastUsed", () => {
    const data = {
      toolName: "search",
      callCount: 0,
      errorCount: 0,
      totalDurationMs: 0,
      avgDurationMs: 0,
      lastUsed: now,
    };
    expect(ToolStatsSchema.parse(data).lastUsed).toEqual(now);
  });

  it("rejects negative callCount", () => {
    expect(() =>
      ToolStatsSchema.parse({
        toolName: "x",
        callCount: -1,
        errorCount: 0,
        totalDurationMs: 0,
        avgDurationMs: 0,
      }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// AgentStatsSchema
// ---------------------------------------------------------------------------

describe("AgentStatsSchema", () => {
  const validAgent = {
    agentName: "agent-1",
    status: "running" as const,
    totalIterations: 3,
    totalToolCalls: 5,
    totalInputTokens: 1000,
    totalOutputTokens: 500,
    totalErrors: 0,
    toolStats: [],
  };

  it("parses valid data", () => {
    expect(AgentStatsSchema.parse(validAgent)).toEqual(validAgent);
  });

  it("allows optional startedAt and lastEventAt", () => {
    const data = { ...validAgent, startedAt: now, lastEventAt: now };
    const parsed = AgentStatsSchema.parse(data);
    expect(parsed.startedAt).toEqual(now);
    expect(parsed.lastEventAt).toEqual(now);
  });

  it("rejects invalid status", () => {
    expect(() => AgentStatsSchema.parse({ ...validAgent, status: "paused" })).toThrow();
  });

  it("accepts all valid statuses", () => {
    for (const status of ["idle", "running", "error", "completed"] as const) {
      expect(AgentStatsSchema.parse({ ...validAgent, status }).status).toBe(status);
    }
  });
});

// ---------------------------------------------------------------------------
// DashboardStatsSchema
// ---------------------------------------------------------------------------

describe("DashboardStatsSchema", () => {
  it("parses valid data", () => {
    const data = {
      agents: [],
      activeAgentCount: 0,
      totalTokensUsed: 0,
      totalToolCalls: 0,
      totalErrors: 0,
      uptimeMs: 1000,
    };
    expect(DashboardStatsSchema.parse(data)).toEqual(data);
  });

  it("rejects negative uptimeMs", () => {
    expect(() =>
      DashboardStatsSchema.parse({
        agents: [],
        activeAgentCount: 0,
        totalTokensUsed: 0,
        totalToolCalls: 0,
        totalErrors: 0,
        uptimeMs: -1,
      }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// ConversationSummarySchema
// ---------------------------------------------------------------------------

describe("ConversationSummarySchema", () => {
  const valid = {
    conversationId: "conv-1",
    agentName: "agent-1",
    messageCount: 10,
    tokenCount: 500,
    startedAt: now,
    status: "active" as const,
  };

  it("parses valid data", () => {
    expect(ConversationSummarySchema.parse(valid)).toEqual(valid);
  });

  it("allows optional lastMessageAt", () => {
    const data = { ...valid, lastMessageAt: now };
    expect(ConversationSummarySchema.parse(data).lastMessageAt).toEqual(now);
  });

  it("rejects invalid status", () => {
    expect(() => ConversationSummarySchema.parse({ ...valid, status: "paused" })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// TraceEventSchema
// ---------------------------------------------------------------------------

describe("TraceEventSchema", () => {
  it("parses valid data", () => {
    const data = {
      type: "agent.tool.start",
      timestamp: now,
      spanId: "span-1",
      data: { toolName: "search" },
    };
    expect(TraceEventSchema.parse(data)).toEqual(data);
  });

  it("allows optional parentSpanId", () => {
    const data = {
      type: "agent.tool.start",
      timestamp: now,
      spanId: "span-1",
      parentSpanId: "span-0",
      data: {},
    };
    expect(TraceEventSchema.parse(data).parentSpanId).toBe("span-0");
  });
});

// ---------------------------------------------------------------------------
// TraceIterationSchema
// ---------------------------------------------------------------------------

describe("TraceIterationSchema", () => {
  it("parses valid data", () => {
    const data = {
      iteration: 0,
      events: [],
      toolCalls: 0,
      inputTokens: 100,
      outputTokens: 50,
    };
    expect(TraceIterationSchema.parse(data)).toEqual(data);
  });

  it("rejects negative iteration", () => {
    expect(() =>
      TraceIterationSchema.parse({
        iteration: -1,
        events: [],
        toolCalls: 0,
        inputTokens: 0,
        outputTokens: 0,
      }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// TraceResponseSchema
// ---------------------------------------------------------------------------

describe("TraceResponseSchema", () => {
  it("parses valid data", () => {
    const data = {
      traceId: "trace-1",
      agentName: "agent-1",
      iterations: [],
      totalDurationMs: 1500,
      status: "completed" as const,
    };
    expect(TraceResponseSchema.parse(data)).toEqual(data);
  });

  it("rejects invalid status", () => {
    expect(() =>
      TraceResponseSchema.parse({
        traceId: "trace-1",
        agentName: "agent-1",
        iterations: [],
        totalDurationMs: 0,
        status: "pending",
      }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// TraceSummarySchema
// ---------------------------------------------------------------------------

describe("TraceSummarySchema", () => {
  const valid = {
    traceId: "trace-1",
    agentName: "agent-1",
    startedAt: now,
    status: "running" as const,
    iterationCount: 3,
    totalTokens: 500,
  };

  it("parses valid data", () => {
    expect(TraceSummarySchema.parse(valid)).toEqual(valid);
  });

  it("allows optional durationMs", () => {
    const data = { ...valid, durationMs: 2000 };
    expect(TraceSummarySchema.parse(data).durationMs).toBe(2000);
  });

  it("rejects negative totalTokens", () => {
    expect(() => TraceSummarySchema.parse({ ...valid, totalTokens: -1 })).toThrow();
  });
});

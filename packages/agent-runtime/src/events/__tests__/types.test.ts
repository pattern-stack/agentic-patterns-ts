import { describe, expect, it } from "vitest";
import { createEvent } from "../types.js";
import type { AgentEvent } from "../types.js";

describe("Core Event Types", () => {
  describe("createEvent", () => {
    it("creates a MessageStartEvent with auto-filled fields", () => {
      const event = createEvent("agent.message.start", {
        traceId: "trace-1",
        runId: "run-1",
        agentName: "TestAgent",
      });

      expect(event.type).toBe("agent.message.start");
      expect(event.traceId).toBe("trace-1");
      expect(event.runId).toBe("run-1");
      expect(event.agentName).toBe("TestAgent");
      expect(event.timestamp).toBeInstanceOf(Date);
      expect(event.spanId).toBeDefined();
      expect(event.spanId.length).toBeGreaterThan(0);
    });

    it("uses provided spanId when given", () => {
      const event = createEvent("agent.message.start", {
        traceId: "trace-1",
        runId: "run-1",
        agentName: "Test",
        spanId: "custom-span",
      });

      expect(event.spanId).toBe("custom-span");
    });

    it("creates a ToolCallIntent event", () => {
      const event = createEvent("agent.tool.intent", {
        traceId: "trace-1",
        runId: "run-1",
        toolCallId: "tc-1",
        toolName: "read_file",
        arguments: { path: "/tmp/test" },
      });

      expect(event.type).toBe("agent.tool.intent");
      expect(event.toolName).toBe("read_file");
      expect(event.arguments).toEqual({ path: "/tmp/test" });
    });

    it("creates an ErrorEvent", () => {
      const event = createEvent("agent.error", {
        traceId: "trace-1",
        runId: "run-1",
        errorType: "ValueError",
        message: "Something went wrong",
        recoverable: false,
        context: { key: "value" },
      });

      expect(event.type).toBe("agent.error");
      expect(event.errorType).toBe("ValueError");
      expect(event.recoverable).toBe(false);
    });
  });

  describe("memory events (#420)", () => {
    it("creates a MemoryWriteEvent with per-record previews", () => {
      const event = createEvent("agent.memory.write", {
        traceId: "trace-1",
        runId: "run-1",
        scope: { userId: "u1" },
        count: 2,
        records: [
          { id: "m1", kind: "fact", preview: "the sky is blue" },
          { id: "m2", kind: "preference", preview: "prefers dark mode", supersededId: "m0" },
        ],
        toolCallId: "tc-1",
      });

      expect(event.type).toBe("agent.memory.write");
      expect(event.timestamp).toBeInstanceOf(Date);
      expect(event.spanId.length).toBeGreaterThan(0);
      expect(event.scope).toEqual({ userId: "u1" });
      expect(event.count).toBe(2);
      expect(event.records).toHaveLength(2);
      expect(event.records[0]?.supersededId).toBeUndefined();
      expect(event.records[1]?.supersededId).toBe("m0");
      expect(event.toolCallId).toBe("tc-1");
    });

    it("creates a MemorySearchEvent with the full filter set", () => {
      const event = createEvent("agent.memory.search", {
        traceId: "trace-1",
        runId: "run-1",
        scope: { userId: "u1" },
        query: "dark mode",
        kinds: ["preference"],
        tags: ["ui"],
        limit: 5,
        includeInvalidated: false,
        resultCount: 1,
        resultIds: ["m2"],
        toolCallId: "tc-2",
      });

      expect(event.type).toBe("agent.memory.search");
      expect(event.query).toBe("dark mode");
      expect(event.kinds).toEqual(["preference"]);
      expect(event.tags).toEqual(["ui"]);
      expect(event.limit).toBe(5);
      expect(event.includeInvalidated).toBe(false);
      expect(event.resultCount).toBe(1);
      expect(event.resultIds).toEqual(["m2"]);
    });

    it("creates a MemorySearchEvent without the optional filters (recency listing)", () => {
      const event = createEvent("agent.memory.search", {
        traceId: "trace-1",
        runId: "run-1",
        scope: { userId: "u1" },
        limit: 10,
        includeInvalidated: true,
        resultCount: 0,
        resultIds: [],
      });

      expect(event.type).toBe("agent.memory.search");
      expect(event.query).toBeUndefined();
      expect(event.kinds).toBeUndefined();
      expect(event.tags).toBeUndefined();
      expect(event.toolCallId).toBeUndefined();
      expect(event.timestamp).toBeInstanceOf(Date);
    });

    it("creates a MemoryRecallEvent with the pinned {count, chars, truncated} trio", () => {
      const event = createEvent("agent.memory.recall", {
        traceId: "trace-1",
        runId: "run-1",
        scope: { userId: "u1" },
        count: 3,
        chars: 1800,
        budgetChars: 2000,
        truncated: true,
        preview: "## Memory\n- the sky is blue… (preview only)",
      });

      expect(event.type).toBe("agent.memory.recall");
      expect(event.count).toBe(3);
      expect(event.chars).toBe(1800);
      expect(event.truncated).toBe(true);
      expect(event.budgetChars).toBe(2000);
      expect(event.preview).toContain("(preview only)");
    });
  });

  describe("Discriminated union", () => {
    it("narrows correctly in switch statements", () => {
      const event: AgentEvent = createEvent("agent.message.complete", {
        traceId: "t",
        runId: "r",
        content: "Hello",
        inputTokens: 10,
        outputTokens: 5,
        model: "claude-3",
      });

      let content = "";
      switch (event.type) {
        case "agent.message.complete":
          // TypeScript should narrow this to MessageCompleteEvent
          content = event.content;
          break;
      }

      expect(content).toBe("Hello");
    });

    it("narrows tool events correctly", () => {
      const event: AgentEvent = createEvent("agent.tool.end", {
        traceId: "t",
        runId: "r",
        toolCallId: "tc-1",
        toolName: "search",
        arguments: {},
        result: "found it",
        durationMs: 100,
        resultTokens: 50,
      });

      if (event.type === "agent.tool.end") {
        expect(event.result).toBe("found it");
        expect(event.durationMs).toBe(100);
      }
    });
  });
});

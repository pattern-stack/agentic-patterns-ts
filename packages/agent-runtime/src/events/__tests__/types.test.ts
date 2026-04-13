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

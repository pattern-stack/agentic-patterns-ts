import { describe, expect, it } from "vitest";
import { EventBus } from "../event-bus.js";
import { EventProfile, PROFILE_EVENT_TYPES, subscribeProfile } from "../event-profiles.js";
import { createEvent } from "../types.js";
import type { AgentEvent } from "../types.js";

describe("B0: New Event Types", () => {
  describe("ConversationStartEvent", () => {
    it("creates a conversation.start event", () => {
      const event = createEvent("agent.conversation.start", {
        traceId: "trace-1",
        runId: "run-1",
        conversationId: "conv-123",
        agentName: "TestAgent",
      });

      expect(event.type).toBe("agent.conversation.start");
      expect(event.conversationId).toBe("conv-123");
      expect(event.agentName).toBe("TestAgent");
      expect(event.timestamp).toBeInstanceOf(Date);
      expect(event.spanId).toBeDefined();
    });

    it("narrows correctly in switch", () => {
      const event: AgentEvent = createEvent("agent.conversation.start", {
        traceId: "t",
        runId: "r",
        conversationId: "c1",
        agentName: "Agent1",
      });

      let convId = "";
      if (event.type === "agent.conversation.start") {
        convId = event.conversationId;
      }
      expect(convId).toBe("c1");
    });
  });

  describe("ConversationEndEvent", () => {
    it("creates a conversation.end event with reason", () => {
      const event = createEvent("agent.conversation.end", {
        traceId: "trace-1",
        runId: "run-1",
        conversationId: "conv-123",
        reason: "completed",
      });

      expect(event.type).toBe("agent.conversation.end");
      expect(event.conversationId).toBe("conv-123");
      expect(event.reason).toBe("completed");
    });

    it("supports different completion reasons", () => {
      const completed = createEvent("agent.conversation.end", {
        traceId: "t",
        runId: "r",
        conversationId: "c1",
        reason: "completed",
      });

      const errored = createEvent("agent.conversation.end", {
        traceId: "t",
        runId: "r",
        conversationId: "c2",
        reason: "error",
      });

      const cancelled = createEvent("agent.conversation.end", {
        traceId: "t",
        runId: "r",
        conversationId: "c3",
        reason: "cancelled",
      });

      expect(completed.reason).toBe("completed");
      expect(errored.reason).toBe("error");
      expect(cancelled.reason).toBe("cancelled");
    });
  });

  describe("MessageCancelEvent", () => {
    it("creates a message.cancel event without reason", () => {
      const event = createEvent("agent.message.cancel", {
        traceId: "trace-1",
        runId: "run-1",
      });

      expect(event.type).toBe("agent.message.cancel");
      expect(event.reason).toBeUndefined();
    });

    it("creates a message.cancel event with optional reason", () => {
      const event = createEvent("agent.message.cancel", {
        traceId: "trace-1",
        runId: "run-1",
        reason: "user_interrupted",
      });

      expect(event.type).toBe("agent.message.cancel");
      expect(event.reason).toBe("user_interrupted");
    });
  });

  describe("ThinkingStartEvent", () => {
    it("creates a thinking.start event", () => {
      const event = createEvent("agent.thinking.start", {
        traceId: "trace-1",
        runId: "run-1",
      });

      expect(event.type).toBe("agent.thinking.start");
      expect(event.timestamp).toBeInstanceOf(Date);
      expect(event.spanId).toBeDefined();
    });

    it("narrows correctly in conditional", () => {
      const event: AgentEvent = createEvent("agent.thinking.start", {
        traceId: "t",
        runId: "r",
      });

      let isThinking = false;
      if (event.type === "agent.thinking.start") {
        isThinking = true;
      }
      expect(isThinking).toBe(true);
    });
  });

  describe("ToolProgressEvent", () => {
    it("creates a tool.progress event with all fields", () => {
      const event = createEvent("agent.tool.progress", {
        traceId: "trace-1",
        runId: "run-1",
        toolCallId: "tc-1",
        progress: 3,
        statusText: "Processing file 3 of 10",
      });

      expect(event.type).toBe("agent.tool.progress");
      expect(event.toolCallId).toBe("tc-1");
      expect(event.progress).toBe(3);
      expect(event.statusText).toBe("Processing file 3 of 10");
    });

    it("creates tool.progress with only toolCallId", () => {
      const event = createEvent("agent.tool.progress", {
        traceId: "trace-1",
        runId: "run-1",
        toolCallId: "tc-1",
      });

      expect(event.type).toBe("agent.tool.progress");
      expect(event.toolCallId).toBe("tc-1");
      expect(event.progress).toBeUndefined();
      expect(event.statusText).toBeUndefined();
    });

    it("supports progress without statusText", () => {
      const event = createEvent("agent.tool.progress", {
        traceId: "trace-1",
        runId: "run-1",
        toolCallId: "tc-1",
        progress: 50,
      });

      expect(event.progress).toBe(50);
      expect(event.statusText).toBeUndefined();
    });
  });

  describe("Profile mappings", () => {
    it("UX profile includes conversation events", () => {
      const types = PROFILE_EVENT_TYPES[EventProfile.UX];
      expect(types).toContain("agent.conversation.start");
      expect(types).toContain("agent.conversation.end");
    });

    it("UX profile includes message cancel", () => {
      const types = PROFILE_EVENT_TYPES[EventProfile.UX];
      expect(types).toContain("agent.message.cancel");
    });

    it("UX profile includes thinking.start", () => {
      const types = PROFILE_EVENT_TYPES[EventProfile.UX];
      expect(types).toContain("agent.thinking.start");
    });

    it("UX profile includes tool.progress", () => {
      const types = PROFILE_EVENT_TYPES[EventProfile.UX];
      expect(types).toContain("agent.tool.progress");
    });

    it("OBSERVABILITY profile includes conversation events", () => {
      const types = PROFILE_EVENT_TYPES[EventProfile.OBSERVABILITY];
      expect(types).toContain("agent.conversation.start");
      expect(types).toContain("agent.conversation.end");
    });

    it("OBSERVABILITY profile includes thinking.start", () => {
      const types = PROFILE_EVENT_TYPES[EventProfile.OBSERVABILITY];
      expect(types).toContain("agent.thinking.start");
    });

    it("OBSERVABILITY profile includes tool.progress", () => {
      const types = PROFILE_EVENT_TYPES[EventProfile.OBSERVABILITY];
      expect(types).toContain("agent.tool.progress");
    });

    it("OBSERVABILITY excludes message.cancel", () => {
      const types = PROFILE_EVENT_TYPES[EventProfile.OBSERVABILITY];
      expect(types).not.toContain("agent.message.cancel");
    });
  });

  describe("Profile subscription", () => {
    it("UX profile can subscribe to all new events", async () => {
      const bus = new EventBus();
      const handler = vi.fn();
      const types = subscribeProfile(bus, EventProfile.UX, handler);

      // Check that new events are included
      expect(types).toContain("agent.conversation.start");
      expect(types).toContain("agent.conversation.end");
      expect(types).toContain("agent.message.cancel");
      expect(types).toContain("agent.thinking.start");
      expect(types).toContain("agent.tool.progress");
    });
  });
});

// Import vi from vitest if not already
import { vi } from "vitest";

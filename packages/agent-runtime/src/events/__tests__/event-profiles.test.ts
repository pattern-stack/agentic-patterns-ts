import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventBus } from "../event-bus.js";
import {
  EventProfile,
  PROFILE_EVENT_TYPES,
  subscribeProfile,
  subscribeProfiles,
  unsubscribeProfile,
} from "../event-profiles.js";
import type { BaseEvent } from "../types.js";

function makeEvent(type: string): BaseEvent {
  return {
    type,
    traceId: "t",
    runId: "r",
    spanId: "s",
    timestamp: new Date(),
  };
}

describe("Event Profiles", () => {
  let bus: EventBus;

  beforeEach(() => {
    bus = new EventBus();
  });

  describe("PROFILE_EVENT_TYPES", () => {
    it("UX profile includes all UI-relevant events", () => {
      const types = PROFILE_EVENT_TYPES[EventProfile.UX];
      expect(types).toContain("agent.message.start");
      expect(types).toContain("agent.message.chunk");
      expect(types).toContain("agent.message.complete");
      expect(types).toContain("agent.tool.intent");
      expect(types).toContain("agent.error");
    });

    it("UX profile includes step + state-delta events (#226)", () => {
      // Profile-attached exporters (admin collector, SSE broadcast, SQLite)
      // only see events listed in their profile — before #226, step.start/end
      // were in NO profile and the state-delta events did not exist.
      const types = PROFILE_EVENT_TYPES[EventProfile.UX];
      expect(types).toContain("agent.step.start");
      expect(types).toContain("agent.step.end");
      for (const stateType of [
        "agent.backpack.drop",
        "agent.backpack.read",
        "agent.backpack.absorb",
        "agent.scratchpad.write",
        "agent.scratchpad.read",
        "agent.scratchpad.fork",
        "agent.scratchpad.join",
      ]) {
        expect(types).toContain(stateType);
      }
    });

    it("OBSERVABILITY profile excludes chunks", () => {
      const types = PROFILE_EVENT_TYPES[EventProfile.OBSERVABILITY];
      expect(types).not.toContain("agent.message.chunk");
      expect(types).toContain("agent.message.complete");
    });

    it("OBSERVABILITY profile includes memory events (#420) — and UX does not", () => {
      const obs = PROFILE_EVENT_TYPES[EventProfile.OBSERVABILITY];
      const ux = PROFILE_EVENT_TYPES[EventProfile.UX];
      for (const memoryType of [
        "agent.memory.write",
        "agent.memory.search",
        "agent.memory.recall",
      ]) {
        expect(obs).toContain(memoryType);
        // Pins the OBSERVABILITY-only decision — a dashboard memory lens (UX)
        // is ADR-0007 future work, not #420.
        expect(ux).not.toContain(memoryType);
      }
    });

    it("TOOLS profile includes only tool events", () => {
      const types = PROFILE_EVENT_TYPES[EventProfile.TOOLS];
      expect(types).toHaveLength(5);
      expect(types).toContain("agent.tool.intent");
      expect(types).toContain("agent.tool.rejected");
      expect(types).toContain("agent.tool.start");
      expect(types).toContain("agent.tool.end");
      expect(types).toContain("agent.tool.progress");
    });

    it("STREAMING profile includes only chunks", () => {
      const types = PROFILE_EVENT_TYPES[EventProfile.STREAMING];
      expect(types).toHaveLength(1);
      expect(types).toContain("agent.message.chunk");
    });
  });

  describe("subscribeProfile", () => {
    it("subscribes handler to all events in profile", async () => {
      const handler = vi.fn();
      const types = subscribeProfile(bus, EventProfile.TOOLS, handler);

      expect(types).toHaveLength(5);

      await bus.publish(makeEvent("agent.tool.start"));
      expect(handler).toHaveBeenCalledOnce();

      await bus.publish(makeEvent("agent.message.start"));
      expect(handler).toHaveBeenCalledOnce(); // Not called again
    });

    it("returns subscribed event types", () => {
      const handler = vi.fn();
      const types = subscribeProfile(bus, EventProfile.STREAMING, handler);

      expect(types).toEqual(["agent.message.chunk"]);
    });
  });

  describe("unsubscribeProfile", () => {
    it("removes handler from all profile events", async () => {
      const handler = vi.fn();
      subscribeProfile(bus, EventProfile.TOOLS, handler);
      unsubscribeProfile(bus, EventProfile.TOOLS, handler);

      await bus.publish(makeEvent("agent.tool.start"));
      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe("subscribeProfiles", () => {
    it("deduplicates event types across profiles", () => {
      const handler = vi.fn();
      const types = subscribeProfiles(bus, [EventProfile.TOOLS, EventProfile.STREAMING], handler);

      // TOOLS has 5 types, STREAMING has 1, no overlap
      expect(types).toHaveLength(6);
    });

    it("subscribes to UX and OBS without duplicates", async () => {
      const handler = vi.fn();
      subscribeProfiles(bus, [EventProfile.UX, EventProfile.OBSERVABILITY], handler);

      // Both profiles share many types, but deduplication means
      // publishing one event should call handler once
      await bus.publish(makeEvent("agent.error"));
      expect(handler).toHaveBeenCalledOnce();
    });
  });
});

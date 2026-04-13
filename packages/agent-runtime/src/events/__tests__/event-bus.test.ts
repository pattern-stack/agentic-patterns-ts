import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventBus } from "../event-bus.js";
import type { BaseEvent } from "../types.js";

function makeEvent(type: string): BaseEvent {
  return {
    type,
    traceId: "trace-1",
    runId: "run-1",
    spanId: "span-1",
    timestamp: new Date(),
  };
}

describe("EventBus", () => {
  let bus: EventBus;

  beforeEach(() => {
    bus = new EventBus();
  });

  describe("subscribe and publish", () => {
    it("delivers event to subscribed handler", async () => {
      const handler = vi.fn();
      bus.subscribe("agent.message.start", handler);

      await bus.publish(makeEvent("agent.message.start"));

      expect(handler).toHaveBeenCalledOnce();
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ type: "agent.message.start" }),
      );
    });

    it("does not deliver to handlers of different type", async () => {
      const handler = vi.fn();
      bus.subscribe("agent.message.start", handler);

      await bus.publish(makeEvent("agent.tool.start"));

      expect(handler).not.toHaveBeenCalled();
    });

    it("delivers to multiple handlers", async () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();
      bus.subscribe("agent.error", handler1);
      bus.subscribe("agent.error", handler2);

      await bus.publish(makeEvent("agent.error"));

      expect(handler1).toHaveBeenCalledOnce();
      expect(handler2).toHaveBeenCalledOnce();
    });

    it("collects handler return values", async () => {
      bus.subscribe("agent.error", () => "result-a");
      bus.subscribe("agent.error", () => "result-b");

      const results = await bus.publish(makeEvent("agent.error"));

      expect(results).toHaveLength(2);
      expect(results).toContain("result-a");
      expect(results).toContain("result-b");
    });
  });

  describe("priority ordering", () => {
    it("executes higher priority handlers first", async () => {
      const order: number[] = [];

      bus.subscribe(
        "test",
        () => {
          order.push(1);
        },
        1,
      );
      bus.subscribe(
        "test",
        () => {
          order.push(10);
        },
        10,
      );
      bus.subscribe(
        "test",
        () => {
          order.push(5);
        },
        5,
      );

      await bus.publish(makeEvent("test"));

      expect(order).toEqual([10, 5, 1]);
    });
  });

  describe("subscribeAll", () => {
    it("receives all event types", async () => {
      const handler = vi.fn();
      bus.subscribeAll(handler);

      await bus.publish(makeEvent("agent.message.start"));
      await bus.publish(makeEvent("agent.tool.start"));

      expect(handler).toHaveBeenCalledTimes(2);
    });
  });

  describe("unsubscribe", () => {
    it("removes specific handler", async () => {
      const handler = vi.fn();
      bus.subscribe("test", handler);
      bus.unsubscribe("test", handler);

      await bus.publish(makeEvent("test"));

      expect(handler).not.toHaveBeenCalled();
    });

    it("removes global handler", async () => {
      const handler = vi.fn();
      bus.subscribeAll(handler);
      bus.unsubscribeAll(handler);

      await bus.publish(makeEvent("test"));

      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe("middleware", () => {
    it("transforms events", async () => {
      const handler = vi.fn();
      bus.subscribe("agent.modified", handler);

      bus.addMiddleware((event) => ({
        ...event,
        type: "agent.modified",
      }));

      await bus.publish(makeEvent("agent.original"));

      expect(handler).toHaveBeenCalledOnce();
    });

    it("drops events when returning null", async () => {
      const handler = vi.fn();
      bus.subscribe("test", handler);

      bus.addMiddleware(() => null);

      const results = await bus.publish(makeEvent("test"));

      expect(handler).not.toHaveBeenCalled();
      expect(results).toEqual([]);
    });

    it("chains multiple middleware", async () => {
      const handler = vi.fn();
      bus.subscribeAll(handler);

      bus.addMiddleware((event) => ({
        ...event,
        type: `${event.type}.a`,
      }));
      bus.addMiddleware((event) => ({
        ...event,
        type: `${event.type}.b`,
      }));

      await bus.publish(makeEvent("test"));

      expect(handler).toHaveBeenCalledWith(expect.objectContaining({ type: "test.a.b" }));
    });
  });

  describe("async handlers", () => {
    it("awaits async handlers", async () => {
      const handler = vi.fn(async () => {
        return "async-result";
      });
      bus.subscribe("test", handler);

      const results = await bus.publish(makeEvent("test"));

      expect(results).toEqual(["async-result"]);
    });
  });

  describe("error handling", () => {
    it("continues executing other handlers on error", async () => {
      const handler1 = vi.fn(() => {
        throw new Error("fail");
      });
      const handler2 = vi.fn(() => "ok");

      bus.subscribe("test", handler1);
      bus.subscribe("test", handler2);

      const results = await bus.publish(makeEvent("test"));

      // handler1 threw, but handler2 still ran
      expect(handler2).toHaveBeenCalledOnce();
      expect(results).toContain("ok");
    });
  });

  describe("getHandlerCount", () => {
    it("returns count for specific event type", () => {
      bus.subscribe("a", vi.fn());
      bus.subscribe("a", vi.fn());
      bus.subscribe("b", vi.fn());

      expect(bus.getHandlerCount("a")).toBe(2);
      expect(bus.getHandlerCount("b")).toBe(1);
      expect(bus.getHandlerCount("c")).toBe(0);
    });

    it("returns total count", () => {
      bus.subscribe("a", vi.fn());
      bus.subscribe("b", vi.fn());
      bus.subscribeAll(vi.fn());

      expect(bus.getHandlerCount()).toBe(3);
    });
  });

  describe("clear", () => {
    it("removes all handlers and middleware", async () => {
      bus.subscribe("test", vi.fn());
      bus.subscribeAll(vi.fn());
      bus.addMiddleware(() => null);

      bus.clear();

      expect(bus.getHandlerCount()).toBe(0);
      // Middleware cleared too - events should propagate normally
      const handler = vi.fn();
      bus.subscribe("test", handler);
      await bus.publish(makeEvent("test"));
      expect(handler).toHaveBeenCalledOnce();
    });
  });
});

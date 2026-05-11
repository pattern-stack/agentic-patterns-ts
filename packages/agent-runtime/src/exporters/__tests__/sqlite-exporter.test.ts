/**
 * SQLiteExporter integration test — attach the exporter to a real bus, publish
 * a few events, verify they land in the store and that exceptions don't break
 * the bus.
 */

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentEventBus } from "../../events/agent-event-bus.js";
import type { BaseEvent } from "../../events/types.js";
import { EventStore } from "../../storage/event-store.js";
import { SQLiteExporter } from "../sqlite.js";

function mkEvent(overrides: Partial<BaseEvent> & Record<string, unknown> = {}): BaseEvent {
  return {
    type: "agent.message.start",
    traceId: "t",
    runId: "r",
    spanId: `span-${Math.random().toString(36).slice(2)}`,
    timestamp: new Date(),
    ...overrides,
  } as BaseEvent;
}

describe("SQLiteExporter", () => {
  let store: EventStore;
  let bus: AgentEventBus;
  let exporter: SQLiteExporter;

  beforeEach(() => {
    store = new EventStore({ path: ":memory:", Database });
    bus = new AgentEventBus();
    exporter = new SQLiteExporter({ store });
    exporter.attach(bus);
  });

  afterEach(() => {
    exporter.detach(bus);
    store.close();
  });

  it("persists UX-profile events published on the bus", async () => {
    await bus.publish(mkEvent({ type: "agent.message.start" }));
    await bus.publish(mkEvent({ type: "agent.tool.end" }));
    await bus.publish(
      mkEvent({
        type: "claude_code.hook",
        sessionId: "s1",
        hookName: "PreToolUse",
      } as unknown as Partial<BaseEvent>),
    );

    expect(store.count()).toBe(3);
    const types = store.recent({ limit: 10 }).map((e) => e.type);
    expect(types).toContain("agent.message.start");
    expect(types).toContain("agent.tool.end");
    expect(types).toContain("claude_code.hook");
  });

  it("does not throw if the store rejects a write — bus stays healthy", async () => {
    const failing: typeof store = {
      append: vi.fn(() => {
        throw new Error("disk full");
      }),
      // unused but typed
      recent: vi.fn(() => []),
      sessionEvents: vi.fn(() => []),
      sessions: vi.fn(() => []),
      purgeOlderThanDays: vi.fn(() => 0),
      purgeBeyondCap: vi.fn(() => 0),
      count: vi.fn(() => 0),
      close: vi.fn(),
    } as unknown as EventStore;

    const onError = vi.fn();
    const e2 = new SQLiteExporter({ store: failing, onError });
    e2.attach(bus);

    await expect(bus.publish(mkEvent())).resolves.toBeDefined();

    expect(onError).toHaveBeenCalledTimes(1);
    e2.detach(bus);
  });

  it("ignores events outside the UX profile", async () => {
    // agent.compaction.start is on DEBUG-only flows; pick something definitely
    // not on UX. Use a synthetic type that no profile lists.
    await bus.publish(mkEvent({ type: "agent.never_emitted_for_real" }));
    expect(store.count()).toBe(0);
  });
});

/**
 * EventStore unit tests. Uses an in-memory SQLite database so the suite
 * does not touch the filesystem.
 */

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BaseEvent } from "../../events/types.js";
import { EventStore } from "../event-store.js";

function mkEvent(overrides: Record<string, unknown> = {}): BaseEvent {
  return {
    type: "agent.message.start",
    traceId: "trace-1",
    runId: "run-1",
    spanId: "span-1",
    timestamp: new Date("2026-05-11T18:00:00Z"),
    ...overrides,
  } as BaseEvent;
}

function mkClaudeCodeHook(
  sessionId: string,
  hookName: string,
  overrides: Record<string, unknown> = {},
): BaseEvent {
  return mkEvent({
    type: "claude_code.hook",
    traceId: sessionId,
    runId: sessionId,
    sessionId,
    hookName,
    cwd: "/tmp/proj",
    payload: { session_id: sessionId, hook_event_name: hookName, cwd: "/tmp/proj" },
    ...overrides,
  });
}

describe("EventStore", () => {
  let store: EventStore;

  beforeEach(() => {
    store = new EventStore({ path: ":memory:", Database });
  });

  afterEach(() => {
    store.close();
  });

  it("appends and reads back events", () => {
    store.append(mkEvent({ spanId: "span-a" }));
    store.append(mkEvent({ spanId: "span-b", type: "agent.message.complete" }));

    expect(store.count()).toBe(2);
    const recent = store.recent({ limit: 10 });
    expect(recent).toHaveLength(2);
    expect(recent.map((r) => r.spanId).sort()).toEqual(["span-a", "span-b"]);
  });

  it("filters recent by type", () => {
    store.append(mkEvent({ type: "agent.message.start" }));
    store.append(mkEvent({ type: "agent.message.complete", spanId: "s2" }));
    store.append(mkEvent({ type: "agent.tool.start", spanId: "s3" }));

    const tools = store.recent({ type: "agent.tool.start" });
    expect(tools).toHaveLength(1);
    expect(tools[0]?.type).toBe("agent.tool.start");
  });

  it("filters recent by since", () => {
    const t1 = new Date("2026-05-11T18:00:00Z");
    const t2 = new Date("2026-05-11T19:00:00Z");
    store.append(mkEvent({ timestamp: t1, spanId: "old" }));
    store.append(mkEvent({ timestamp: t2, spanId: "new" }));

    const recent = store.recent({ since: new Date("2026-05-11T18:30:00Z") });
    expect(recent.map((r) => r.spanId)).toEqual(["new"]);
  });

  it("returns all events for a trace, ASC by timestamp", () => {
    const t1 = new Date("2026-05-11T18:00:00Z");
    const t2 = new Date("2026-05-11T18:00:01Z");
    const t3 = new Date("2026-05-11T18:00:02Z");
    store.append(mkEvent({ traceId: "trace-A", spanId: "a-1", timestamp: t1 }));
    store.append(
      mkEvent({ traceId: "trace-A", spanId: "a-2", type: "agent.tool.start", timestamp: t2 }),
    );
    store.append(mkEvent({ traceId: "trace-B", spanId: "b-1", timestamp: t3 }));

    const traceA = store.eventsForTrace("trace-A");
    expect(traceA.map((e) => e.spanId)).toEqual(["a-1", "a-2"]);
    expect(traceA.every((e) => e.traceId === "trace-A")).toBe(true);
  });

  it("returns an empty array for an unknown trace", () => {
    store.append(mkEvent({ traceId: "trace-A" }));
    expect(store.eventsForTrace("does-not-exist")).toEqual([]);
  });

  it("denormalizes Claude Code hook fields", () => {
    store.append(mkClaudeCodeHook("sess-A", "SessionStart"));
    store.append(mkClaudeCodeHook("sess-A", "PreToolUse"));
    store.append(mkClaudeCodeHook("sess-B", "SessionStart"));

    const sessA = store.sessionEvents("sess-A");
    expect(sessA).toHaveLength(2);
    expect(sessA.every((e) => e.ccSessionId === "sess-A")).toBe(true);
    expect(sessA.map((e) => e.ccHookName).sort()).toEqual(["PreToolUse", "SessionStart"]);

    const sessB = store.sessionEvents("sess-B");
    expect(sessB).toHaveLength(1);
  });

  it("aggregates session list", () => {
    const t1 = new Date("2026-05-11T18:00:00Z");
    const t2 = new Date("2026-05-11T18:05:00Z");
    const t3 = new Date("2026-05-11T18:10:00Z");

    store.append(mkClaudeCodeHook("sess-old", "SessionStart", { timestamp: t1 }));
    store.append(mkClaudeCodeHook("sess-old", "Stop", { timestamp: t2 }));
    store.append(mkClaudeCodeHook("sess-new", "SessionStart", { timestamp: t3 }));

    const list = store.sessions(10);
    expect(list).toHaveLength(2);
    const [first, second] = list;
    expect(first?.sessionId).toBe("sess-new");
    expect(first?.eventCount).toBe(1);
    expect(second?.sessionId).toBe("sess-old");
    expect(second?.eventCount).toBe(2);
    if (second) {
      expect(second.firstSeen <= second.lastSeen).toBe(true);
    }
  });

  it("ignores non-CC events in the session aggregator", () => {
    store.append(mkClaudeCodeHook("cc-1", "SessionStart"));
    store.append(mkEvent({ type: "agent.message.start" }));
    expect(store.sessions(10)).toHaveLength(1);
  });

  it("purges events older than N days", () => {
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    const fresh = new Date();
    store.append(mkEvent({ timestamp: old, spanId: "old" }));
    store.append(mkEvent({ timestamp: fresh, spanId: "fresh" }));

    const removed = store.purgeOlderThanDays(30);
    expect(removed).toBe(1);
    expect(store.count()).toBe(1);
    const recent = store.recent({ limit: 10 });
    expect(recent[0]?.spanId).toBe("fresh");
  });

  it("purges beyond row cap", () => {
    for (let i = 0; i < 10; i++) {
      store.append(mkEvent({ spanId: `s${i}` }));
    }
    const removed = store.purgeBeyondCap(4);
    expect(removed).toBe(6);
    expect(store.count()).toBe(4);
  });

  it("survives reopen on the same path", () => {
    const fs = require("node:fs") as typeof import("node:fs");
    const os = require("node:os") as typeof import("node:os");
    const path = require("node:path") as typeof import("node:path");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "evstore-"));
    const dbPath = path.join(dir, "events.db");

    const s1 = new EventStore({ path: dbPath, Database });
    s1.append(mkClaudeCodeHook("persist-test", "SessionStart"));
    s1.close();

    const s2 = new EventStore({ path: dbPath, Database });
    expect(s2.count()).toBe(1);
    const sessions = s2.sessions(10);
    expect(sessions[0]?.sessionId).toBe("persist-test");
    s2.close();

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("applies retention at construction when configured", () => {
    const fs = require("node:fs") as typeof import("node:fs");
    const os = require("node:os") as typeof import("node:os");
    const path = require("node:path") as typeof import("node:path");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "evstore-ret-"));
    const dbPath = path.join(dir, "events.db");

    const s1 = new EventStore({ path: dbPath, Database });
    s1.append(
      mkEvent({
        spanId: "old",
        timestamp: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000),
      }),
    );
    // Explicit fresh timestamp — mkEvent's frozen default (2026-05-11) rots out
    // of the 30-day window over time (date-rot caught 2026-06-12).
    s1.append(mkEvent({ spanId: "fresh", timestamp: new Date() }));
    s1.close();

    const s2 = new EventStore({ path: dbPath, Database, retentionDays: 30 });
    expect(s2.count()).toBe(1);
    s2.close();

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("serializes Date fields as ISO strings in the JSON payload", () => {
    const now = new Date("2026-05-11T20:00:00Z");
    store.append(mkEvent({ timestamp: now }));
    const rows = store.recent({ limit: 1 });
    expect(rows[0]?.data.timestamp).toBe(now.toISOString());
  });
});

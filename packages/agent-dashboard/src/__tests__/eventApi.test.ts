/**
 * fetchRecentEvents — REST hydration helper used by the Claude Code page on
 * first paint. Tests the happy path, the 503-when-no-store fallback, and the
 * server's DESC → ASC reversal.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchRecentEvents, fetchTraceEvents } from "../lib/eventApi";

const originalFetch = globalThis.fetch;

describe("fetchRecentEvents", () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("maps PersistedEvent rows to StreamEvent shape, ASC by arrival", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      mkResponse(200, {
        events: [
          // Server returns DESC, oldest last
          { id: 3, type: "claude_code.hook", timestamp: "2026-05-11T18:02:00Z", data: { x: 3 } },
          { id: 2, type: "claude_code.hook", timestamp: "2026-05-11T18:01:00Z", data: { x: 2 } },
          { id: 1, type: "claude_code.hook", timestamp: "2026-05-11T18:00:00Z", data: { x: 1 } },
        ],
      }),
    );

    const result = await fetchRecentEvents({ type: "claude_code.hook" });
    expect(result.map((e) => e.timestamp)).toEqual([
      "2026-05-11T18:00:00Z",
      "2026-05-11T18:01:00Z",
      "2026-05-11T18:02:00Z",
    ]);
    expect(result[0]?.id).toBe("hist-1");
    expect(result[0]?.type).toBe("claude_code.hook");
    expect(result[0]?.data).toEqual({ x: 1 });
  });

  it("returns [] when the server reports persistence not configured (503)", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      mkResponse(503, { error: "persistence not configured" }),
    );
    const result = await fetchRecentEvents();
    expect(result).toEqual([]);
  });

  it("throws for unexpected non-OK responses", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      mkResponse(500, { error: "boom" }),
    );
    await expect(fetchRecentEvents()).rejects.toThrow(/HTTP 500/);
  });

  it("sends type, since, limit in the query string", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      mkResponse(200, { events: [] }),
    );
    await fetchRecentEvents({
      type: "claude_code.hook",
      since: new Date("2026-05-10T00:00:00Z"),
      limit: 42,
    });
    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const url = call?.[0] as string;
    expect(url).toContain("type=claude_code.hook");
    expect(url).toContain("since=2026-05-10");
    expect(url).toContain("limit=42");
  });
});

function mkResponse(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  } as Response;
}

describe("fetchTraceEvents", () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("keeps only rows whose top-level traceId matches, maps to StreamEvent, ASC order", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      mkResponse(200, {
        events: [
          // Server returns DESC; note case-b's row sits between the two matches.
          {
            id: 4,
            type: "agent.tool.end",
            timestamp: "2026-07-03T10:00:04Z",
            data: { x: 4 },
            traceId: "run-1:case-a",
          },
          {
            id: 3,
            type: "agent.tool.progress",
            timestamp: "2026-07-03T10:00:03Z",
            data: { x: 3 },
            traceId: "run-1:case-b",
          },
          {
            id: 2,
            type: "agent.tool.start",
            timestamp: "2026-07-03T10:00:02Z",
            data: { x: 2 },
            traceId: "run-1:case-a",
          },
          {
            id: 1,
            type: "agent.llm.start",
            timestamp: "2026-07-03T10:00:01Z",
            data: { x: 1 },
            traceId: null,
          },
        ],
      }),
    );

    const result = await fetchTraceEvents("run-1:case-a");
    expect(result.map((e) => e.id)).toEqual(["hist-2", "hist-4"]);
    expect(result.map((e) => e.timestamp)).toEqual([
      "2026-07-03T10:00:02Z",
      "2026-07-03T10:00:04Z",
    ]);
  });

  it("returns [] on 503", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      mkResponse(503, { error: "persistence not configured" }),
    );
    const result = await fetchTraceEvents("run-1:case-a");
    expect(result).toEqual([]);
  });

  it("returns [] when no row carries the traceId (purged / outside the window)", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      mkResponse(200, {
        events: [
          {
            id: 1,
            type: "agent.llm.start",
            timestamp: "2026-07-03T10:00:01Z",
            data: {},
            traceId: "run-1:other-case",
          },
        ],
      }),
    );
    const result = await fetchTraceEvents("run-1:case-a");
    expect(result).toEqual([]);
  });

  it("sends limit=10000 by default", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      mkResponse(200, { events: [] }),
    );
    await fetchTraceEvents("run-1:case-a");
    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const url = call?.[0] as string;
    expect(url).toContain("/admin/events/recent");
    expect(url).toContain("limit=10000");
  });
});

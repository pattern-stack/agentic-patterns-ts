/**
 * fetchRecentEvents — REST hydration helper used by the Claude Code page on
 * first paint. Tests the happy path, the 503-when-no-store fallback, and the
 * server's DESC → ASC reversal.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchRecentEvents } from "../lib/eventApi";

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

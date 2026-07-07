/**
 * `lib/runsApi.ts` — fetcher suite. The `evalApi.test.ts` harness: `vi.fn`
 * fetch, `mkResponse`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PersistedEvent, RunRow, RunSummary } from "../api/types";
import { fetchRun, fetchRunEvents, fetchRuns } from "../lib/runsApi";

const originalFetch = globalThis.fetch;

function mkResponse(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  } as Response;
}

describe("fetchRuns", () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const runs: RunSummary[] = [
    {
      runId: "run-1",
      traceId: "run-1",
      tsStart: "2026-07-01T10:00:00Z",
      tsEnd: "2026-07-01T10:05:00Z",
      agentName: "retrieval-analyst",
      model: "sonnet",
      status: "ok",
      finishReason: "stop",
      toolCalls: 2,
      iterations: 3,
      inputTokens: 100,
      outputTokens: 50,
      elapsedMs: 1200,
      answerLength: 42,
      hasPrompt: true,
    },
  ];

  it("maps { runs: [...] } and sends limit/agent/status/since in the query string", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mkResponse(200, { runs }));

    const result = await fetchRuns({
      limit: 20,
      agent: "retrieval-analyst",
      status: "ok",
      since: "2026-07-01T00:00:00Z",
    });
    expect(result).toEqual({ kind: "ok", data: runs });

    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const url = call?.[0] as string;
    expect(url).toContain("/admin/runs");
    expect(url).toContain("limit=20");
    expect(url).toContain("agent=retrieval-analyst");
    expect(url).toContain("status=ok");
    expect(url).toContain(`since=${encodeURIComponent("2026-07-01T00:00:00Z")}`);
  });

  it("sends no query string when all filters are omitted", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      mkResponse(200, { runs: [] }),
    );
    await fetchRuns();
    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call?.[0]).toBe("/admin/runs");
  });

  it("returns { kind: 'unconfigured' } on 503", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      mkResponse(503, { error: "persistence not configured" }),
    );
    const result = await fetchRuns();
    expect(result).toEqual({ kind: "unconfigured" });
  });

  it("throws for unexpected non-OK responses", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      mkResponse(500, { error: "boom" }),
    );
    await expect(fetchRuns()).rejects.toThrow(/HTTP 500/);
  });
});

describe("fetchRun", () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const run: RunRow = {
    runId: "run-1",
    traceId: "run-1",
    tsStart: "2026-07-01T10:00:00Z",
    tsEnd: "2026-07-01T10:05:00Z",
    agentName: "retrieval-analyst",
    model: "sonnet",
    systemPrompt: "You are…",
    agentConfig: null,
    finalAnswer: "the answer",
    toolCalls: 2,
    iterations: 3,
    inputTokens: 100,
    outputTokens: 50,
    finishReason: "stop",
    elapsedMs: 1200,
    status: "ok",
    error: null,
    stepMetrics: null,
    metadata: null,
  };

  it("returns the full row on 200 and URL-encodes the id", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mkResponse(200, { run }));
    const result = await fetchRun("run 1/x");
    expect(result).toEqual({ kind: "ok", data: run });
    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call?.[0]).toBe(`/admin/runs/${encodeURIComponent("run 1/x")}`);
  });

  it("returns { kind: 'not-found' } on 404", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      mkResponse(404, { error: 'run "run-x" not found' }),
    );
    const result = await fetchRun("run-x");
    expect(result).toEqual({ kind: "not-found" });
  });

  it("returns { kind: 'unconfigured' } on 503", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      mkResponse(503, { error: "persistence not configured" }),
    );
    const result = await fetchRun("run-1");
    expect(result).toEqual({ kind: "unconfigured" });
  });

  it("throws for unexpected non-OK responses", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      mkResponse(500, { error: "boom" }),
    );
    await expect(fetchRun("run-1")).rejects.toThrow(/HTTP 500/);
  });
});

describe("fetchRunEvents", () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const events: PersistedEvent[] = [
    {
      id: 1,
      type: "agent.message.start",
      timestamp: "2026-07-01T10:00:00Z",
      traceId: "run-1",
      runId: "run-1",
      spanId: "span-1",
      ccSessionId: null,
      ccHookName: null,
      ccCwd: null,
      data: { agentName: "retrieval-analyst" },
    },
  ];

  it("returns { runId, events } ASC on 200", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      mkResponse(200, { runId: "run-1", events }),
    );
    const result = await fetchRunEvents("run-1");
    expect(result).toEqual({ kind: "ok", data: { runId: "run-1", events } });
    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call?.[0]).toBe("/admin/runs/run-1/events");
  });

  it("returns { kind: 'not-found' } on 404", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      mkResponse(404, { error: 'run "run-x" not found' }),
    );
    const result = await fetchRunEvents("run-x");
    expect(result).toEqual({ kind: "not-found" });
  });

  it("returns { kind: 'unconfigured' } on 503", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      mkResponse(503, { error: "persistence not configured" }),
    );
    const result = await fetchRunEvents("run-1");
    expect(result).toEqual({ kind: "unconfigured" });
  });

  it("throws for unexpected non-OK responses", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      mkResponse(500, { error: "boom" }),
    );
    await expect(fetchRunEvents("run-1")).rejects.toThrow(/HTTP 500/);
  });
});

/**
 * `lib/evalApi.ts` — fetcher + pure-helper suite. The `eventApi.test.ts`
 * harness: `vi.fn` fetch, `mkResponse`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EvalRunDetailResponse, EvalRunRow, SplitAggregate } from "../api/types";
import {
  fetchEvalRunDetail,
  fetchEvalRuns,
  fetchSplitAggregates,
  filterRuns,
  safeParseAnswer,
} from "../lib/evalApi";

const originalFetch = globalThis.fetch;

function mkResponse(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  } as Response;
}

describe("fetchEvalRuns", () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("maps { runs: [...] } and sends limit in the query string", async () => {
    const runs: EvalRunRow[] = [
      {
        id: "run-1",
        tsStart: "2026-07-01T10:00:00Z",
        tsEnd: "2026-07-01T10:05:00Z",
        setId: "bank",
        targetId: "dealbrain/curator",
        variant: "baseline",
        split: "dev",
        model: "sonnet",
        gitSha: "abc1234",
        status: "ok",
      },
    ];
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mkResponse(200, { runs }));

    const result = await fetchEvalRuns({ limit: 200 });
    expect(result).toEqual({ kind: "ok", data: runs });

    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const url = call?.[0] as string;
    expect(url).toContain("/eval/runs");
    expect(url).toContain("limit=200");
  });

  it("returns { kind: 'unconfigured' } on 503", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      mkResponse(503, { error: "persistence not configured" }),
    );
    const result = await fetchEvalRuns();
    expect(result).toEqual({ kind: "unconfigured" });
  });

  it("throws for unexpected non-OK responses", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      mkResponse(500, { error: "boom" }),
    );
    await expect(fetchEvalRuns()).rejects.toThrow(/HTTP 500/);
  });
});

describe("fetchEvalRunDetail", () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns run + results + summary on 200", async () => {
    const body: EvalRunDetailResponse = {
      run: {
        id: "run-1",
        tsStart: "2026-07-01T10:00:00Z",
        tsEnd: "2026-07-01T10:05:00Z",
        setId: "bank",
        targetId: "dealbrain/curator",
        variant: "baseline",
        split: "dev",
        model: "sonnet",
        gitSha: "abc1234",
        status: "ok",
      },
      results: [
        {
          evalRunId: "run-1",
          caseId: "case-01",
          runId: "r1",
          scores: [{ name: "exact-match", value: 1, passed: true }],
          pass: true,
          traceId: "run-1:case-01",
          runStatus: "ok",
          finalAnswer: '"42"',
          inputTokens: 10,
          outputTokens: 5,
          finishReason: "stop",
          elapsedMs: 100,
          runError: null,
        },
      ],
      summary: {
        cases: 1,
        passed: 1,
        failed: 0,
        ungated: 0,
        errored: 0,
        passRate: 1,
        inputTokens: 10,
        outputTokens: 5,
      },
    };
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mkResponse(200, body));

    const result = await fetchEvalRunDetail("run-1");
    expect(result).toEqual({ kind: "ok", data: body });
  });

  it("returns { kind: 'not-found' } on 404", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      mkResponse(404, { error: 'eval run "run-x" not found' }),
    );
    const result = await fetchEvalRunDetail("run-x");
    expect(result).toEqual({ kind: "not-found" });
  });

  it("returns { kind: 'unconfigured' } on 503", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      mkResponse(503, { error: "persistence not configured" }),
    );
    const result = await fetchEvalRunDetail("run-1");
    expect(result).toEqual({ kind: "unconfigured" });
  });
});

describe("fetchSplitAggregates", () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("unwraps { aggregates: [...] } on 200", async () => {
    const aggregates: SplitAggregate[] = [
      { split: "train", results: 4, passed: 2, failed: 1, passRate: 2 / 3 },
      { split: "test", results: 2, passed: 1, failed: 1, passRate: 0.5 },
    ];
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      mkResponse(200, { aggregates }),
    );

    const result = await fetchSplitAggregates();
    expect(result).toEqual({ kind: "ok", data: aggregates });
  });

  it("returns { kind: 'unconfigured' } on 503", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      mkResponse(503, { error: "persistence not configured" }),
    );
    const result = await fetchSplitAggregates();
    expect(result).toEqual({ kind: "unconfigured" });
  });

  it("throws for unexpected non-OK responses", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      mkResponse(500, { error: "boom" }),
    );
    await expect(fetchSplitAggregates()).rejects.toThrow(/HTTP 500/);
  });

  it("serializes set/target/variant as query params and omits empties", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      mkResponse(200, { aggregates: [] }),
    );

    await fetchSplitAggregates({ set: "bank", target: "dealbrain/curator" });

    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const url = call?.[0] as string;
    expect(url).toContain("/eval/aggregates/splits");
    expect(url).toContain("set=bank");
    expect(url).toContain(`target=${encodeURIComponent("dealbrain/curator")}`);
    expect(url).not.toContain("variant=");
  });

  it("sends no query string when all filters are omitted", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      mkResponse(200, { aggregates: [] }),
    );

    await fetchSplitAggregates();

    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const url = call?.[0] as string;
    expect(url).toBe("/eval/aggregates/splits");
  });
});

describe("filterRuns", () => {
  const runs: EvalRunRow[] = [
    {
      id: "run-1",
      tsStart: "2026-07-01T10:00:00Z",
      tsEnd: null,
      setId: "bank",
      targetId: "dealbrain/curator",
      variant: "baseline",
      split: "dev",
      model: "sonnet",
      gitSha: null,
      status: "ok",
    },
    {
      id: "run-2",
      tsStart: "2026-07-02T10:00:00Z",
      tsEnd: null,
      setId: "bank",
      targetId: "dealbrain/curator",
      variant: "candidate",
      split: "train",
      model: "opus",
      gitSha: null,
      status: "running",
    },
    {
      id: "run-3",
      tsStart: "2026-07-03T10:00:00Z",
      tsEnd: null,
      setId: "other-bank",
      targetId: "other/target",
      variant: "baseline",
      split: null,
      model: "sonnet",
      gitSha: null,
      status: "error",
    },
  ];

  it("each key narrows independently", () => {
    expect(filterRuns(runs, { set: "bank" }).map((r) => r.id)).toEqual(["run-1", "run-2"]);
    expect(filterRuns(runs, { target: "other/target" }).map((r) => r.id)).toEqual(["run-3"]);
    expect(filterRuns(runs, { variant: "candidate" }).map((r) => r.id)).toEqual(["run-2"]);
    expect(filterRuns(runs, { split: "dev" }).map((r) => r.id)).toEqual(["run-1"]);
  });

  it("keys combine (intersection)", () => {
    expect(filterRuns(runs, { set: "bank", variant: "baseline" }).map((r) => r.id)).toEqual([
      "run-1",
    ]);
  });

  it("empty filter is identity", () => {
    expect(filterRuns(runs, {})).toEqual(runs);
  });

  it('"untagged" matches only split === null', () => {
    expect(filterRuns(runs, { split: "untagged" }).map((r) => r.id)).toEqual(["run-3"]);
  });
});

describe("safeParseAnswer", () => {
  it('parses a JSON-serialized string: \'"42"\' -> "42"', () => {
    expect(safeParseAnswer('"42"')).toBe("42");
  });

  it("parses a JSON object: '{\"a\":1}' -> { a: 1 }", () => {
    expect(safeParseAnswer('{"a":1}')).toEqual({ a: 1 });
  });

  it("falls back to the raw string for non-JSON answers", () => {
    expect(safeParseAnswer("not json")).toBe("not json");
  });

  it("returns null for null", () => {
    expect(safeParseAnswer(null)).toBeNull();
  });
});

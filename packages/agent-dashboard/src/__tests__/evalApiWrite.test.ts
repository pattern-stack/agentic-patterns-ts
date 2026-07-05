/**
 * `lib/evalApi.ts` write clients (WI-5) — status mapping for the WI-2
 * POST/PATCH/PUT/DELETE routes. The `evalApi.test.ts` harness: `vi.fn` fetch +
 * `mkResponse`. 503 -> `unconfigured`; 2xx -> `ok`; other non-2xx throws the
 * server's `error` (+ `hint`).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EvalCaseRow, EvalSetSummary } from "../api/types";
import { createEvalSet, deleteEvalCase, updateEvalSet, upsertEvalCase } from "../lib/evalApi";

const originalFetch = globalThis.fetch;

function mkResponse(status: number, body: unknown): Response {
  return { status, ok: status >= 200 && status < 300, json: async () => body } as Response;
}

const fetchMock = () => globalThis.fetch as ReturnType<typeof vi.fn>;

const setSummary: EvalSetSummary = {
  id: "bank",
  name: "Bank",
  description: null,
  createdTs: "2026-07-01T10:00:00Z",
  caseCount: 0,
  splitCounts: {},
};

const caseRow: EvalCaseRow = {
  setId: "bank",
  caseId: "c1",
  input: "2+2?",
  expected: "4",
  tags: null,
  split: "train",
};

beforeEach(() => {
  globalThis.fetch = vi.fn() as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("createEvalSet", () => {
  it("POSTs and maps { set } on 201", async () => {
    fetchMock().mockResolvedValueOnce(mkResponse(201, { set: setSummary }));
    const result = await createEvalSet({ id: "bank", name: "Bank" });
    expect(result).toEqual({ kind: "ok", data: setSummary });

    const [url, init] = fetchMock().mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/eval/sets");
    expect(init.method).toBe("POST");
  });

  it("maps 503 to unconfigured", async () => {
    fetchMock().mockResolvedValueOnce(mkResponse(503, { error: "persistence not configured" }));
    expect(await createEvalSet({ id: "x" })).toEqual({ kind: "unconfigured" });
  });

  it("throws the server error (+ hint) on 400", async () => {
    fetchMock().mockResolvedValueOnce(mkResponse(400, { error: "id is required" }));
    await expect(createEvalSet({ id: "" })).rejects.toThrow("id is required");
  });
});

describe("updateEvalSet", () => {
  it("PATCHes /eval/sets/:id and maps { set }", async () => {
    fetchMock().mockResolvedValueOnce(mkResponse(200, { set: setSummary }));
    const result = await updateEvalSet("bank", { name: "Renamed" });
    expect(result).toEqual({ kind: "ok", data: setSummary });

    const [url, init] = fetchMock().mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/eval/sets/bank");
    expect(init.method).toBe("PATCH");
  });

  it("throws on 404", async () => {
    fetchMock().mockResolvedValueOnce(mkResponse(404, { error: 'eval set "nope" not found' }));
    await expect(updateEvalSet("nope", { name: "x" })).rejects.toThrow("not found");
  });
});

describe("upsertEvalCase", () => {
  it("PUTs the case route and maps { case }", async () => {
    fetchMock().mockResolvedValueOnce(mkResponse(201, { case: caseRow }));
    const result = await upsertEvalCase("bank", "c1", { input: "2+2?", expected: "4" });
    expect(result).toEqual({ kind: "ok", data: caseRow });

    const [url, init] = fetchMock().mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/eval/sets/bank/cases/c1");
    expect(init.method).toBe("PUT");
  });

  it("url-encodes the case id", async () => {
    fetchMock().mockResolvedValueOnce(mkResponse(200, { case: caseRow }));
    await upsertEvalCase("bank", "a/b c", { input: 1 });
    const [url] = fetchMock().mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/eval/sets/bank/cases/a%2Fb%20c");
  });

  it("maps 503 to unconfigured", async () => {
    fetchMock().mockResolvedValueOnce(mkResponse(503, {}));
    expect(await upsertEvalCase("bank", "c1", { input: 1 })).toEqual({ kind: "unconfigured" });
  });
});

describe("deleteEvalCase", () => {
  it("DELETEs and maps the body", async () => {
    fetchMock().mockResolvedValueOnce(mkResponse(200, { deleted: true, caseId: "c1" }));
    const result = await deleteEvalCase("bank", "c1");
    expect(result).toEqual({ kind: "ok", data: { deleted: true, caseId: "c1" } });

    const [url, init] = fetchMock().mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/eval/sets/bank/cases/c1");
    expect(init.method).toBe("DELETE");
  });

  it("throws on 404", async () => {
    fetchMock().mockResolvedValueOnce(
      mkResponse(404, { error: 'case "c1" not found in set "bank"' }),
    );
    await expect(deleteEvalCase("bank", "c1")).rejects.toThrow("not found");
  });
});

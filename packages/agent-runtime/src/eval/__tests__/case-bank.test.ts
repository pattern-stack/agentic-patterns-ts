/**
 * Case-bank loader + split-discipline tests (spec `.ai-docs/stacks/eval-surface/
 * specs/134.md` § Tests). Temp jsonl files via the `mkdtempSync` idiom
 * (`storage/__tests__/event-store.test.ts` precedent); engine integration via
 * `FunctionStep` + `MockRunner` (`eval/__tests__/run-eval.test.ts` precedent).
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, expectTypeOf, it } from "vitest";
import { MockRunner } from "../../runner/mock-runner.js";
import type { EvalSplit as StorageEvalSplit } from "../../storage/eval-store.js";
import { FunctionStep } from "../../workflows/function-step.js";
import {
  CaseBankLoadError,
  HeldOutSplitError,
  assertSplitSelectable,
  filterBySplit,
  loadCasesJsonl,
  loadGold,
} from "../case-bank.js";
import { runEval } from "../run-eval.js";
import { exactMatch } from "../scorer.js";
import type { EvalCase, EvalSplit } from "../types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "case-bank-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Write a jsonl file from an array of raw (already-encoded, or literal) line strings. */
function writeJsonl(name: string, lines: string[]): string {
  const path = join(dir, name);
  writeFileSync(path, lines.join("\n"), "utf8");
  return path;
}

function captureError<T extends Error>(fn: () => unknown): T {
  try {
    fn();
  } catch (error) {
    return error as T;
  }
  throw new Error("expected function to throw, but it did not");
}

// ---------------------------------------------------------------------------
// 1-2. loadCasesJsonl — round-trip + blank-line tolerance
// ---------------------------------------------------------------------------

describe("loadCasesJsonl — round-trip", () => {
  it("returns one case per split + one untagged, in file order, with split/tags/payloads intact", () => {
    const path = writeJsonl("cases.jsonl", [
      JSON.stringify({
        id: "c-train",
        input: { q: 1 },
        expected: { a: 1 },
        tags: ["math"],
        split: "train",
      }),
      JSON.stringify({
        id: "c-dev",
        input: { q: 2 },
        expected: { a: 2 },
        tags: ["math"],
        split: "dev",
      }),
      JSON.stringify({
        id: "c-test",
        input: { q: 3 },
        expected: { a: 3 },
        tags: ["math"],
        split: "test",
      }),
      JSON.stringify({ id: "c-untagged", input: { q: 4 }, expected: { a: 4 } }),
    ]);

    const cases = loadCasesJsonl<{ q: number }, { a: number }>(path);

    expect(cases.map((c) => c.id)).toEqual(["c-train", "c-dev", "c-test", "c-untagged"]);
    expect(cases[0]?.split).toBe("train");
    expect(cases[1]?.split).toBe("dev");
    expect(cases[2]?.split).toBe("test");
    expect(cases[3]?.split).toBeUndefined();
    expect(cases[0]?.tags).toEqual(["math"]);
    expect(cases[0]?.input).toEqual({ q: 1 });
    expect(cases[0]?.expected).toEqual({ a: 1 });
  });

  it("skips blank lines but reports the TRUE physical line number on a later failure", () => {
    const path = writeJsonl("blanks.jsonl", [
      JSON.stringify({ id: "1", input: "a" }),
      "",
      "   ",
      "not json{{{",
    ]);

    // Physical line 4 is malformed; the row index among non-blank rows would
    // be 2 — the loader must cite the true line number, not the row index.
    const err = captureError<CaseBankLoadError>(() => loadCasesJsonl(path));

    expect(err).toBeInstanceOf(CaseBankLoadError);
    expect(err.line).toBe(4);
    expect(err.message.startsWith(`case-bank: ${path}:4: invalid JSON — `)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3-7. loadCasesJsonl — malformed-row error shapes
// ---------------------------------------------------------------------------

describe("loadCasesJsonl — malformed rows", () => {
  it("malformed JSON: case-addressed error with path/line populated", () => {
    const path = writeJsonl("bad-json.jsonl", ["{ not valid json"]);

    const err = captureError<CaseBankLoadError>(() => loadCasesJsonl(path));

    expect(err).toBeInstanceOf(CaseBankLoadError);
    expect(err.name).toBe("CaseBankLoadError");
    expect(err.path).toBe(path);
    expect(err.line).toBe(1);
    expect(err.message.startsWith(`case-bank: ${path}:1: invalid JSON — `)).toBe(true);
  });

  it('invalid envelope: "split": "validate" (the consumer\'s old name) is case-addressed', () => {
    const path = writeJsonl("invalid-split.jsonl", [
      JSON.stringify({ id: "c-1", input: "x", split: "validate" }),
    ]);

    const err = captureError<CaseBankLoadError>(() => loadCasesJsonl(path));

    expect(err).toBeInstanceOf(CaseBankLoadError);
    expect(err.path).toBe(path);
    expect(err.line).toBe(1);
    expect(err.caseId).toBe("c-1");
    expect(err.message.startsWith(`case-bank: ${path}:1 (id=c-1): invalid case — `)).toBe(true);
  });

  it('strict envelope: an unknown top-level key ("spilt") is an error, not a silent strip', () => {
    const path = writeJsonl("typo.jsonl", [
      JSON.stringify({ id: "c-1", input: "x", spilt: "train" }),
    ]);

    const err = captureError<CaseBankLoadError>(() => loadCasesJsonl(path));

    expect(err).toBeInstanceOf(CaseBankLoadError);
    expect(err.message).toContain("invalid case");
  });

  it("missing id: error cites path + line and OMITS the (id=…) segment", () => {
    const path = writeJsonl("missing-id.jsonl", [JSON.stringify({ input: "x" })]);

    const err = captureError<CaseBankLoadError>(() => loadCasesJsonl(path));

    expect(err.caseId).toBeUndefined();
    expect(err.message.startsWith(`case-bank: ${path}:1: invalid case — `)).toBe(true);
    expect(err.message).not.toContain("(id=");
  });

  it("non-string id: error cites path + line and OMITS the (id=…) segment", () => {
    const path = writeJsonl("non-string-id.jsonl", [JSON.stringify({ id: 123, input: "x" })]);

    const err = captureError<CaseBankLoadError>(() => loadCasesJsonl(path));

    expect(err.caseId).toBeUndefined();
    expect(err.message).not.toContain("(id=");
  });

  it("duplicate id: error names the id and both line numbers", () => {
    const path = writeJsonl("dup.jsonl", [
      JSON.stringify({ id: "same", input: "a" }),
      JSON.stringify({ id: "same", input: "b" }),
    ]);

    const err = captureError<CaseBankLoadError>(() => loadCasesJsonl(path));

    expect(err).toBeInstanceOf(CaseBankLoadError);
    expect(err.caseId).toBe("same");
    expect(err.line).toBe(2);
    expect(err.message).toBe(`case-bank: ${path}:2 (id=same): duplicate case id (first at line 1)`);
  });
});

// ---------------------------------------------------------------------------
// 8-9. loadGold — overlay + failure modes
// ---------------------------------------------------------------------------

describe("loadGold — overlay semantics", () => {
  it("gold wins over inline expected; unmatched-gold cases pass through unchanged; inputs untouched", () => {
    const casesPath = writeJsonl("cases.jsonl", [
      JSON.stringify({ id: "1", input: "a", expected: "inline-1" }),
      JSON.stringify({ id: "2", input: "b" }),
      JSON.stringify({ id: "3", input: "c", expected: "keep-me" }),
    ]);
    const goldPath = writeJsonl("gold.jsonl", [
      JSON.stringify({ id: "1", expected: "gold-1" }),
      JSON.stringify({ id: "2", expected: "gold-2" }),
    ]);

    const cases = loadGold<string, string>(casesPath, goldPath);

    expect(cases.find((c) => c.id === "1")?.expected).toBe("gold-1"); // gold beats inline
    expect(cases.find((c) => c.id === "2")?.expected).toBe("gold-2"); // gold fills a gap
    expect(cases.find((c) => c.id === "3")?.expected).toBe("keep-me"); // no gold row — untouched
    expect(cases.find((c) => c.id === "3")?.input).toBe("c"); // input never mutated
  });
});

describe("loadGold — failure modes", () => {
  it("unmatched gold id: error citing goldPath + line + id + casesPath", () => {
    const casesPath = writeJsonl("cases.jsonl", [JSON.stringify({ id: "1", input: "a" })]);
    const goldPath = writeJsonl("gold.jsonl", [JSON.stringify({ id: "ghost", expected: "x" })]);

    const err = captureError<CaseBankLoadError>(() => loadGold(casesPath, goldPath));

    expect(err).toBeInstanceOf(CaseBankLoadError);
    expect(err.message).toBe(
      `case-bank: ${goldPath}:1 (id=ghost): gold row has no matching case in ${casesPath}`,
    );
  });

  it("duplicate gold id is an error", () => {
    const casesPath = writeJsonl("cases2.jsonl", [JSON.stringify({ id: "1", input: "a" })]);
    const goldPath = writeJsonl("gold2.jsonl", [
      JSON.stringify({ id: "1", expected: "x" }),
      JSON.stringify({ id: "1", expected: "y" }),
    ]);

    const err = captureError<CaseBankLoadError>(() => loadGold(casesPath, goldPath));
    expect(err).toBeInstanceOf(CaseBankLoadError);
    expect(err.message).toContain("duplicate gold id");
  });

  it('gold row missing "expected" is an error', () => {
    const casesPath = writeJsonl("cases3.jsonl", [JSON.stringify({ id: "1", input: "a" })]);
    const goldPath = writeJsonl("gold3.jsonl", [JSON.stringify({ id: "1" })]);

    const err = captureError<CaseBankLoadError>(() => loadGold(casesPath, goldPath));

    expect(err).toBeInstanceOf(CaseBankLoadError);
    expect(err.message).toContain('missing required key "expected"');
  });

  it("gold row with extra keys is an error (strict)", () => {
    const casesPath = writeJsonl("cases4.jsonl", [JSON.stringify({ id: "1", input: "a" })]);
    const goldPath = writeJsonl("gold4.jsonl", [
      JSON.stringify({ id: "1", expected: "x", extra: "nope" }),
    ]);

    const err = captureError<CaseBankLoadError>(() => loadGold(casesPath, goldPath));
    expect(err).toBeInstanceOf(CaseBankLoadError);
  });
});

// ---------------------------------------------------------------------------
// 10-11. filterBySplit / assertSplitSelectable — split discipline
// ---------------------------------------------------------------------------

describe("filterBySplit", () => {
  const cases: EvalCase<string, string>[] = [
    { id: "1", input: "a", split: "train" },
    { id: "2", input: "b", split: "train" },
    { id: "3", input: "c", split: "dev" },
    { id: "4", input: "d" }, // untagged
  ];

  it("returns only exact-split cases; untagged excluded; result is a new array", () => {
    const trainCases = filterBySplit(cases, "train");
    expect(trainCases.map((c) => c.id)).toEqual(["1", "2"]);
    expect(trainCases).not.toBe(cases);
  });

  it("dev needs no opt-in", () => {
    const devCases = filterBySplit(cases, "dev");
    expect(devCases.map((c) => c.id)).toEqual(["3"]);
  });
});

describe("held-out guard (the acceptance path)", () => {
  const cases: EvalCase<string, string>[] = [
    { id: "1", input: "a", split: "test" },
    { id: "2", input: "b", split: "train" },
  ];

  const EXPECTED_MESSAGE =
    'case-bank: refusing the held-out "test" split — touch once, pre-ship only. Pass { allowTest: true } to run it deliberately.';

  it('filterBySplit(cases, "test") throws HeldOutSplitError with the exact message', () => {
    const err = captureError<HeldOutSplitError>(() => filterBySplit(cases, "test"));
    expect(err).toBeInstanceOf(HeldOutSplitError);
    expect(err.name).toBe("HeldOutSplitError");
    expect(err.message).toBe(EXPECTED_MESSAGE);
  });

  it("{ allowTest: true } returns the test cases", () => {
    const testCases = filterBySplit(cases, "test", { allowTest: true });
    expect(testCases.map((c) => c.id)).toEqual(["1"]);
  });

  it('assertSplitSelectable("test") standalone throws the same, before any file I/O (free refusal)', () => {
    const err = captureError<HeldOutSplitError>(() => assertSplitSelectable("test"));
    expect(err).toBeInstanceOf(HeldOutSplitError);
    expect(err.message).toBe(EXPECTED_MESSAGE);

    expect(() => assertSplitSelectable("test", { allowTest: true })).not.toThrow();
    expect(() => assertSplitSelectable("train")).not.toThrow();
    expect(() => assertSplitSelectable("dev")).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 12. EvalSplit — compile-time drift guard
// ---------------------------------------------------------------------------

describe("EvalSplit — compile-time drift guard", () => {
  it("stays structurally identical to storage/eval-store.ts's twin (#132 zero-coupling)", () => {
    expectTypeOf<EvalSplit>().toEqualTypeOf<StorageEvalSplit>();
  });
});

// ---------------------------------------------------------------------------
// 13. Backward compat + engine pass-through (integration)
// ---------------------------------------------------------------------------

describe("runEval — case-bank backward compat + pass-through (integration)", () => {
  it("runs a mixed bank (split-tagged + untagged) loaded via loadCasesJsonl; split rides through untouched", async () => {
    const path = writeJsonl("mixed.jsonl", [
      JSON.stringify({ id: "1", input: "a", expected: "A", split: "train" }),
      JSON.stringify({ id: "2", input: "b", expected: "B" }),
    ]);
    const cases = loadCasesJsonl<string, string>(path);

    const upper = new FunctionStep<string, string>({
      name: "upper",
      fn: (input) => input.toUpperCase(),
    });

    const report = await runEval(
      { target: upper, cases, scorers: [exactMatch<string>()] },
      { runner: new MockRunner() },
    );

    expect(report.results).toHaveLength(2);
    expect(report.results[0]?.case.split).toBe("train");
    expect(report.results[1]?.case.split).toBeUndefined();
    expect(report.results[0]?.scores[0]?.value).toBe(1);
    expect(report.results[1]?.scores[0]?.value).toBe(1);
    expect(report.summary.cases).toBe(2);
    expect(report.summary.succeeded).toBe(2);
    expect(report.summary.errored).toBe(0);
  });

  it("a split-less inline cases array (the pre-#134 calling convention) still validates and runs", async () => {
    const upper = new FunctionStep<string, string>({
      name: "upper",
      fn: (input) => input.toUpperCase(),
    });

    const report = await runEval(
      {
        target: upper,
        cases: [
          { id: "1", input: "a", expected: "A" },
          { id: "2", input: "b", expected: "B" },
        ],
        scorers: [exactMatch<string>()],
      },
      { runner: new MockRunner() },
    );

    expect(report.results).toHaveLength(2);
    expect(report.summary.succeeded).toBe(2);
  });
});

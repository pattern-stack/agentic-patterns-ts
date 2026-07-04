/**
 * Tests for `setMembership` (spec `.ai-docs/stacks/eval-surface/specs/141.md` § Test plan).
 *
 * Deterministic throughout — no runner/model involvement.
 */

import { describe, expect, it } from "vitest";
import { MockRunner } from "../../runner/mock-runner.js";
import { runEval } from "../run-eval.js";
import { setMembership } from "../scorers/set-membership.js";
import type { EvalCase, Score } from "../types.js";

function score(args: {
  expected?: unknown;
  output: unknown;
  input?: unknown;
  scorer?: ReturnType<typeof setMembership>;
}): Score | Score[] {
  const s = args.scorer ?? setMembership();
  const evalCase: EvalCase<unknown, unknown> = {
    id: "c1",
    input: args.input ?? "q",
    expected: args.expected,
  };
  // setMembership's implementation is synchronous; the `Scorer` contract's
  // return type is `Score | Score[] | Promise<…>` to allow async scorers too.
  return s({
    input: args.input ?? "q",
    output: args.output,
    expected: args.expected,
    case: evalCase,
  }) as Score | Score[];
}

function single(result: Score | Score[]): Score {
  const arr = Array.isArray(result) ? result : [result];
  const first = arr[0];
  if (!first) throw new Error("expected a Score, got []");
  return first;
}

// ---------------------------------------------------------------------------
// T-SM1 — regression: the v1 prefix-vs-UUID bug, both halves
// ---------------------------------------------------------------------------

describe("setMembership — T-SM1 (the prefix-bug regression, both halves)", () => {
  it("full-UUID expected vs same UUID cited in a different case → hit, recall 1", () => {
    const uuid = "b260d4f7-1234-4abc-8def-0123456789ab";
    const result = single(
      score({
        expected: [uuid],
        output: `The answer cites ${uuid.toUpperCase()} as its source.`,
      }),
    );
    expect(result.detail?.recall).toBe(1);
    expect(result.detail?.hits).toBe(1);
    expect(result.passed).toBe(true);
  });

  it("8-char-prefix expected vs full-UUID cited → NOT a hit; prefixSuspects surfaces it", () => {
    const fullUuid = "b260d4f7-1234-4abc-8def-0123456789ab";
    const result = single(
      score({
        expected: ["b260d4f7"],
        output: `Cited source: ${fullUuid}`,
      }),
    );
    expect(result.detail?.hits).toBe(0);
    expect(result.detail?.recall).toBe(0);
    expect(result.passed).toBe(false);
    expect(result.detail?.prefixSuspects).toEqual(["b260d4f7"]);
  });
});

// ---------------------------------------------------------------------------
// T-SM2 — math + threshold boundaries
// ---------------------------------------------------------------------------

describe("setMembership — T-SM2 (math + threshold boundaries)", () => {
  it("E={a,b} C={a,x}: P=0.5 R=0.5 F1=0.5, fail (default thresholds)", () => {
    const result = single(
      score({
        expected: ["a", "b"],
        output: JSON.stringify(["a", "x"]),
        scorer: setMembership({
          extractCited: () => ["a", "x"],
        }),
      }),
    );
    expect(result.value).toBeCloseTo(0.5);
    expect(result.detail?.precision).toBeCloseTo(0.5);
    expect(result.detail?.recall).toBeCloseTo(0.5);
    expect(result.passed).toBe(false);
  });

  it("R=0.6 ∧ P=0.4 exactly (both boundary-exact) → pass", () => {
    // 10 expected ids, 6 hits (recall = 6/10 = 0.6 exact); 15 cited (6 hits + 9
    // unexpected) → precision = 6/15 = 0.4 exact. Both AT the default thresholds.
    const expected = Array.from({ length: 10 }, (_, i) => `e${i}`);
    const hitIds = expected.slice(0, 6);
    const unexpectedIds = Array.from({ length: 9 }, (_, i) => `x${i}`);
    const cited = [...hitIds, ...unexpectedIds];
    const result = single(
      score({ expected, output: "", scorer: setMembership({ extractCited: () => cited }) }),
    );
    expect(result.detail?.recall).toBe(0.6);
    expect(result.detail?.precision).toBe(0.4);
    expect(result.passed).toBe(true);
  });

  it("R=0.59 (just under the 0.6 recall threshold) → fail", () => {
    // 100 expected ids, 59 hits → recall = 0.59 exactly, precision kept at 1.0
    // (no unexpected citations) so ONLY the recall boundary is under test.
    const expected = Array.from({ length: 100 }, (_, i) => `e${i}`);
    const cited = expected.slice(0, 59);
    const result = single(
      score({ expected, output: "", scorer: setMembership({ extractCited: () => cited }) }),
    );
    expect(result.detail?.recall).toBeCloseTo(0.59);
    expect(result.detail?.precision).toBe(1);
    expect(result.passed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// T-SM3 — truth table
// ---------------------------------------------------------------------------

describe("setMembership — T-SM3 (truth table)", () => {
  it("E=[] C=[] → P=R=F1=1, pass", () => {
    const result = single(
      score({ expected: [], output: "", scorer: setMembership({ extractCited: () => [] }) }),
    );
    expect(result.detail?.precision).toBe(1);
    expect(result.detail?.recall).toBe(1);
    expect(result.value).toBe(1);
    expect(result.passed).toBe(true);
  });

  it("E=[] C=[x] → P=0, fail", () => {
    const result = single(
      score({ expected: [], output: "", scorer: setMembership({ extractCited: () => ["x"] }) }),
    );
    expect(result.detail?.precision).toBe(0);
    expect(result.passed).toBe(false);
  });

  it("E=[a] C=[] → R=0, fail", () => {
    const result = single(
      score({ expected: ["a"], output: "", scorer: setMembership({ extractCited: () => [] }) }),
    );
    expect(result.detail?.recall).toBe(0);
    expect(result.passed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// T-SM4 — expected-gating
// ---------------------------------------------------------------------------

describe("setMembership — T-SM4 (expected-gating)", () => {
  it("expected undefined → []", () => {
    const result = score({ expected: undefined, output: "no ids here" });
    expect(result).toEqual([]);
  });

  it("expected object without citedIds → []", () => {
    const result = score({ expected: { somethingElse: true }, output: "no ids here" });
    expect(result).toEqual([]);
  });

  it("via runEval + MockRunner: unscored case ⇒ derivePass → null (un-gated)", async () => {
    const target = {
      role: { name: "t" },
      getModel: () => "mock",
      getTools: () => [],
      getSystemPrompt: () => "",
      renderInitialPrompt: () => "",
    };
    const report = await runEval(
      {
        target,
        cases: [{ id: "c1", input: "hi" }],
        scorers: [setMembership()],
      },
      { runner: new MockRunner() },
    );
    expect(report.results[0]?.scores).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// T-SM5 — resolvers
// ---------------------------------------------------------------------------

describe("setMembership — T-SM5 (resolvers)", () => {
  it("expected: string[] direct", () => {
    const result = single(score({ expected: ["a"], output: "cites a here" }));
    expect(result.detail?.expectedCount).toBe(1);
  });

  it("expected.citedIds", () => {
    const result = single(
      score({
        expected: { citedIds: ["a", "b"] },
        output: "",
        scorer: setMembership({ extractCited: () => ["a", "b"] }),
      }),
    );
    expect(result.detail?.hits).toBe(2);
  });

  it("custom expectedIds/extractCited override defaults (structured output object → citations array)", () => {
    const custom = setMembership<unknown, { citations: string[] }, { ids: string[] }>({
      expectedIds: (args) => args.expected?.ids,
      extractCited: (args) => args.output.citations,
    });
    const result = single(
      custom({
        input: "q",
        output: { citations: ["x", "y"] },
        expected: { ids: ["x"] },
        case: { id: "c1", input: "q", expected: { ids: ["x"] } },
      }) as Score | Score[],
    );
    expect(result.detail?.hits).toBe(1);
    expect(result.detail?.unexpected).toEqual(["y"]);
  });
});

// ---------------------------------------------------------------------------
// T-SM6 — dedupe + normalization + the E=[] C=[] divergence pin
// ---------------------------------------------------------------------------

describe("setMembership — T-SM6 (dedupe + normalization + empty-empty)", () => {
  it("repeated citation counts once", () => {
    const result = single(
      score({
        expected: ["a"],
        output: "",
        scorer: setMembership({ extractCited: () => ["a", "a", "a"] }),
      }),
    );
    expect(result.detail?.citedCount).toBe(1);
    expect(result.detail?.hits).toBe(1);
  });

  it("whitespace-padded + differently-cased ids match", () => {
    const result = single(
      score({
        expected: ["  A-Id  "],
        output: "",
        scorer: setMembership({ extractCited: () => ["a-id"] }),
      }),
    );
    expect(result.detail?.hits).toBe(1);
    expect(result.passed).toBe(true);
  });

  it("E=[] C=[] pass is pinned as intentional divergence from v1", () => {
    const result = single(
      score({ expected: [], output: "", scorer: setMembership({ extractCited: () => [] }) }),
    );
    expect(result.passed).toBe(true);
  });
});

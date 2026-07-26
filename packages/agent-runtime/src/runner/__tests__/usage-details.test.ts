/**
 * Tests for #388 cache/reasoning token detail extraction + merge.
 */

import type { LanguageModelUsage } from "ai";
import { describe, expect, it } from "vitest";
import { detailsFromUsage, mergeUsageDetails } from "../usage-details.js";

function usage(
  input: Partial<{
    noCacheTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    textTokens: number;
    reasoningTokens: number;
  }> = {},
): LanguageModelUsage {
  return {
    inputTokens: undefined,
    inputTokenDetails: {
      noCacheTokens: input.noCacheTokens,
      cacheReadTokens: input.cacheReadTokens,
      cacheWriteTokens: input.cacheWriteTokens,
    },
    outputTokens: undefined,
    outputTokenDetails: {
      textTokens: input.textTokens,
      reasoningTokens: input.reasoningTokens,
    },
    totalTokens: undefined,
  };
}

describe("detailsFromUsage", () => {
  it("returns undefined for undefined usage", () => {
    expect(detailsFromUsage(undefined)).toBeUndefined();
  });

  it("returns undefined when all five members are undefined (absent ≠ zero)", () => {
    expect(detailsFromUsage(usage())).toBeUndefined();
  });

  it("returns only the defined members when some are present (anthropic-shaped)", () => {
    const details = detailsFromUsage(
      usage({
        noCacheTokens: 500,
        cacheReadTokens: 11900,
        cacheWriteTokens: 0,
        reasoningTokens: 140,
      }),
    );
    expect(details).toEqual({
      noCacheTokens: 500,
      cacheReadTokens: 11900,
      cacheWriteTokens: 0,
      reasoningTokens: 140,
    });
    expect(details && "textTokens" in details).toBe(false);
  });

  it("returns all five when the provider reports everything", () => {
    const details = detailsFromUsage(
      usage({
        noCacheTokens: 100,
        cacheReadTokens: 200,
        cacheWriteTokens: 300,
        textTokens: 40,
        reasoningTokens: 60,
      }),
    );
    expect(details).toEqual({
      noCacheTokens: 100,
      cacheReadTokens: 200,
      cacheWriteTokens: 300,
      textTokens: 40,
      reasoningTokens: 60,
    });
  });

  it("only textTokens present (V2→V3 shim shape) still returns an object", () => {
    const details = detailsFromUsage(usage({ textTokens: 25 }));
    expect(details).toEqual({ textTokens: 25 });
  });
});

describe("mergeUsageDetails", () => {
  it("undefined + undefined = undefined", () => {
    expect(mergeUsageDetails(undefined, undefined)).toBeUndefined();
  });

  it("undefined + defined = defined (passthrough)", () => {
    const b: ReturnType<typeof detailsFromUsage> = { cacheReadTokens: 10 };
    expect(mergeUsageDetails(undefined, b)).toEqual(b);
  });

  it("defined + undefined = defined (passthrough)", () => {
    const a: ReturnType<typeof detailsFromUsage> = { reasoningTokens: 5 };
    expect(mergeUsageDetails(a, undefined)).toEqual(a);
  });

  it("sums each field independently, treating undefined as 0 (mirrors ai's addTokenCounts)", () => {
    const merged = mergeUsageDetails(
      { noCacheTokens: 10, cacheReadTokens: 20 },
      { noCacheTokens: 5, reasoningTokens: 3 },
    );
    expect(merged).toEqual({ noCacheTokens: 15, cacheReadTokens: 20, reasoningTokens: 3 });
  });

  it("a field undefined on both sides stays undefined after merge, not zero", () => {
    const merged = mergeUsageDetails({ cacheReadTokens: 1 }, { cacheWriteTokens: 2 });
    expect(merged).toEqual({ cacheReadTokens: 1, cacheWriteTokens: 2 });
    expect(merged && "textTokens" in merged).toBe(false);
    expect(merged && "reasoningTokens" in merged).toBe(false);
  });

  it("returns undefined when both sides have only-undefined members (all-absent merge)", () => {
    expect(mergeUsageDetails(detailsFromUsage(usage()), detailsFromUsage(usage()))).toBeUndefined();
  });
});

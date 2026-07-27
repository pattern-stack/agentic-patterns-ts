/**
 * Tests for the model capability map (#390).
 *
 * Covers:
 *   - the Zod honesty invariant (BOTH directions, plus the `lastVerified`
 *     enforcement Gate 1.5 review note 1 added)
 *   - the `reasoningEffort` tri-state disambiguation (review note 2)
 *   - the `inputExamples` docs/unverified-only restriction (review note 3)
 *   - longest-prefix lookup + `bareModelId` parity with the pre-#390
 *     gateway-prefix / `:`-version stripping (the exact id-parsing cases
 *     `modelSupportsToolsWithStructuredOutput` handled)
 *   - `adviseStructuredRun`'s once-per-key advisory behavior
 */

import { afterEach, describe, expect, it } from "vitest";

import {
  CapabilityValueSchema,
  MODEL_CAPABILITIES,
  ModelCapabilitiesSchema,
  ReasoningEffortCapabilitySchema,
  adviseStructuredRun,
  adviseStructuredRunFor,
  bareModelId,
  getModelCapabilities,
  resetAdvisoryWarningsForTests,
} from "../capabilities.js";
import type { ModelCapabilities } from "../capabilities.js";

afterEach(() => {
  resetAdvisoryWarningsForTests();
});

// ---------------------------------------------------------------------------
// CapabilityValueSchema — the honesty invariant
// ---------------------------------------------------------------------------

describe("CapabilityValueSchema honesty invariant", () => {
  it("accepts a verified 'yes' with a lastVerified date", () => {
    expect(() =>
      CapabilityValueSchema.parse({
        support: "yes",
        verifiedBy: "docs",
        lastVerified: "2026-01-01",
      }),
    ).not.toThrow();
  });

  it("accepts a verified 'no' with a lastVerified date", () => {
    expect(() =>
      CapabilityValueSchema.parse({
        support: "no",
        verifiedBy: "probe",
        lastVerified: "2026-01-01",
      }),
    ).not.toThrow();
  });

  it("accepts an honest unverified/unknown pair with no lastVerified", () => {
    expect(() =>
      CapabilityValueSchema.parse({ support: "unknown", verifiedBy: "unverified" }),
    ).not.toThrow();
  });

  it("REJECTS support:'yes' + verifiedBy:'unverified' (claimed yes with no evidence)", () => {
    expect(() =>
      CapabilityValueSchema.parse({ support: "yes", verifiedBy: "unverified" }),
    ).toThrow();
  });

  it("REJECTS support:'unknown' + verifiedBy:'docs' (evidence claimed for an unknown)", () => {
    expect(() =>
      CapabilityValueSchema.parse({
        support: "unknown",
        verifiedBy: "docs",
        lastVerified: "2026-01-01",
      }),
    ).toThrow();
  });

  it("REJECTS a verified 'yes' with no lastVerified (Gate 1.5 review note 1)", () => {
    expect(() => CapabilityValueSchema.parse({ support: "yes", verifiedBy: "docs" })).toThrow();
  });

  it("REJECTS a verified 'no' with no lastVerified (Gate 1.5 review note 1)", () => {
    expect(() => CapabilityValueSchema.parse({ support: "no", verifiedBy: "probe" })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// ReasoningEffortCapabilitySchema — its own honesty refine + none/unknown split
// ---------------------------------------------------------------------------

describe("ReasoningEffortCapabilitySchema (Gate 1.5 review note 2)", () => {
  it("accepts support:'no' + levels:[] — verified: no reasoning knob", () => {
    expect(() =>
      ReasoningEffortCapabilitySchema.parse({
        support: "no",
        levels: [],
        verifiedBy: "docs",
        lastVerified: "2026-01-01",
      }),
    ).not.toThrow();
  });

  it("accepts support:'unknown' + levels:[] — unverified, distinct from 'no'", () => {
    expect(() =>
      ReasoningEffortCapabilitySchema.parse({
        support: "unknown",
        levels: [],
        verifiedBy: "unverified",
      }),
    ).not.toThrow();
  });

  it("accepts support:'yes' + a populated levels array", () => {
    expect(() =>
      ReasoningEffortCapabilitySchema.parse({
        support: "yes",
        levels: ["low", "medium", "high"],
        verifiedBy: "docs",
        lastVerified: "2026-01-01",
      }),
    ).not.toThrow();
  });

  it("REJECTS support:'yes' with an empty levels array (no evidence of ANY level)", () => {
    expect(() =>
      ReasoningEffortCapabilitySchema.parse({
        support: "yes",
        levels: [],
        verifiedBy: "docs",
        lastVerified: "2026-01-01",
      }),
    ).toThrow();
  });

  it("REJECTS support:'no' with a non-empty levels array (contradiction)", () => {
    expect(() =>
      ReasoningEffortCapabilitySchema.parse({
        support: "no",
        levels: ["low"],
        verifiedBy: "docs",
        lastVerified: "2026-01-01",
      }),
    ).toThrow();
  });

  it("REJECTS the honesty-invariant violation support:'unknown' + verifiedBy:'docs'", () => {
    expect(() =>
      ReasoningEffortCapabilitySchema.parse({
        support: "unknown",
        levels: [],
        verifiedBy: "docs",
        lastVerified: "2026-01-01",
      }),
    ).toThrow();
  });

  it("REJECTS a verified support:'no' with no lastVerified", () => {
    expect(() =>
      ReasoningEffortCapabilitySchema.parse({ support: "no", levels: [], verifiedBy: "docs" }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// inputExamples — docs/unverified-only (Gate 1.5 review note 3)
// ---------------------------------------------------------------------------

describe("ModelCapabilitiesSchema — inputExamples probe restriction", () => {
  const baseRow = {
    provider: "openai" as const,
    match: "some-test-family",
    structuredOutput: { support: "unknown" as const, verifiedBy: "unverified" as const },
    strictSchemaMode: { support: "unknown" as const, verifiedBy: "unverified" as const },
    toolsWithStructuredOutput: { support: "unknown" as const, verifiedBy: "unverified" as const },
    reasoningEffort: { support: "unknown" as const, levels: [], verifiedBy: "unverified" as const },
  };

  it("accepts inputExamples with verifiedBy:'unverified'", () => {
    expect(() =>
      ModelCapabilitiesSchema.parse({
        ...baseRow,
        inputExamples: { support: "unknown", verifiedBy: "unverified" },
      }),
    ).not.toThrow();
  });

  it("accepts inputExamples with verifiedBy:'docs'", () => {
    expect(() =>
      ModelCapabilitiesSchema.parse({
        ...baseRow,
        inputExamples: { support: "yes", verifiedBy: "docs", lastVerified: "2026-01-01" },
      }),
    ).not.toThrow();
  });

  it("REJECTS inputExamples with verifiedBy:'probe' — no probe step exists yet", () => {
    expect(() =>
      ModelCapabilitiesSchema.parse({
        ...baseRow,
        inputExamples: { support: "yes", verifiedBy: "probe", lastVerified: "2026-01-01" },
      }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// MODEL_CAPABILITIES — dev-time self-validation
// ---------------------------------------------------------------------------

describe("MODEL_CAPABILITIES", () => {
  it("is frozen (array and every row)", () => {
    expect(Object.isFrozen(MODEL_CAPABILITIES)).toBe(true);
    for (const row of MODEL_CAPABILITIES) {
      expect(Object.isFrozen(row)).toBe(true);
    }
  });

  it("every row parses cleanly against ModelCapabilitiesSchema (module-load self-validation already proved this, but pin it)", () => {
    for (const row of MODEL_CAPABILITIES) {
      expect(() => ModelCapabilitiesSchema.parse(row)).not.toThrow();
    }
  });

  it("has no inputExamples row verified via 'probe' anywhere in the seed data", () => {
    for (const row of MODEL_CAPABILITIES) {
      expect(row.inputExamples.verifiedBy).not.toBe("probe");
    }
  });
});

// ---------------------------------------------------------------------------
// bareModelId — gateway-prefix / version-tag parsing parity
// ---------------------------------------------------------------------------

describe("bareModelId", () => {
  it("lowercases", () => {
    expect(bareModelId("GPT-4O")).toBe("gpt-4o");
  });

  it("strips a gateway prefix by splitting on '/' only", () => {
    expect(bareModelId("bifrost:openai/gpt-4o")).toBe("gpt-4o");
    expect(bareModelId("openai/gpt-5")).toBe("gpt-5");
  });

  it("keeps a ':'-delimited version tag attached to its family prefix (NOT split on ':')", () => {
    expect(bareModelId("gpt-4o:2024-08-06")).toBe("gpt-4o:2024-08-06");
  });
});

// ---------------------------------------------------------------------------
// getModelCapabilities — longest-prefix lookup
// ---------------------------------------------------------------------------

describe("getModelCapabilities", () => {
  it("matches gpt-4o family ids", () => {
    expect(getModelCapabilities("gpt-4o")?.match).toBe("gpt-4o");
    expect(getModelCapabilities("gpt-4o-mini")?.match).toBe("gpt-4o");
    expect(getModelCapabilities("gpt-4o-2024-08-06")?.match).toBe("gpt-4o");
  });

  it("matches through a gateway prefix and a ':'-version tag", () => {
    expect(getModelCapabilities("bifrost:openai/gpt-4o")?.match).toBe("gpt-4o");
    expect(getModelCapabilities("gpt-4o:2024-08-06")?.match).toBe("gpt-4o");
  });

  it("returns undefined for a totally unknown id — no default, no guessing", () => {
    expect(getModelCapabilities("some-brand-new-model-nobody-has-heard-of")).toBeUndefined();
  });

  it("longest-match wins for overlapping prefixes", () => {
    // "gemini-3.5-flash" (16 chars) must win over any broader "gemini-"
    // catch-all — there is no "gemini-" catch-all row today, but this pins
    // the longest-prefix contract so adding one later can't silently
    // reclassify gemini-3.5-flash.
    const entry = getModelCapabilities("gemini-3.5-flash-latest");
    expect(entry?.match).toBe("gemini-3.5-flash");
  });
});

// ---------------------------------------------------------------------------
// adviseStructuredRun — once per (model x capability)
// ---------------------------------------------------------------------------

describe("adviseStructuredRun", () => {
  it("warns once for an unmapped model, then stays silent for the same id", () => {
    const calls: unknown[][] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => {
      calls.push(args);
    };
    try {
      adviseStructuredRun("totally-unmapped-model-390-a");
      adviseStructuredRun("totally-unmapped-model-390-a");
      adviseStructuredRun("totally-unmapped-model-390-a");
    } finally {
      console.warn = original;
    }
    expect(calls).toHaveLength(1);
    expect(String(calls[0]?.[0])).toContain("unverified");
  });

  it("warns with the 'unverified' message for an unmapped id (distinct message content)", () => {
    const calls: unknown[][] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => {
      calls.push(args);
    };
    try {
      adviseStructuredRun("totally-unmapped-model-390-b");
    } finally {
      console.warn = original;
    }
    expect(calls).toHaveLength(1);
    expect(String(calls[0]?.[0])).toContain("[agentic-patterns]");
    expect(String(calls[0]?.[0])).toContain("totally-unmapped-model-390-b");
  });

  it("warns with the 'NOT supporting native structured output' message for a mapped support:'no' entry", () => {
    // None of today's seeded MODEL_CAPABILITIES rows are honestly
    // structuredOutput:"no" (DESIGN §9.5's no-tools trial passed on every
    // tested family — see capabilities.ts's module doc comment), so this
    // exercises the "no" branch's message content via
    // `adviseStructuredRunFor` against a synthetic (but schema-valid) entry,
    // rather than fabricating an unverified real-world claim in the seed
    // data just to get coverage.
    const syntheticNoEntry: ModelCapabilities = ModelCapabilitiesSchema.parse({
      provider: "openai",
      match: "synthetic-no-family",
      structuredOutput: { support: "no", verifiedBy: "docs", lastVerified: "2026-01-01" },
      strictSchemaMode: { support: "unknown", verifiedBy: "unverified" },
      toolsWithStructuredOutput: { support: "unknown", verifiedBy: "unverified" },
      inputExamples: { support: "unknown", verifiedBy: "unverified" },
      reasoningEffort: { support: "unknown", levels: [], verifiedBy: "unverified" },
    });

    const calls: unknown[][] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => {
      calls.push(args);
    };
    try {
      adviseStructuredRunFor("synthetic-no-family-v1", syntheticNoEntry);
    } finally {
      console.warn = original;
    }
    expect(calls).toHaveLength(1);
    expect(String(calls[0]?.[0])).toContain("NOT supporting native structured output");
    expect(String(calls[0]?.[0])).toContain("docs");
    expect(String(calls[0]?.[0])).toContain("2026-01-01");
  });

  it("resetAdvisoryWarningsForTests() clears the memory so the same id can warn again", () => {
    const calls: unknown[][] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => {
      calls.push(args);
    };
    try {
      adviseStructuredRun("totally-unmapped-model-390-c");
      resetAdvisoryWarningsForTests();
      adviseStructuredRun("totally-unmapped-model-390-c");
    } finally {
      console.warn = original;
    }
    expect(calls).toHaveLength(2);
  });
});

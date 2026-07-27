/**
 * Tests for the model capability map (#390).
 *
 * Covers:
 *   - the Zod honesty invariant (BOTH directions, plus the `lastVerified`
 *     enforcement Gate 1.5 review note 1 added)
 *   - the `reasoningEffort` tri-state disambiguation (review note 2)
 *   - the `inputExamples` docs/unverified-only restriction (review note 3)
 *   - `match` lowercase enforcement (Gate 2.5 quality-review note — a
 *     future uppercase `match` would silently never match, since
 *     `bareModelId()` lowercases the lookup input)
 *   - longest-prefix lookup + `bareModelId` parity with the pre-#390
 *     gateway-prefix / `:`-version stripping (the exact id-parsing cases
 *     `modelSupportsToolsWithStructuredOutput` handled)
 *   - `adviseStructuredRun`'s once-per-key advisory behavior, re-keyed
 *     (Gate 2.5 quality-review note) to consult `toolsWithStructuredOutput`
 *     when tools are present (the capability that actually governs the
 *     single-call-vs-2-tier path) and `structuredOutput` otherwise
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
    expect(() => CapabilityValueSchema.parse({ support: "yes", verifiedBy: "unverified" })).toThrow(
      /honesty invariant/,
    );
  });

  it("REJECTS support:'unknown' + verifiedBy:'docs' (evidence claimed for an unknown)", () => {
    expect(() =>
      CapabilityValueSchema.parse({
        support: "unknown",
        verifiedBy: "docs",
        lastVerified: "2026-01-01",
      }),
    ).toThrow(/honesty invariant/);
  });

  it("REJECTS a verified 'yes' with no lastVerified (Gate 1.5 review note 1) — the lastVerified refine, not the honesty one, fires", () => {
    expect(() => CapabilityValueSchema.parse({ support: "yes", verifiedBy: "docs" })).toThrow(
      /lastVerified is required/,
    );
  });

  it("REJECTS a verified 'no' with no lastVerified (Gate 1.5 review note 1) — the lastVerified refine, not the honesty one, fires", () => {
    expect(() => CapabilityValueSchema.parse({ support: "no", verifiedBy: "probe" })).toThrow(
      /lastVerified is required/,
    );
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
    ).toThrow(/requires at least one entry/);
  });

  it("REJECTS support:'no' with a non-empty levels array (contradiction)", () => {
    expect(() =>
      ReasoningEffortCapabilitySchema.parse({
        support: "no",
        levels: ["low"],
        verifiedBy: "docs",
        lastVerified: "2026-01-01",
      }),
    ).toThrow(/must carry an empty levels array/);
  });

  it("REJECTS the honesty-invariant violation support:'unknown' + verifiedBy:'docs'", () => {
    expect(() =>
      ReasoningEffortCapabilitySchema.parse({
        support: "unknown",
        levels: [],
        verifiedBy: "docs",
        lastVerified: "2026-01-01",
      }),
    ).toThrow(/honesty invariant/);
  });

  it("REJECTS a verified support:'no' with no lastVerified", () => {
    expect(() =>
      ReasoningEffortCapabilitySchema.parse({ support: "no", levels: [], verifiedBy: "docs" }),
    ).toThrow(/lastVerified is required/);
  });
});

// ---------------------------------------------------------------------------
// ModelCapabilitiesSchema.match — lowercase enforcement (Gate 2.5 quality note)
// ---------------------------------------------------------------------------

describe("ModelCapabilitiesSchema.match lowercase enforcement", () => {
  const baseCapability = { support: "unknown" as const, verifiedBy: "unverified" as const };
  const baseRow = {
    provider: "xai" as const,
    structuredOutput: baseCapability,
    strictSchemaMode: baseCapability,
    toolsWithStructuredOutput: baseCapability,
    inputExamples: baseCapability,
    reasoningEffort: { support: "unknown" as const, levels: [], verifiedBy: "unverified" as const },
  };

  it("accepts a lowercase match", () => {
    expect(() => ModelCapabilitiesSchema.parse({ ...baseRow, match: "grok-5" })).not.toThrow();
  });

  it("REJECTS an uppercase match — bareModelId() lowercases the lookup input, so this would silently never match", () => {
    expect(() => ModelCapabilitiesSchema.parse({ ...baseRow, match: "Grok-5" })).toThrow(
      /match must be lowercase/,
    );
  });

  it("REJECTS a mixed-case match", () => {
    expect(() => ModelCapabilitiesSchema.parse({ ...baseRow, match: "Grok-5-Mini" })).toThrow(
      /match must be lowercase/,
    );
  });

  it("every seeded MODEL_CAPABILITIES row has a lowercase match", () => {
    for (const row of MODEL_CAPABILITIES) {
      expect(row.match).toBe(row.match.toLowerCase());
    }
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
  /** Capture console.warn calls for the duration of `fn`, then restore it. */
  function captureWarnings(fn: () => void): unknown[][] {
    const calls: unknown[][] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => {
      calls.push(args);
    };
    try {
      fn();
    } finally {
      console.warn = original;
    }
    return calls;
  }

  it("warns once for an unmapped model (tools present), then stays silent for the same id", () => {
    const calls = captureWarnings(() => {
      adviseStructuredRun("totally-unmapped-model-390-a", true);
      adviseStructuredRun("totally-unmapped-model-390-a", true);
      adviseStructuredRun("totally-unmapped-model-390-a", true);
    });
    expect(calls).toHaveLength(1);
    expect(String(calls[0]?.[0])).toContain("toolsWithStructuredOutput is unverified");
  });

  it("warns once for an unmapped model (no tools) — keys off structuredOutput instead", () => {
    const calls = captureWarnings(() => {
      adviseStructuredRun("totally-unmapped-model-390-b", false);
      adviseStructuredRun("totally-unmapped-model-390-b", false);
    });
    expect(calls).toHaveLength(1);
    expect(String(calls[0]?.[0])).toContain("structuredOutput is unverified");
  });

  it("hasTools:true and hasTools:false are tracked as DISTINCT keys for the same model id — both can warn", () => {
    const calls = captureWarnings(() => {
      adviseStructuredRun("totally-unmapped-model-390-both", true);
      adviseStructuredRun("totally-unmapped-model-390-both", false);
    });
    expect(calls).toHaveLength(2);
    expect(String(calls[0]?.[0])).toContain("toolsWithStructuredOutput is unverified");
    expect(String(calls[1]?.[0])).toContain("structuredOutput is unverified");
  });

  it("REAL SEED DATA, tools present: claude- warns about the single-call round-trip (Gate 2.5 fix — this branch was previously dead)", () => {
    // Before the re-key, this branch only fired when `structuredOutput` was
    // "no" — no seeded row is honestly structuredOutput:"no", so it never
    // fired against real data. claude-'s `toolsWithStructuredOutput` IS
    // verified "no" (DESIGN §9.5), and a tools-bearing run genuinely takes
    // the 2-tier fallback because of exactly that field — so this is the
    // real-data case the advisory exists to cover.
    const calls = captureWarnings(() => {
      adviseStructuredRun("claude-sonnet-4-5", true);
    });
    expect(calls).toHaveLength(1);
    expect(String(calls[0]?.[0])).toContain(
      "NOT supporting the single-call tools+structured-output round-trip",
    );
    expect(String(calls[0]?.[0])).toContain("probe");
  });

  it("REAL SEED DATA, tools present: gemini-2.5- also warns (not a claude-only special case)", () => {
    const calls = captureWarnings(() => {
      adviseStructuredRun("gemini-2.5-flash", true);
    });
    expect(calls).toHaveLength(1);
    expect(String(calls[0]?.[0])).toContain(
      "NOT supporting the single-call tools+structured-output round-trip",
    );
  });

  it("REAL SEED DATA, NO tools: claude- stays silent — structuredOutput itself is verified 'yes', so the no-tools path is fine", () => {
    const calls = captureWarnings(() => {
      adviseStructuredRun("claude-sonnet-4-5", false);
    });
    expect(calls).toHaveLength(0);
  });

  it("REAL SEED DATA, tools present: gpt-4o stays silent — toolsWithStructuredOutput is verified 'yes' (single-call path, no fallback)", () => {
    const calls = captureWarnings(() => {
      adviseStructuredRun("gpt-4o", true);
    });
    expect(calls).toHaveLength(0);
  });

  it("warns with the 'NOT supporting native structured output' message for a synthetic no-tools support:'no' entry", () => {
    // No seeded row is honestly structuredOutput:"no" (DESIGN §9.5's
    // no-tools trial passed on every tested family), so the NO-TOOLS "no"
    // branch specifically still needs a synthetic fixture; the TOOLS "no"
    // branch is covered against real data above.
    const syntheticNoEntry: ModelCapabilities = ModelCapabilitiesSchema.parse({
      provider: "openai",
      match: "synthetic-no-family",
      structuredOutput: { support: "no", verifiedBy: "docs", lastVerified: "2026-01-01" },
      strictSchemaMode: { support: "unknown", verifiedBy: "unverified" },
      toolsWithStructuredOutput: { support: "unknown", verifiedBy: "unverified" },
      inputExamples: { support: "unknown", verifiedBy: "unverified" },
      reasoningEffort: { support: "unknown", levels: [], verifiedBy: "unverified" },
    });

    const calls = captureWarnings(() => {
      adviseStructuredRunFor("synthetic-no-family-v1", syntheticNoEntry, false);
    });
    expect(calls).toHaveLength(1);
    expect(String(calls[0]?.[0])).toContain("NOT supporting native structured output");
    expect(String(calls[0]?.[0])).toContain("docs");
    expect(String(calls[0]?.[0])).toContain("2026-01-01");
  });

  it("resetAdvisoryWarningsForTests() clears the memory so the same id can warn again", () => {
    const calls = captureWarnings(() => {
      adviseStructuredRun("totally-unmapped-model-390-c", true);
      resetAdvisoryWarningsForTests();
      adviseStructuredRun("totally-unmapped-model-390-c", true);
    });
    expect(calls).toHaveLength(2);
  });
});

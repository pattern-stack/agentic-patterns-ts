/**
 * Model capability map — Zod-schema'd, per-model-family knowledge of which
 * V4 SDK-level knobs a model actually honors (#390).
 *
 * WHY THIS EXISTS: the runtime's only prior capability knowledge was one
 * hardcoded boolean, `modelSupportsToolsWithStructuredOutput()`
 * (`runner/agent-runner.ts`) — three prefix checks answering exactly one
 * question. Everything else the runtime might want to know (native
 * structured output at all, `strict` json-schema mode, tool
 * `inputExamples`, reasoning-effort levels) was unrepresented. This module
 * replaces that scattered knowledge with one exported map, consulted by
 * `runStructured()` for advisory warnings (never for correctness — the
 * 2-tier fallback in `agent-runner.ts` stays the always-correct path).
 *
 * THE DEFINING PROPERTY — every capability value carries provenance
 * (`verifiedBy: docs | probe | unverified`), Zod-enforced so an unknown is
 * always an explicit `"unknown"`, never a guessed boolean:
 *
 *   - `support === "unknown"` iff `verifiedBy === "unverified"` (the
 *     honesty invariant, {@link CapabilityValueSchema}).
 *   - `lastVerified` is required whenever `verifiedBy !== "unverified"`
 *     (Gate 1.5 review note 1 — the first cut of this refine only enforced
 *     the biconditional above and let a dateless "verified" entry through).
 *   - `reasoningEffort` gets its OWN honesty refine plus a tri-state
 *     `support`, so "no reasoning support" (`support:"no"`, `levels:[]`)
 *     and "unverified" (`support:"unknown"`, `levels:[]`) are distinct
 *     representations instead of both collapsing to an overloaded `[]`
 *     (Gate 1.5 review note 2).
 *   - `inputExamples` has no probe step in `scripts/probe-capabilities.mjs`
 *     yet — "honored vs silently stripped" isn't cleanly detectable from a
 *     single call the way tools+structured-output and strict-mode-400 are.
 *     Until a real probe exists, `inputExamples.verifiedBy` is schema-
 *     restricted to `"docs"` / `"unverified"` (Gate 1.5 review note 3).
 *
 * See `.ai-docs/stacks/ai-sdk-v7/specs/390.md` for the full design (D1-D5)
 * and the Gate 1.5 spec review this file's refines fold in.
 */

import { z } from "zod";

// Import from the leaf `types.ts` module (not `./model-resolver.js`, which
// itself imports `./index.js` — going through model-resolver here would
// create a providers/index.ts -> capabilities.ts -> model-resolver.ts ->
// index.ts import cycle). `SUPPORTED_PROVIDERS` is the same runtime array
// `model-resolver.ts`'s `PROFILE_PROVIDERS` re-exports.
import { SUPPORTED_PROVIDERS } from "./types.js";

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

/** How a capability value was established. `"unverified"` is the only
 *  honest spelling for "we don't know" — see the honesty invariant below. */
export const VerificationSchema = z.enum(["docs", "probe", "unverified"]);
export type Verification = z.infer<typeof VerificationSchema>;

/** Whether a model supports a capability. `"unknown"` pairs 1:1 with
 *  `verifiedBy: "unverified"` (schema-enforced, not just documented). */
export const SupportSchema = z.enum(["yes", "no", "unknown"]);
export type Support = z.infer<typeof SupportSchema>;

/**
 * V4 `CallOptions.reasoning` vocabulary, verified against the published
 * typings (`@ai-sdk/provider@4.0.3` `dist/index.d.ts:2166`:
 * `reasoning?: 'provider-default' | 'none' | 'minimal' | 'low' | 'medium' |
 * 'high' | 'xhigh'`), minus `"provider-default"` — that spelling is a
 * *request* value ("do whatever the model defaults to"), not something a
 * model can be said to "support".
 */
export const ReasoningEffortLevelSchema = z.enum([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);
export type ReasoningEffortLevel = z.infer<typeof ReasoningEffortLevelSchema>;

// ---------------------------------------------------------------------------
// CapabilityValueSchema — the honesty invariant
// ---------------------------------------------------------------------------

const HONESTY_MESSAGE =
  "honesty invariant violated: support:'unknown' must pair with verifiedBy:'unverified' (and vice " +
  "versa) — a claimed yes/no must cite evidence, and an unverified entry must say 'unknown', never " +
  "a guessed boolean.";

const LAST_VERIFIED_MESSAGE =
  "lastVerified is required whenever verifiedBy !== 'unverified' — a claimed yes/no must also name " +
  "the date it was checked, or the claim isn't reviewable evidence (Gate 1.5 review note 1).";

/**
 * One provenance-carrying capability value. Two refines enforce the honesty
 * contract:
 *   1. `support === "unknown"` iff `verifiedBy === "unverified"`.
 *   2. `lastVerified` is required whenever `verifiedBy !== "unverified"`.
 */
export const CapabilityValueSchema = z
  .object({
    support: SupportSchema,
    verifiedBy: VerificationSchema,
    /** ISO date (YYYY-MM-DD). Required when verifiedBy !== "unverified". */
    lastVerified: z.string().optional(),
    /** Free-text provenance detail — package@version, docs URL, DESIGN.md
     *  section, etc. Encouraged but not required. */
    note: z.string().optional(),
  })
  .strict()
  .refine((v) => (v.support === "unknown") === (v.verifiedBy === "unverified"), {
    message: HONESTY_MESSAGE,
  })
  .refine((v) => v.verifiedBy === "unverified" || v.lastVerified != null, {
    message: LAST_VERIFIED_MESSAGE,
  });
export type CapabilityValue = z.infer<typeof CapabilityValueSchema>;

/** A fully-unverified capability value — the honest default for anything
 *  not yet checked. Shared by every row below that has no evidence yet. */
const UNVERIFIED: CapabilityValue = CapabilityValueSchema.parse({
  support: "unknown",
  verifiedBy: "unverified",
});

// ---------------------------------------------------------------------------
// ReasoningEffortCapabilitySchema — its own honesty refine (review note 2)
// ---------------------------------------------------------------------------

/**
 * Reasoning-effort support is richer than a boolean: a model can support a
 * SET of levels. The first cut of this schema had no `support` field at
 * all, so `levels: []` was overloaded to mean both "verified — this model
 * has no reasoning knob" and "unverified — we haven't checked", which are
 * very different claims (Gate 1.5 review note 2). This schema adds a
 * tri-state `support` mirroring {@link CapabilityValueSchema} so the two
 * are distinct:
 *   - `support: "no"`      + `levels: []`    — verified: no reasoning knob.
 *   - `support: "unknown"` + `levels: []`    — unverified.
 *   - `support: "yes"`     + `levels: [...]` — verified: these levels work.
 */
export const ReasoningEffortCapabilitySchema = z
  .object({
    support: SupportSchema,
    levels: z.array(ReasoningEffortLevelSchema),
    verifiedBy: VerificationSchema,
    lastVerified: z.string().optional(),
    note: z.string().optional(),
  })
  .strict()
  .refine((v) => (v.support === "unknown") === (v.verifiedBy === "unverified"), {
    message: HONESTY_MESSAGE,
  })
  .refine((v) => v.verifiedBy === "unverified" || v.lastVerified != null, {
    message: LAST_VERIFIED_MESSAGE,
  })
  .refine((v) => v.support !== "yes" || v.levels.length > 0, {
    message: "support:'yes' requires at least one entry in levels",
  })
  .refine((v) => v.support === "yes" || v.levels.length === 0, {
    message:
      "support:'no' or 'unknown' must carry an empty levels array — list levels only under support:'yes'",
  });
export type ReasoningEffortCapability = z.infer<typeof ReasoningEffortCapabilitySchema>;

/** A fully-unverified reasoning-effort value. */
const UNVERIFIED_REASONING: ReasoningEffortCapability = ReasoningEffortCapabilitySchema.parse({
  support: "unknown",
  levels: [],
  verifiedBy: "unverified",
});

// ---------------------------------------------------------------------------
// ModelCapabilitiesSchema
// ---------------------------------------------------------------------------

export const ModelCapabilitiesSchema = z
  .object({
    provider: z.enum(SUPPORTED_PROVIDERS),
    /** Bare-id prefix (post {@link bareModelId} normalization). Longest
     *  match wins, so e.g. "gpt-4o" beats a hypothetical "gpt-" entry. */
    match: z.string().min(1),
    /** Native json-schema response_format / `Output.object` without tools. */
    structuredOutput: CapabilityValueSchema,
    /** `strict` json-schema enforcement (tool + response_format). */
    strictSchemaMode: CapabilityValueSchema,
    /** Single-call tools + `Output.object` round-trip (subsumes the pre-#390
     *  `modelSupportsToolsWithStructuredOutput` table). */
    toolsWithStructuredOutput: CapabilityValueSchema,
    /** Tool `inputExamples` honored (not silently stripped). No probe step
     *  exists yet — see the module doc comment and review note 3. */
    inputExamples: CapabilityValueSchema,
    reasoningEffort: ReasoningEffortCapabilitySchema,
  })
  .strict()
  .refine((v) => v.inputExamples.verifiedBy !== "probe", {
    message:
      "inputExamples has no probe step in scripts/probe-capabilities.mjs yet (Gate 1.5 review note " +
      "3) — verifiedBy must be 'docs' or 'unverified' until a real probe exists to justify 'probe'.",
  });
export type ModelCapabilities = z.infer<typeof ModelCapabilitiesSchema>;

// ---------------------------------------------------------------------------
// bareModelId — shared id normalization
// ---------------------------------------------------------------------------

/**
 * Normalize a resolved model id for family matching: lowercase, and strip
 * any gateway/provider prefix (e.g. "bifrost:openai/gpt-4o" → "gpt-4o",
 * "openai/gpt-5" → "gpt-5"). Split on "/" ONLY — never ":" — so a version
 * tag like "gpt-4o:2024-08-06" keeps its family prefix instead of
 * collapsing to the version. This exact subtlety previously lived inline in
 * `modelSupportsToolsWithStructuredOutput` (`runner/agent-runner.ts`); it
 * now has one copy here, and that function delegates to it.
 */
export function bareModelId(modelId: string): string {
  const id = modelId.toLowerCase();
  return id.split("/").pop() ?? id;
}

// ---------------------------------------------------------------------------
// MODEL_CAPABILITIES — the seeded data
// ---------------------------------------------------------------------------

/**
 * The calendar date the DESIGN-§9.5-sourced rows below were TRANSCRIBED into
 * this schema'd map — NOT a live-probe date. No live probes have been run
 * for #390 (no provider API keys are available in this container; see
 * `scripts/probe-capabilities.mjs`, whose keyless path degrades every
 * unset-key provider to `unverified`/`unknown`).
 *
 * Provenance (Gate 1.5 review note 4): `.ai-docs/patternstack/DESIGN.md`
 * §"9.5 Empirical validation (trial harness)" records the original
 * empirical trial that seeded the pre-#390 hardcoded
 * `modelSupportsToolsWithStructuredOutput` table — verified live through a
 * gateway via two throwaway harnesses (`structured-output-trial.ts`,
 * `two-tier-fallback-trial.ts`). That section's prose carries no calendar
 * date of its own, so `lastVerified` below records the date of THIS
 * transcription (today), not the original trial's run date; the `note` on
 * each transcribed row cites DESIGN §9.5 as the evidence source.
 */
const DESIGN_9_5_TRANSCRIPTION_DATE = "2026-07-27";

const DESIGN_9_5_STRUCTURED_NOTE =
  "DESIGN.md §9.5: no-tools Output.object PASS in the original empirical trial.";
const DESIGN_9_5_TOOLS_YES_NOTE =
  "DESIGN.md §9.5: single-call tools+structured PASS (pre-#390 hardcoded table entry).";
const DESIGN_9_5_TOOLS_NO_NOTE =
  "DESIGN.md §9.5: single-call tools+structured FAIL → 2-tier fallback (pre-#390 hardcoded table).";

// Raw (pre-parse) rows — typed loosely so the parse/freeze step below is the
// single source of validation truth (dev-time self-validation at module load).
type RawModelCapabilities = z.input<typeof ModelCapabilitiesSchema>;

const RAW_MODEL_CAPABILITIES: readonly RawModelCapabilities[] = [
  // --- openai --------------------------------------------------------------
  {
    provider: "openai",
    match: "gpt-4o",
    structuredOutput: {
      support: "yes",
      verifiedBy: "probe",
      lastVerified: DESIGN_9_5_TRANSCRIPTION_DATE,
      note: DESIGN_9_5_STRUCTURED_NOTE,
    },
    strictSchemaMode: UNVERIFIED,
    toolsWithStructuredOutput: {
      support: "yes",
      verifiedBy: "probe",
      lastVerified: DESIGN_9_5_TRANSCRIPTION_DATE,
      note: DESIGN_9_5_TOOLS_YES_NOTE,
    },
    inputExamples: UNVERIFIED,
    reasoningEffort: UNVERIFIED_REASONING,
  },
  {
    provider: "openai",
    match: "gpt-5",
    structuredOutput: {
      support: "yes",
      verifiedBy: "probe",
      lastVerified: DESIGN_9_5_TRANSCRIPTION_DATE,
      note: DESIGN_9_5_STRUCTURED_NOTE,
    },
    strictSchemaMode: UNVERIFIED,
    toolsWithStructuredOutput: {
      support: "yes",
      verifiedBy: "probe",
      lastVerified: DESIGN_9_5_TRANSCRIPTION_DATE,
      note: DESIGN_9_5_TOOLS_YES_NOTE,
    },
    inputExamples: UNVERIFIED,
    reasoningEffort: UNVERIFIED_REASONING,
  },
  {
    // OpenAI's o-series/reasoning family — not covered by the DESIGN §9.5
    // trial (which tested gpt-4o/gpt-5 only). Present so the runtime has an
    // explicit "we haven't checked this family yet" row instead of silently
    // falling through to `undefined`.
    provider: "openai",
    match: "o4-",
    structuredOutput: UNVERIFIED,
    strictSchemaMode: UNVERIFIED,
    toolsWithStructuredOutput: UNVERIFIED,
    inputExamples: UNVERIFIED,
    reasoningEffort: UNVERIFIED_REASONING,
  },

  // --- anthropic -------------------------------------------------------------
  {
    provider: "anthropic",
    match: "claude-",
    structuredOutput: {
      support: "yes",
      verifiedBy: "probe",
      lastVerified: DESIGN_9_5_TRANSCRIPTION_DATE,
      note: `${DESIGN_9_5_STRUCTURED_NOTE} Verified on native claude-sonnet-4-5; generalized to the claude- family.`,
    },
    strictSchemaMode: UNVERIFIED,
    toolsWithStructuredOutput: {
      support: "no",
      verifiedBy: "probe",
      lastVerified: DESIGN_9_5_TRANSCRIPTION_DATE,
      note:
        "DESIGN.md §9.5: single-call tools+structured FAIL on native claude-sonnet-4-5 — the SDK " +
        'warns "JSON response format does not support tools. The provided tools are ignored." ' +
        "Native Anthropic json response format is mutually exclusive with tool use. Verified on " +
        "sonnet-4-5 specifically; generalized to the claude- family (same SDK-level constraint).",
    },
    inputExamples: UNVERIFIED,
    reasoningEffort: UNVERIFIED_REASONING,
  },

  // --- google ----------------------------------------------------------------
  {
    provider: "google",
    match: "gemini-2.5-",
    structuredOutput: {
      support: "yes",
      verifiedBy: "probe",
      lastVerified: DESIGN_9_5_TRANSCRIPTION_DATE,
      note: `${DESIGN_9_5_STRUCTURED_NOTE} Covers gemini-2.5-pro and gemini-2.5-flash.`,
    },
    strictSchemaMode: UNVERIFIED,
    toolsWithStructuredOutput: {
      support: "no",
      verifiedBy: "probe",
      lastVerified: DESIGN_9_5_TRANSCRIPTION_DATE,
      note: `${DESIGN_9_5_TOOLS_NO_NOTE} Covers gemini-2.5-pro and gemini-2.5-flash.`,
    },
    inputExamples: UNVERIFIED,
    reasoningEffort: UNVERIFIED_REASONING,
  },
  {
    provider: "google",
    match: "gemini-3.1-flash-lite",
    structuredOutput: {
      support: "yes",
      verifiedBy: "probe",
      lastVerified: DESIGN_9_5_TRANSCRIPTION_DATE,
      note: DESIGN_9_5_STRUCTURED_NOTE,
    },
    strictSchemaMode: UNVERIFIED,
    toolsWithStructuredOutput: {
      support: "no",
      verifiedBy: "probe",
      lastVerified: DESIGN_9_5_TRANSCRIPTION_DATE,
      note: `${DESIGN_9_5_TOOLS_NO_NOTE} This is DESIGN §9.5's load-bearing 2-tier-fallback proof model.`,
    },
    inputExamples: UNVERIFIED,
    reasoningEffort: UNVERIFIED_REASONING,
  },
  {
    provider: "google",
    match: "gemini-3.5-flash",
    structuredOutput: {
      support: "yes",
      verifiedBy: "probe",
      lastVerified: DESIGN_9_5_TRANSCRIPTION_DATE,
      note: DESIGN_9_5_STRUCTURED_NOTE,
    },
    strictSchemaMode: UNVERIFIED,
    toolsWithStructuredOutput: {
      support: "yes",
      verifiedBy: "probe",
      lastVerified: DESIGN_9_5_TRANSCRIPTION_DATE,
      note: DESIGN_9_5_TOOLS_YES_NOTE,
    },
    inputExamples: UNVERIFIED,
    reasoningEffort: UNVERIFIED_REASONING,
  },

  // --- xai / deepseek / mistral (not in the DESIGN §9.5 trial) ----------------
  {
    provider: "xai",
    match: "grok-4",
    structuredOutput: UNVERIFIED,
    strictSchemaMode: UNVERIFIED,
    toolsWithStructuredOutput: UNVERIFIED,
    inputExamples: UNVERIFIED,
    reasoningEffort: UNVERIFIED_REASONING,
  },
  {
    provider: "deepseek",
    match: "deepseek-reasoner",
    structuredOutput: UNVERIFIED,
    strictSchemaMode: UNVERIFIED,
    toolsWithStructuredOutput: UNVERIFIED,
    inputExamples: UNVERIFIED,
    reasoningEffort: UNVERIFIED_REASONING,
  },
  {
    provider: "mistral",
    match: "mistral-large",
    structuredOutput: UNVERIFIED,
    strictSchemaMode: UNVERIFIED,
    toolsWithStructuredOutput: UNVERIFIED,
    inputExamples: UNVERIFIED,
    reasoningEffort: UNVERIFIED_REASONING,
  },

  // --- groq / ollama tier defaults ("the ids the runtime actually
  // dispatches by default", D1) — OpenRouter's tier default
  // ("anthropic/claude-*") is deliberately NOT a separate row here: after
  // `bareModelId()` strips the "anthropic/" segment it falls through to the
  // `claude-` row above, which is the correct behavior for that specific
  // pinned route. Any OTHER openrouter upstream id (the (route × upstream)
  // case the spec calls out) matches no row and gets the honest
  // undefined -> "unknown, take the conservative path" advisory. ------------
  {
    provider: "groq",
    match: "llama-3.",
    structuredOutput: UNVERIFIED,
    strictSchemaMode: UNVERIFIED,
    toolsWithStructuredOutput: UNVERIFIED,
    inputExamples: UNVERIFIED,
    reasoningEffort: UNVERIFIED_REASONING,
  },
  {
    provider: "ollama",
    match: "qwen3.",
    structuredOutput: UNVERIFIED,
    strictSchemaMode: UNVERIFIED,
    toolsWithStructuredOutput: UNVERIFIED,
    inputExamples: UNVERIFIED,
    reasoningEffort: UNVERIFIED_REASONING,
  },
];

/**
 * The capability map. Parsed (and therefore self-validated) at module load —
 * a malformed hand-authored row throws immediately on import rather than
 * silently shipping a bad entry. Frozen (row-level and array-level) per
 * repo convention.
 */
export const MODEL_CAPABILITIES: readonly ModelCapabilities[] = Object.freeze(
  RAW_MODEL_CAPABILITIES.map((row) => Object.freeze(ModelCapabilitiesSchema.parse(row))),
);

// ---------------------------------------------------------------------------
// getModelCapabilities — longest-prefix lookup
// ---------------------------------------------------------------------------

/**
 * Look up the capability row for a resolved model id. Normalizes exactly as
 * {@link bareModelId} does, then picks the LONGEST matching `match` prefix
 * (so "gpt-4o" beats a hypothetical "gpt-" entry). No match → `undefined` —
 * callers must treat that as "unknown model, take the conservative path,
 * optionally warn". No default entry, no guessing.
 */
export function getModelCapabilities(modelId: string): ModelCapabilities | undefined {
  const bare = bareModelId(modelId);
  let best: ModelCapabilities | undefined;
  for (const entry of MODEL_CAPABILITIES) {
    if (
      bare.startsWith(entry.match) &&
      (best === undefined || entry.match.length > best.match.length)
    ) {
      best = entry;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// adviseStructuredRun — the once-per-(model x capability) advisory
// ---------------------------------------------------------------------------

/**
 * Keys already warned about (`"<bareId>:<capability>"`). Follows the
 * `schema-guard.ts` once-per-key `console.warn` idiom (D4) — a `Set<string>`
 * rather than schema-guard's `WeakSet<object>` because the key here is a
 * string (model id x capability name), not an object identity.
 */
const advisedKeys = new Set<string>();

/**
 * Called by `runStructured()` right after model resolution. Warns — once
 * per (model x capability) — when the map has something useful to say
 * about this run's structured-output path, and is silent otherwise. NEVER
 * throws and NEVER changes control flow: correctness always comes from the
 * 2-tier fallback in `agent-runner.ts`, not from this advisory. A thin
 * wrapper over {@link adviseStructuredRunFor}, which takes the looked-up
 * entry directly and is what tests exercise the "no" branch against — none
 * of today's seeded rows have a verified `structuredOutput.support === "no"`
 * (DESIGN §9.5's no-tools trial passed on every tested family), so that
 * branch has no honest real-data fixture to test through the live map.
 */
export function adviseStructuredRun(modelId: string): void {
  adviseStructuredRunFor(modelId, getModelCapabilities(modelId));
}

/**
 * The decision logic behind {@link adviseStructuredRun}, decoupled from the
 * live `MODEL_CAPABILITIES` lookup so it can be exercised against a
 * synthetic `ModelCapabilities` entry in tests. Exported for testing.
 */
export function adviseStructuredRunFor(
  modelId: string,
  entry: ModelCapabilities | undefined,
): void {
  const bare = bareModelId(modelId);
  const key = `${bare}:structuredOutput`;
  if (advisedKeys.has(key)) return;

  const capability = entry?.structuredOutput;

  if (capability?.support === "no") {
    advisedKeys.add(key);
    const verified = capability.lastVerified ? `, ${capability.lastVerified}` : "";
    const remedy =
      'expect the 2-tier fallback, or a possible "No object generated" error on the no-tools path.';
    console.warn(
      `[agentic-patterns] model "${modelId}" is marked as NOT supporting native structured output (verified ${capability.verifiedBy}${verified}); ${remedy}`,
    );
    return;
  }

  if (entry === undefined || capability?.support === "unknown") {
    advisedKeys.add(key);
    console.warn(
      `[agentic-patterns] structured-output capabilities are unverified for model "${modelId}"; taking the conservative path. Extend MODEL_CAPABILITIES (providers/capabilities.ts) once verified.`,
    );
  }
}

/**
 * Test-only: clear the once-per-key advisory memory. `adviseStructuredRun`'s
 * `Set` is module-level and persists across every `it()` in a test file (the
 * module is only re-instantiated per FILE, not per test) — without this,
 * whichever test in a file first calls `runStructured()` with an unmapped
 * model id (e.g. the ubiquitous "test-model" default) "claims" that
 * advisory, and every later test in the same file silently gets none. Call
 * this in a `beforeEach`/`afterEach` in any suite that asserts on
 * `console.warn` or advisory behavior.
 */
export function resetAdvisoryWarningsForTests(): void {
  advisedKeys.clear();
}

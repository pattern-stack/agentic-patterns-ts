#!/usr/bin/env bun
/**
 * scripts/probe-capabilities.mjs — #390 live capability probe + drift check.
 *
 * Bun-only, not plain Node — the run-guard at the bottom uses
 * `import.meta.main` (a Bun / Node->=24 feature; under an older plain `node`
 * it's `undefined`, so the script silently no-ops instead of running) and
 * this file deep-imports bun's hoisted `node_modules` layout below. Always
 * invoke via `bun run scripts/probe-capabilities.mjs` (as this doc comment
 * and the CI job both do).
 *
 * Sibling of `scripts/runner-side-by-side.mjs`. Per provider whose env key is
 * SET, runs a minimal matrix against that provider's `tiers.haiku` default
 * (cheapest tier — probe budget is single-digit cents per full run):
 *
 *   (a) no-tools `Output.object` closed schema            -> structuredOutput
 *   (b) tools + `Output.object` single call                -> toolsWithStructuredOutput
 *   (c) same with `strict: true` on the tool                -> strictSchemaMode
 *   (d) `reasoning` effort ladder (["low", "high"])          -> reasoningEffort
 *       (best-effort only — see `probeReasoningEffort`'s doc comment for the
 *       known "silently ignored option" limitation this can't fully close)
 *
 * `inputExamples` has NO probe step here on purpose (Gate 1.5 review note
 * 3): "honored vs silently stripped" isn't cleanly detectable from a single
 * call the way the above are, so `capabilities.ts`'s schema restricts
 * `inputExamples.verifiedBy` to `"docs"` / `"unverified"` instead — adding an
 * uncertain probe heuristic here would contradict that choice.
 *
 * Providers with NO key set are NOT probed — they print a `SKIP (no key)`
 * row instead. This is the expected path in most CI runs and in any
 * container without provider secrets: the script degrades gracefully rather
 * than erroring, and the printed table makes that explicit per-provider
 * rather than silent.
 *
 * OpenRouter special case (per the spec): capabilities are
 * (route x upstream)-dependent, so this script only probes its PINNED tier
 * default (`anthropic/claude-*`, same as every other provider's `tiers.haiku`)
 * — any other upstream id routed through OpenRouter is out of scope for this
 * script and stays `unknown` in the map.
 *
 * Run from the repo root (build first — this imports the compiled runtime
 * package, like `runner-side-by-side.mjs` does):
 *   bun run build
 *   bun run scripts/probe-capabilities.mjs           # print the live table
 *   bun run scripts/probe-capabilities.mjs --check    # + drift check, exits
 *                                                      # non-zero on drift
 *
 * Env — each provider is skipped unless (one of) its vars is set. See
 * `.env.example`'s "#390 live capability probes" section for the full list:
 *   ANTHROPIC_API_KEY, OPENAI_API_KEY, GOOGLE_GENERATIVE_AI_API_KEY (or
 *   GOOGLE_API_KEY), GROQ_API_KEY, MISTRAL_API_KEY, XAI_API_KEY,
 *   DEEPSEEK_API_KEY, OPENROUTER_API_KEY, OLLAMA_HOST (keyless, local — only
 *   probed if reachable).
 *
 * `--check` compares each live PASS/FAIL outcome against
 * `getModelCapabilities()` and:
 *   - prints a delta row for every disagreement (map says X, probe found Y);
 *   - warns (does not fail) on any map entry whose `lastVerified` is more
 *     than 180 days old — a staleness nudge, not a hard drift.
 *   - exits 1 if any live-vs-map disagreement was found, 0 otherwise
 *     (including the all-SKIP keyless case — no keys means no evidence to
 *     disagree with).
 */

// Deep relative imports (not bare "ai"/"zod" specifiers) — mirrors
// `runner-side-by-side.mjs`'s precedent: this repo's `bun install` hoists
// package deps under each workspace package's own `node_modules/`, not the
// monorepo root, so a top-level `scripts/` file has to reach in explicitly.
import {
  Output,
  generateText,
  isStepCount,
  tool,
} from "../packages/agent-runtime/node_modules/ai/dist/index.js";
import { z } from "../packages/agent-runtime/node_modules/zod/index.js";

import { PROVIDERS, getModelCapabilities } from "../packages/agent-runtime/dist/index.js";

const CHECK = process.argv.includes("--check");
const STALE_DAYS = 180;
const TODAY = new Date();

const ProbeSchema = z.object({
  answer: z.string(),
  confidence: z.enum(["low", "medium", "high"]),
});

const lookupTool = tool({
  description: "Look up a fact by topic. Call this before answering.",
  inputSchema: z.object({ topic: z.string() }),
  execute: async ({ topic }) => ({ topic, fact: "the answer is 42" }),
});

function todayISO() {
  return TODAY.toISOString().slice(0, 10);
}

export function row(provider, model, capability, outcome, note) {
  return { provider, model, capability, outcome, date: todayISO(), note: note ?? "" };
}

async function probeNoToolsStructured(providerName, modelId, model) {
  try {
    const result = await generateText({
      model,
      output: Output.object({ schema: ProbeSchema }),
      prompt: "What is 6 * 7? Reply with {answer, confidence}.",
    });
    const ok = ProbeSchema.safeParse(result.output).success;
    return row(providerName, modelId, "structuredOutput", ok ? "PASS" : "FAIL (invalid shape)");
  } catch (e) {
    return row(providerName, modelId, "structuredOutput", "FAIL (error)", String(e?.message ?? e));
  }
}

async function probeToolsStructured(providerName, modelId, model, { strict }) {
  const capability = strict ? "strictSchemaMode" : "toolsWithStructuredOutput";
  const toolDef = strict ? { ...lookupTool, strict: true } : lookupTool;
  try {
    const result = await generateText({
      model,
      stopWhen: isStepCount(4),
      tools: { lookup: toolDef },
      output: Output.object({ schema: ProbeSchema }),
      prompt:
        "Use the lookup tool for 'answer', then return {answer, confidence} as the structured object.",
    });
    const toolCalled = (result.steps ?? []).some((s) => (s.toolCalls?.length ?? 0) > 0);
    const ok = toolCalled && ProbeSchema.safeParse(result.output).success;
    return row(
      providerName,
      modelId,
      capability,
      ok ? "PASS" : `FAIL (${toolCalled ? "invalid shape" : "tool never fired"})`,
    );
  } catch (e) {
    return row(providerName, modelId, capability, "FAIL (error)", String(e?.message ?? e));
  }
}

/**
 * KNOWN LIMITATION (Gate 2.5 quality-review note — flagged, not fully
 * closed): passing `reasoning: level` cannot distinguish "the provider
 * actually reasoned at this level" from "the SDK/provider silently ignored
 * an option it doesn't support" — many providers accept and drop unknown
 * `CallSettings` rather than throwing. A bare accept-without-error is
 * therefore NOT proof of support.
 *
 * Best-effort tightening: look for actual reasoning EVIDENCE in the
 * response — non-empty `reasoningText`, or non-zero
 * `usage.outputTokenDetails.reasoningTokens` — before counting a level as a
 * confirmed accept. A level whose call succeeds but shows neither is
 * reported as "uncertain", not folded into a clean PASS.
 *
 * This still isn't airtight (a provider could in principle reason without
 * emitting a reasoning part or without token-level accounting for it), so
 * treat "uncertain" as "needs a human look before transcribing 'yes' into
 * MODEL_CAPABILITIES", not as a settled answer either way. No `reasoning`
 * row is seeded yet (`reasoningEffort` is `unverified` for every family
 * today), so this is a forward-looking guard for whoever seeds the first
 * one, not a fix for anything currently in the map.
 */
async function probeReasoningEffort(providerName, modelId, model) {
  const levels = ["low", "high"];
  const accepted = [];
  const uncertain = [];
  for (const level of levels) {
    try {
      const result = await generateText({ model, prompt: "2+2=?", reasoning: level });
      const reasoningTokens = result.usage?.outputTokenDetails?.reasoningTokens ?? 0;
      const hasReasoningEvidence = Boolean(result.reasoningText) || reasoningTokens > 0;
      if (hasReasoningEvidence) {
        accepted.push(level);
      } else {
        uncertain.push(level);
      }
    } catch {
      // Not accepted at this level — leave it out rather than guessing.
    }
  }

  if (accepted.length === 0 && uncertain.length === 0) {
    return row(providerName, modelId, "reasoningEffort", "FAIL (no levels accepted)");
  }
  const uncertainNote =
    uncertain.length > 0
      ? `call(s) succeeded for [${uncertain.join(",")}] with no reasoning evidence (reasoningText/reasoningTokens) — provider may be silently ignoring the option; verify manually before seeding.`
      : "";
  const outcome =
    accepted.length > 0
      ? `PASS (${accepted.join(",")})${uncertain.length > 0 ? ` + UNCERTAIN (${uncertain.join(",")})` : ""}`
      : `UNCERTAIN (${uncertain.join(",")})`;
  return row(providerName, modelId, "reasoningEffort", outcome, uncertainNote);
}

/**
 * Probe one provider adapter — SKIP (no key), FAIL (load), or the 4-row
 * matrix. Exported for testing against a stub provider (a plain object
 * shaped like `ProviderProtocol`, not a real `@ai-sdk/*` adapter) so unit
 * tests can exercise the skip/fail/matrix plumbing without any network call
 * or provider package install.
 */
export async function probeProvider(provider) {
  const hasKey = provider.envVars.some((v) => !!process.env[v]);
  const modelId = provider.tiers.haiku;

  if (!hasKey) {
    return [
      row(
        provider.name,
        modelId,
        "*",
        "SKIP (no key)",
        `unset: ${provider.envVars.join(", ")} — verifiedBy stays "unverified"/"unknown" for this provider`,
      ),
    ];
  }

  let model;
  try {
    model = await provider.load(modelId);
  } catch (e) {
    return [row(provider.name, modelId, "*", "FAIL (load)", String(e?.message ?? e))];
  }

  return [
    await probeNoToolsStructured(provider.name, modelId, model),
    await probeToolsStructured(provider.name, modelId, model, { strict: false }),
    await probeToolsStructured(provider.name, modelId, model, { strict: true }),
    await probeReasoningEffort(provider.name, modelId, model),
  ];
}

export function printTable(rows) {
  const widths = { provider: 10, model: 26, capability: 26, outcome: 30, date: 10 };
  const header = ["provider", "model", "capability", "outcome", "date"]
    .map((k) => k.padEnd(widths[k]))
    .join(" | ");
  console.log(header);
  console.log("-".repeat(header.length));
  for (const r of rows) {
    console.log(
      [
        r.provider.padEnd(widths.provider),
        r.model.padEnd(widths.model),
        r.capability.padEnd(widths.capability),
        r.outcome.padEnd(widths.outcome),
        r.date.padEnd(widths.date),
      ].join(" | "),
    );
    if (r.note) console.log(`    ${r.note}`);
  }
}

/** Days between an ISO date string and today. Exported for testing. */
export function daysSince(isoDate) {
  const then = new Date(isoDate);
  return Math.floor((TODAY.getTime() - then.getTime()) / (1000 * 60 * 60 * 24));
}

/**
 * Compare live probe outcomes against the map. Returns `{ drift, stale }` —
 * `drift` entries fail `--check` (exit 1); `stale` entries are printed as
 * warnings only. `lookupCapabilities` defaults to the real
 * `getModelCapabilities`, but is injectable so tests can assert the
 * drift/stale logic against a synthetic map entry (e.g. an old
 * `lastVerified`) without waiting 180 real days or fabricating a dishonest
 * seed-data row.
 */
export function checkDrift(rows, lookupCapabilities = getModelCapabilities) {
  const drift = [];
  const stale = [];

  for (const r of rows) {
    if (r.capability === "*") continue; // SKIP/FAIL(load) rows carry no capability to diff.
    const entry = lookupCapabilities(r.model);
    const mapValue = entry?.[r.capability];
    if (!mapValue) continue; // no map opinion to disagree with.

    if (mapValue.lastVerified && daysSince(mapValue.lastVerified) > STALE_DAYS) {
      stale.push({ ...r, mapValue });
    }

    const livePass = r.outcome.startsWith("PASS");
    const liveFail = r.outcome.startsWith("FAIL");
    if (!livePass && !liveFail) continue; // SKIP — no live evidence to compare.

    const mapSaysYes = mapValue.support === "yes";
    const mapSaysNo = mapValue.support === "no";
    if ((livePass && mapSaysNo) || (liveFail && mapSaysYes)) {
      drift.push({ ...r, mapValue });
    }
  }

  return { drift, stale };
}

export async function main() {
  const allRows = [];
  // Sequential by design — small, cheap, one provider at a time keeps rate
  // limits and cost predictable.
  for (const provider of Object.values(PROVIDERS)) {
    const rows = await probeProvider(provider);
    allRows.push(...rows);
  }

  printTable(allRows);

  if (CHECK) {
    const { drift, stale } = checkDrift(allRows);

    if (stale.length > 0) {
      console.warn(
        `\n${stale.length} map entr${stale.length === 1 ? "y is" : "ies are"} stale (>${STALE_DAYS}d):`,
      );
      for (const s of stale) {
        console.warn(
          `  ${s.provider}/${s.model} ${s.capability}: lastVerified=${s.mapValue.lastVerified} (${daysSince(s.mapValue.lastVerified)}d ago)`,
        );
      }
    }

    if (drift.length > 0) {
      console.error(
        `\n${drift.length} DRIFT row(s) — live probe disagrees with MODEL_CAPABILITIES:`,
      );
      for (const d of drift) {
        console.error(
          `  ${d.provider}/${d.model} ${d.capability}: map says support="${d.mapValue.support}", live probe says "${d.outcome}"`,
        );
      }
      process.exitCode = 1;
      return;
    }

    console.log("\nNo drift detected against MODEL_CAPABILITIES.");
  }
}

// Only auto-run when executed directly (`bun run scripts/probe-capabilities.mjs`)
// — NOT when imported (e.g. by a unit test importing the exported functions
// above), which would otherwise fire live provider calls as a side effect of
// import alone.
if (import.meta.main) {
  main().catch((e) => {
    console.error("probe-capabilities: unexpected failure:", e);
    process.exitCode = 1;
  });
}

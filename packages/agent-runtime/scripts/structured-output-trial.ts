/**
 * Structured-output trial — validates `experimental_output` (AI SDK v5) across the
 * routes PatternStack's `runStructured` would use, BEFORE we commit the design.
 *
 * Answers two questions empirically:
 *   1. Does native Anthropic (Sonnet 4.5) return a schema-valid object via
 *      `experimental_output`, both alone AND while a tool loop runs? (the "green row")
 *   2. Does the SAME work through Bifrost (@ai-sdk/openai-compatible) to
 *      Anthropic / Gemini / OpenAI? (the gateway row we flagged as least-guaranteed)
 *
 * Run from the repo root:
 *   bun run packages/agent-runtime/scripts/structured-output-trial.ts
 *
 * Env — each route is SKIPPED unless its vars are present (so it tests whatever you have):
 *   ANTHROPIC_API_KEY                 -> native @ai-sdk/anthropic, claude-sonnet-4-5
 *   BIFROST_BASE_URL                  -> gateway via @ai-sdk/openai-compatible
 *                                        (e.g. http://localhost:8080/v1)
 *   BIFROST_API_KEY    (optional)
 *   BIFROST_MODELS                    -> comma list of gateway model ids to test, e.g.
 *      "anthropic/claude-sonnet-4-5,gemini/gemini-2.5-pro,openai/gpt-5"
 *
 * Per (route, model) it runs two cases — no-tools and with-tools — and reports:
 *   PASS         experimental_output present AND schema-valid
 *   tool✓ / tool✗ (with-tools case) whether the tool actually fired during the loop
 *   FAIL         error, or missing/invalid structured output (reason printed)
 *
 * NOTE: v5 spelling is `experimental_output`. On AI SDK v6 rename to `output`.
 */

import { Output, generateText, stepCountIs, tool } from "ai";
import { z } from "zod";

// Deliberately avoids Anthropic-unsupported JSON-schema keywords (no .min/.max/.email/.regex)
// — see vercel/ai#13355. If structured output rejects this, it's a deeper provider gap.
const Profile = z.object({
  name: z.string(),
  role: z.enum(["engineer", "designer", "manager", "other"]),
  yearsExperience: z.number(),
  primaryLanguage: z.string(),
});
type Profile = z.infer<typeof Profile>;

const lookupTool = tool({
  description: "Look up an employee's raw HR record by name. Call this before answering.",
  inputSchema: z.object({ name: z.string() }),
  execute: async ({ name }) => ({
    name,
    title: "Senior Software Engineer",
    tenureYears: 7,
    stack: "TypeScript",
  }),
});

interface CaseResult {
  route: string;
  withTools: boolean;
  pass: boolean;
  toolCalled: boolean;
  detail: string;
}

async function runCase(route: string, model: unknown, withTools: boolean): Promise<CaseResult> {
  try {
    const result = await generateText({
      // biome-ignore lint/suspicious/noExplicitAny: trial harness, providers vary
      model: model as any,
      stopWhen: stepCountIs(6), // room for tool turn(s) + the structured finish
      experimental_output: Output.object({ schema: Profile }),
      ...(withTools ? { tools: { lookup: lookupTool } } : {}),
      prompt: withTools
        ? "Use the lookup tool for 'Dana Lee', then return her profile as the structured object."
        : "Return a structured profile for a designer named Dana Lee, 5 years experience, primary tool Figma.",
    });

    // biome-ignore lint/suspicious/noExplicitAny: experimental_output is loosely typed in v5
    const obj = (result as any).experimental_output as Profile | undefined;
    // biome-ignore lint/suspicious/noExplicitAny: step shape varies
    const toolCalled = ((result as any).steps ?? []).some(
      // biome-ignore lint/suspicious/noExplicitAny: step shape varies
      (s: any) => (s.toolCalls?.length ?? 0) > 0,
    );

    if (obj === undefined) {
      return { route, withTools, pass: false, toolCalled, detail: "no experimental_output returned" };
    }
    const parsed = Profile.safeParse(obj);
    if (!parsed.success) {
      return { route, withTools, pass: false, toolCalled, detail: "output failed schema validation" };
    }
    return { route, withTools, pass: true, toolCalled, detail: JSON.stringify(obj) };
  } catch (err) {
    return {
      route,
      withTools,
      pass: false,
      toolCalled: false,
      detail: (err as Error).message.replace(/\s+/g, " ").slice(0, 160),
    };
  }
}

async function main() {
  const cases: Array<{ route: string; model: unknown }> = [];

  if (process.env.ANTHROPIC_API_KEY) {
    const { anthropic } = await import("@ai-sdk/anthropic");
    cases.push({ route: "native:claude-sonnet-4-5", model: anthropic("claude-sonnet-4-5") });
  }

  if (process.env.BIFROST_BASE_URL) {
    const { createOpenAICompatible } = await import("@ai-sdk/openai-compatible");
    // Bifrost auth: prefer HTTP basic (USERNAME/PASSWORD) when present, else a bearer key.
    const headers: Record<string, string> = {};
    if (process.env.BIFROST_USERNAME && process.env.BIFROST_PASSWORD) {
      const basic = Buffer.from(
        `${process.env.BIFROST_USERNAME}:${process.env.BIFROST_PASSWORD}`,
      ).toString("base64");
      headers.Authorization = `Basic ${basic}`;
    }
    const gw = createOpenAICompatible({
      name: "bifrost",
      baseURL: process.env.BIFROST_BASE_URL,
      apiKey: process.env.BIFROST_API_KEY ?? "bifrost", // overridden by the Basic header when set
      headers,
      supportsStructuredOutputs: true, // <- the opt-in we found is required; without it Output is a no-op
    });
    const ids = (process.env.BIFROST_MODELS ?? "anthropic/claude-sonnet-4-5")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    for (const id of ids) cases.push({ route: `bifrost:${id}`, model: gw(id) });
  }

  if (cases.length === 0) {
    console.error(
      "No routes configured. Set ANTHROPIC_API_KEY and/or BIFROST_BASE_URL (+ BIFROST_MODELS).",
    );
    process.exit(1);
  }

  const results: CaseResult[] = [];
  for (const c of cases) {
    for (const withTools of [false, true]) {
      process.stdout.write(`· ${c.route.padEnd(38)} ${withTools ? "with-tools" : "no-tools  "} ... `);
      const r = await runCase(c.route, c.model, withTools);
      const toolTag = r.withTools ? (r.toolCalled ? " tool✓" : " tool✗") : "";
      console.log(r.pass ? `PASS${toolTag}` : `FAIL${toolTag} — ${r.detail}`);
      results.push(r);
    }
  }

  console.log("\n=== SUMMARY ===");
  for (const r of results) {
    const toolTag = r.withTools ? (r.toolCalled ? " tool✓" : " tool✗") : "       ";
    console.log(
      `${(r.pass ? "PASS" : "FAIL").padEnd(4)}  ${r.route.padEnd(38)} ${
        r.withTools ? "with-tools" : "no-tools  "
      }${toolTag}  ${r.pass ? "" : `→ ${r.detail}`}`,
    );
  }
  const failures = results.filter((r) => !r.pass).length;
  console.log(`\n${results.length - failures}/${results.length} passed.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

/**
 * Two-tier fallback proof — the model-safe path `runStructured` uses for a
 * tool-using structured step on a model that CANNOT do tools+structured in one
 * call (gemini-3.1-flash-lite, which FAILED the single-call trial).
 *
 *   Tier 1: tool loop (generateText + tool)            -> plain text
 *   Tier 2: no-tools Output.object over tier-1 text    -> schema-valid object
 *
 * Both tiers individually passed the matrix on flash-lite; this proves them
 * composed end-to-end == correct structured output with tool data, no single-call.
 *
 * Run:
 *   set -a; . /Users/dug/Projects/dealbrain/.env; set +a
 *   export BIFROST_BASE_URL="${BIFROST_BASE_URL%/}/v1"
 *   export BIFROST_MODEL="gemini/gemini-3.1-flash-lite"
 *   bun run packages/agent-runtime/scripts/two-tier-fallback-trial.ts
 */
import { Output, generateText, stepCountIs, tool } from "ai";
import { z } from "zod";

const Profile = z.object({
  name: z.string(),
  role: z.enum(["engineer", "designer", "manager", "other"]),
  yearsExperience: z.number(),
  primaryLanguage: z.string(),
});

const lookup = tool({
  description: "Look up an employee's raw HR record by name. Call this before answering.",
  inputSchema: z.object({ name: z.string() }),
  execute: async ({ name }) => ({
    name,
    title: "Senior Software Engineer",
    tenureYears: 7,
    stack: "TypeScript",
  }),
});

async function main() {
  if (!process.env.BIFROST_BASE_URL) {
    console.error("Set BIFROST_BASE_URL (+ BIFROST_USERNAME/PASSWORD).");
    process.exit(1);
  }
  const { createOpenAICompatible } = await import("@ai-sdk/openai-compatible");
  const headers: Record<string, string> = {};
  if (process.env.BIFROST_USERNAME && process.env.BIFROST_PASSWORD) {
    headers.Authorization = `Basic ${Buffer.from(
      `${process.env.BIFROST_USERNAME}:${process.env.BIFROST_PASSWORD}`,
    ).toString("base64")}`;
  }
  const gw = createOpenAICompatible({
    name: "bifrost",
    baseURL: process.env.BIFROST_BASE_URL,
    apiKey: process.env.BIFROST_API_KEY ?? "bifrost",
    headers,
    supportsStructuredOutputs: true,
  });
  const id = process.env.BIFROST_MODEL ?? "gemini/gemini-3.1-flash-lite";
  // biome-ignore lint/suspicious/noExplicitAny: trial harness
  const model = gw(id) as any;

  console.log(`Two-tier fallback on ${id} (the model that FAILS single-call tools+structured)\n`);

  // Tier 1 — tool loop, plain text out (this is what the runner's `run` already does)
  const t1 = await generateText({
    model,
    stopWhen: stepCountIs(6),
    tools: { lookup },
    prompt: "Use the lookup tool for 'Dana Lee', then write a short plain-text summary of her record.",
  });
  // biome-ignore lint/suspicious/noExplicitAny: step shape varies
  const toolFired = ((t1 as any).steps ?? []).some((s: any) => (s.toolCalls?.length ?? 0) > 0);
  console.log(`Tier 1 (tool loop)        : tool fired = ${toolFired}`);
  console.log(`                            text = ${JSON.stringify(t1.text).slice(0, 140)}`);

  // Tier 2 — NO tools, structured over tier-1 text (this is `runStructured`'s no-tools path)
  const t2 = await generateText({
    model,
    experimental_output: Output.object({ schema: Profile }),
    prompt: `From this employee record summary, produce the structured profile object.\n\n${t1.text}`,
  });
  // biome-ignore lint/suspicious/noExplicitAny: experimental_output loosely typed in v5
  const obj = (t2 as any).experimental_output;
  const parsed = obj ? Profile.safeParse(obj) : { success: false as const };
  console.log(`Tier 2 (no-tools structured): object = ${JSON.stringify(obj)}`);

  const pass = toolFired && parsed.success;
  console.log(
    `\nRESULT: ${
      pass
        ? "PASS — tool fired in tier 1 AND tier 2 returned a schema-valid object"
        : `FAIL — toolFired=${toolFired} schemaValid=${parsed.success}`
    }`,
  );
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error("ERROR:", (e as Error).message);
  process.exit(1);
});

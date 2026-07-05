/**
 * `judgeScorer` — 5-axis LLM-judge rubric scorer via an injected `RunnerProtocol`
 * (spec `.ai-docs/stacks/eval-surface/specs/141.md` § Interfaces, E6).
 *
 * Ported from v1 `grade.ts`'s `gradeWithLLM` (rubric grade.ts:74-84, system
 * prompt grade.ts:99-105) — "just a scorer that calls a runner" (doc §11), no
 * vendor hardcoding. The runner is injected at CONSTRUCTION time (`judgeScorer(opts)`
 * closes over `opts.runner`) because the `Scorer` contract's args carry no runner
 * and `EvalRunContext.runner` is not threaded to scorers (run-eval.ts:263-269,
 * deliberately, since #103) — widening the contract would touch every existing
 * scorer and the engine (§13: "not a rewrite of #103").
 *
 * Transport: `runner.run()` + a robust text parse — NOT `runStructured` (optional
 * on the protocol, capability-gated on AgentRunner). A judge that behaves
 * differently per runner would make scores non-comparable across environments.
 *
 * Failure contract: NEVER throws. Unparseable verdict, schema-invalid verdict,
 * or a throwing runner call each produce one `Score {name, value: null, error}`
 * — the existing ERRORED convention (types.ts module doc), NOT `passed: false`
 * (which would conflate "judge broke" with "answer is bad").
 *
 * ADDITIVE: new file.
 */

import { z } from "zod";
import type { AgentLike, RunnerProtocol } from "../../runner/types.js";
import type { Scorer } from "../scorer.js";
import type { EvalCase, Score } from "../types.js";

// ---------------------------------------------------------------------------
// Rubric
// ---------------------------------------------------------------------------

export const JUDGE_AXES = [
  "accuracy",
  "completeness",
  "grounding",
  "hazardAvoidance",
  "calibration",
] as const;
export type JudgeAxis = (typeof JUDGE_AXES)[number];

/** Score names use kebab (`judge:hazard-avoidance`); the zod field stays `hazardAvoidance`. */
const AXIS_SCORE_SUFFIX: Record<JudgeAxis, string> = {
  accuracy: "accuracy",
  completeness: "completeness",
  grounding: "grounding",
  hazardAvoidance: "hazard-avoidance",
  calibration: "calibration",
};

/** Ported from grade.ts:74-84 — the rubric axes + the grounding-vs-accuracy
 *  separation language lives in `DEFAULT_JUDGE_SYSTEM` below (grade.ts:99-105). */
export const JudgeVerdictSchema = z.object({
  pass: z.boolean(),
  axes: z.object({
    accuracy: z.number().min(0).max(5),
    completeness: z.number().min(0).max(5),
    grounding: z.number().min(0).max(5),
    hazardAvoidance: z.number().min(0).max(5),
    calibration: z.number().min(0).max(5),
  }),
  notes: z.string(),
});
export type JudgeVerdict = z.infer<typeof JudgeVerdictSchema>;

/** ADK-style `score ≥ threshold`, 0-5 scale (raw axis units, NOT normalized). */
export type JudgeThresholds = Partial<Record<JudgeAxis, number>> & {
  /** Threshold on the axis mean (0-5). Applied to the overall "judge" score. */
  mean?: number;
};

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface JudgeScorerOptions {
  /** REQUIRED — the injected runner. "Just a scorer that calls a runner." */
  runner: RunnerProtocol;
  /**
   * Judge model id, returned by the default judge agent's getModel(). Honored
   * by resolver-backed/gateway runners (agent-runner.ts:293-297); fixed-model
   * runners judge on their own model. Default "sonnet".
   */
  model?: string;
  /**
   * Full agent override (custom system prompt / model / name). Wins over
   * `model` + `system`. Default: built-in minimal judge AgentLike.
   */
  agent?: AgentLike;
  /** System-prompt override for the default judge agent. */
  system?: string;
  /** Per-case user-prompt builder override. Default template below. */
  prompt?: (args: {
    input: unknown;
    output: unknown;
    expected?: unknown;
    case: { id: string; tags?: readonly string[] };
  }) => string;
  /** Score-name prefix. Default "judge" (⇒ "judge", "judge:accuracy", …). */
  name?: string;
  thresholds?: JudgeThresholds;
  /**
   * Default true: no `expected` ⇒ return [] (unscored), the expected-gated
   * convention. Set false to grade rubric-only (grounding/calibration still
   * meaningful without an answer key).
   */
  requireExpected?: boolean;
  /** RunOptions.maxIterations for the judge call. Default 1 (tool-free single shot). */
  maxIterations?: number;
}

// ---------------------------------------------------------------------------
// Default judge agent + prompt
// ---------------------------------------------------------------------------

const DEFAULT_JUDGE_SYSTEM =
  "You are a strict grader for an AI agent. Score the agent answer against the EXPECTED answer " +
  "key (and the named HAZARD when present). Reward correct, cited, well-calibrated answers; " +
  "penalize fabrication, overclaiming, and falling into the hazard. Be exacting — a fluent answer " +
  "that misses the real ask or hits the hazard does NOT pass. CITATION CHECK: when the answer " +
  "attaches a quote to a claim, verify the quote actually contains/supports that claim. A " +
  "confident claim backed by a quote that does not substantiate it is a GROUNDING failure (score " +
  "grounding low) — even if the claim turns out to be true. Keep this separate from accuracy.\n" +
  "Respond with ONLY a JSON object matching: " +
  '{"pass": boolean, "axes": {"accuracy": 0-5, "completeness": 0-5, "grounding": 0-5, ' +
  '"hazardAvoidance": 0-5, "calibration": 0-5}, "notes": "1-3 sentences"} ' +
  "— no prose before or after the JSON.";

/** string as-is; otherwise JSON.stringify (undefined ⇒ ""). */
function renderText(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value) ?? "";
}

function isEmpty(text: string): boolean {
  return text.trim().length === 0;
}

/** object's `expected`|`answer` string field if present, else JSON.stringify of the whole object. */
function renderExpected(expected: unknown): string {
  if (typeof expected === "string") return expected;
  if (expected !== null && typeof expected === "object") {
    const obj = expected as Record<string, unknown>;
    if (typeof obj.expected === "string") return obj.expected;
    if (typeof obj.answer === "string") return obj.answer;
  }
  return JSON.stringify(expected) ?? "";
}

/** `expected.hazard` when `expected` is an object with a string `hazard` field. */
function renderHazard(expected: unknown): string | undefined {
  if (expected !== null && typeof expected === "object") {
    const hazard = (expected as Record<string, unknown>).hazard;
    if (typeof hazard === "string") return hazard;
  }
  return undefined;
}

/** Default per-case user-prompt builder (ported from grade.ts:99-118). */
function defaultPrompt(args: {
  input: unknown;
  output: unknown;
  expected?: unknown;
  case: { id: string; tags?: readonly string[] };
}): string {
  const hazard = renderHazard(args.expected);
  const outputText = renderText(args.output);

  const lines: string[] = [
    "QUESTION:",
    renderText(args.input),
    "",
    "EXPECTED (answer key):",
    renderExpected(args.expected),
    "",
  ];
  if (hazard !== undefined) {
    lines.push("HAZARD to watch for:", hazard, "");
  }
  lines.push(
    "AGENT ANSWER:",
    isEmpty(outputText) ? "(empty — the agent produced no answer)" : outputText,
    "",
    "Score each axis 0-5 and decide pass/fail. JSON only.",
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Parse pipeline
// ---------------------------------------------------------------------------

type ParseResult = { ok: true; verdict: JudgeVerdict } | { ok: false; reason: string };

/** Strip a leading/trailing markdown code fence (```json … ```) wrapping the WHOLE text. */
function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? (fenced[1] ?? "") : trimmed;
}

/** Locate the first balanced `{…}` block via brace-depth scan — the response
 *  may pre/postfix prose (or code-fence markers left over from a partial strip). */
function extractBalancedObject(text: string): string | undefined {
  const start = text.indexOf("{");
  if (start === -1) return undefined;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** (1) response text; (2) strip a whole-text code fence; (3) balanced-brace scan;
 *  (4) JSON.parse; (5) JudgeVerdictSchema.safeParse. Any step failing ⇒ a reason. */
function parseVerdict(response: string): ParseResult {
  const stripped = stripCodeFence(response);
  const block = extractBalancedObject(stripped);
  if (block === undefined) {
    return { ok: false, reason: "no JSON object found in judge response" };
  }

  let json: unknown;
  try {
    json = JSON.parse(block);
  } catch (error) {
    return { ok: false, reason: `JSON.parse failed — ${errorMessage(error)}` };
  }

  const parsed = JudgeVerdictSchema.safeParse(json);
  if (!parsed.success) {
    return { ok: false, reason: `schema validation failed — ${parsed.error.message}` };
  }
  return { ok: true, verdict: parsed.data };
}

// ---------------------------------------------------------------------------
// Score fan-out
// ---------------------------------------------------------------------------

const EMPTY_VERDICT: JudgeVerdict = {
  pass: false,
  axes: { accuracy: 0, completeness: 0, grounding: 0, hazardAvoidance: 0, calibration: 0 },
  notes: "no answer produced (empty output)",
};

/** Six-entry success-path fan-out (§ Interfaces — emitted scores table). */
function buildScores(
  namePrefix: string,
  verdict: JudgeVerdict,
  thresholds: JudgeThresholds | undefined,
  tokens: { judgeInputTokens: number; judgeOutputTokens: number },
): Score[] {
  const axisValues = JUDGE_AXES.map((axis) => verdict.axes[axis]);
  const mean = axisValues.reduce((sum, v) => sum + v, 0) / axisValues.length;
  const meanThreshold = thresholds?.mean;
  const overallPassed = verdict.pass && (meanThreshold === undefined || mean >= meanThreshold);

  const scores: Score[] = [
    {
      name: namePrefix,
      value: mean / 5,
      passed: overallPassed,
      detail: {
        axes: verdict.axes,
        notes: verdict.notes,
        judgeInputTokens: tokens.judgeInputTokens,
        judgeOutputTokens: tokens.judgeOutputTokens,
      },
    },
  ];

  for (const axis of JUDGE_AXES) {
    const raw = verdict.axes[axis];
    const threshold = thresholds?.[axis];
    scores.push({
      name: `${namePrefix}:${AXIS_SCORE_SUFFIX[axis]}`,
      value: raw / 5,
      detail: { raw },
      ...(threshold !== undefined ? { passed: raw >= threshold } : {}),
    });
  }

  return scores;
}

// ---------------------------------------------------------------------------
// judgeScorer
// ---------------------------------------------------------------------------

export function judgeScorer(opts: JudgeScorerOptions): Scorer<unknown, unknown, unknown> {
  const name = opts.name ?? "judge";
  const requireExpected = opts.requireExpected ?? true;
  const maxIterations = opts.maxIterations ?? 1;
  const buildPrompt = opts.prompt ?? defaultPrompt;

  const judgeSystem = opts.system ?? DEFAULT_JUDGE_SYSTEM;
  const defaultAgent: AgentLike = {
    role: { name: "eval-judge" },
    getModel: () => opts.model ?? "sonnet",
    getTools: () => [],
    // AgentRunner (the main runner) reads renderInitialPrompt() for the system
    // message; ClaudeCodeRunner reads getSystemPrompt(). Return the judge system
    // prompt from BOTH so the rubric+schema reaches the model regardless of runner.
    // Previously renderInitialPrompt was "" → the schema was silently dropped on
    // the AgentRunner path and the model invented its own verdict shape.
    getSystemPrompt: () => judgeSystem,
    renderInitialPrompt: () => judgeSystem,
  };
  const agent = opts.agent ?? defaultAgent;

  return async (args: {
    readonly input: unknown;
    readonly output: unknown;
    readonly expected?: unknown;
    readonly case: EvalCase<unknown, unknown>;
  }): Promise<Score[]> => {
    if (requireExpected && args.expected === undefined) {
      return [];
    }

    const outputText = renderText(args.output);
    if (isEmpty(outputText)) {
      // Empty-answer short-circuit (grade.ts:148-150 precedent) — skip the
      // runner call entirely; deterministic, saves a judge call.
      return buildScores(name, EMPTY_VERDICT, opts.thresholds, {
        judgeInputTokens: 0,
        judgeOutputTokens: 0,
      });
    }

    const message = buildPrompt({
      input: args.input,
      output: args.output,
      expected: args.expected,
      case: { id: args.case.id, tags: args.case.tags },
    });

    let response: string;
    let judgeInputTokens: number;
    let judgeOutputTokens: number;
    try {
      const result = await opts.runner.run(agent, message, { maxIterations });
      response = result.response;
      judgeInputTokens = result.inputTokens;
      judgeOutputTokens = result.outputTokens;
    } catch (error) {
      return [
        {
          name,
          value: null,
          error: `judge verdict unparseable: runner threw — ${errorMessage(error)}`,
        },
      ];
    }

    const parsed = parseVerdict(response);
    if (!parsed.ok) {
      return [{ name, value: null, error: `judge verdict unparseable: ${parsed.reason}` }];
    }

    return buildScores(name, parsed.verdict, opts.thresholds, {
      judgeInputTokens,
      judgeOutputTokens,
    });
  };
}

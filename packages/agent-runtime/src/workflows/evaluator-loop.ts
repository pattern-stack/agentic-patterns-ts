/**
 * EvaluatorLoop — Producer-Evaluator Refinement Loop.
 *
 * Producer generates output → evaluator scores + critiques → producer refines.
 * Tracks best output by score, exits on quality/max/plateau/error.
 *
 * Ported from Python: workflows/loops/evaluator.py
 */

import type { AgentLike } from "../runner/agent-runner.js";
import type { RunnerProtocol, ToolExecutor } from "../runner/types.js";
import type { PatternContext, PatternHooks, PatternResult } from "./base.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RefinementExitReason = "quality_met" | "max_refinements" | "no_improvement" | "error";

/** A single evaluation of produced output. */
export interface Refinement {
  readonly iteration: number;
  readonly content: string;
  readonly score: number;
  readonly feedback: string;
}

/** Protocol for evaluating produced output and providing refinement feedback. */
export interface RefinementEvaluator {
  evaluate(
    input: string,
    output: string,
    context?: PatternContext,
  ): Promise<{ score: number; feedback: string; qualityMet: boolean }>;
}

/** Result of the evaluator loop. */
export interface RefinementResult extends PatternResult {
  readonly exitReason: RefinementExitReason;
  readonly refinements: readonly Refinement[];
  readonly bestOutput: string;
  readonly bestScore: number;
  readonly iterations: number;
}

// ---------------------------------------------------------------------------
// EvaluatorLoop options
// ---------------------------------------------------------------------------

export interface EvaluatorLoopOptions {
  readonly maxRefinements?: number;
  readonly minImprovement?: number;
  readonly hooks?: PatternHooks;
}

export interface EvaluatorRunOptions {
  readonly runner: RunnerProtocol;
  readonly toolExecutor?: ToolExecutor;
  readonly hooks?: PatternHooks;
}

// ---------------------------------------------------------------------------
// EvaluatorLoop
// ---------------------------------------------------------------------------

/**
 * Self-critique refinement loop: producer generates, evaluator scores,
 * producer refines until quality is met or exit conditions are reached.
 *
 * Example:
 *   const loop = new EvaluatorLoop(writerAgent, evaluator, { maxRefinements: 3 });
 *   const result = await loop.run("Write a haiku", { runner });
 */
export class EvaluatorLoop {
  private readonly producer: AgentLike;
  private readonly evaluator: RefinementEvaluator;
  private readonly maxRefinements: number;
  private readonly minImprovement: number;
  private readonly defaultHooks: PatternHooks | undefined;

  constructor(
    producer: AgentLike,
    evaluator: RefinementEvaluator,
    options: EvaluatorLoopOptions = {},
  ) {
    this.producer = producer;
    this.evaluator = evaluator;
    this.maxRefinements = options.maxRefinements ?? 5;
    this.minImprovement = options.minImprovement ?? 0.01;
    this.defaultHooks = options.hooks;
  }

  async run(input: string, options?: EvaluatorRunOptions): Promise<RefinementResult> {
    const runner = options?.runner;
    const hooks = options?.hooks ?? this.defaultHooks;
    const toolExecutor = options?.toolExecutor;

    if (!runner) {
      throw new Error("Runner is required for EvaluatorLoop execution");
    }

    await hooks?.onPatternStart?.({
      type: "pattern.start",
      patternName: "EvaluatorLoop",
      timestamp: new Date(),
    });

    const refinements: Refinement[] = [];
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let bestOutput = "";
    let bestScore = Number.NEGATIVE_INFINITY;
    let exitReason: RefinementExitReason = "max_refinements";
    let previousScore = Number.NEGATIVE_INFINITY;
    let lastFeedback = "";

    for (let iteration = 0; iteration < this.maxRefinements; iteration++) {
      await hooks?.onIterationStart?.({
        type: "pattern.iteration.start",
        iteration,
        timestamp: new Date(),
      });

      // Build prompt for producer
      const prompt = this.buildPrompt(input, iteration, lastFeedback);

      // Run producer
      const runResult = await runner.run(this.producer, prompt, { toolExecutor });
      const content = runResult.response;
      totalInputTokens += runResult.inputTokens;
      totalOutputTokens += runResult.outputTokens;

      // Evaluate output
      const evaluation = await this.evaluator.evaluate(input, content);

      const refinement: Refinement = Object.freeze({
        iteration,
        content,
        score: evaluation.score,
        feedback: evaluation.feedback,
      });
      refinements.push(refinement);

      // Track best
      if (evaluation.score > bestScore) {
        bestScore = evaluation.score;
        bestOutput = content;
      }

      await hooks?.onIterationComplete?.({
        type: "pattern.iteration.complete",
        iteration,
        timestamp: new Date(),
      });

      // Check quality met
      if (evaluation.qualityMet) {
        exitReason = "quality_met";
        break;
      }

      // Check improvement plateau
      if (iteration > 0 && evaluation.score - previousScore < this.minImprovement) {
        exitReason = "no_improvement";
        break;
      }

      previousScore = evaluation.score;
      lastFeedback = evaluation.feedback;
    }

    const result: RefinementResult = Object.freeze({
      exitReason,
      refinements: Object.freeze(refinements),
      bestOutput,
      bestScore,
      iterations: refinements.length,
      totalInputTokens,
      totalOutputTokens,
      succeeded: exitReason === "quality_met",
      finalContent: bestOutput,
    });

    await hooks?.onPatternComplete?.({
      type: "pattern.complete",
      patternName: "EvaluatorLoop",
      result,
      timestamp: new Date(),
    });

    return result;
  }

  private buildPrompt(input: string, iteration: number, feedback: string): string {
    if (iteration === 0) {
      return input;
    }
    return `${input}\n\nFEEDBACK FROM EVALUATOR:\n${feedback}\n\nPlease revise your output based on this feedback.`;
  }
}

// ---------------------------------------------------------------------------
// LLMRefinementEvaluator
// ---------------------------------------------------------------------------

export interface LLMRefinementEvaluatorOptions {
  readonly qualityThreshold?: number;
}

/**
 * Uses an LLM agent to evaluate output quality, parse score and feedback.
 */
export class LLMRefinementEvaluator implements RefinementEvaluator {
  private readonly agent: AgentLike;
  private readonly runner: RunnerProtocol;
  private readonly qualityThreshold: number;

  constructor(
    agent: AgentLike,
    runner: RunnerProtocol,
    options: LLMRefinementEvaluatorOptions = {},
  ) {
    this.agent = agent;
    this.runner = runner;
    this.qualityThreshold = options.qualityThreshold ?? 0.8;
  }

  async evaluate(
    input: string,
    output: string,
  ): Promise<{ score: number; feedback: string; qualityMet: boolean }> {
    const prompt = [
      "Evaluate the following output for the given input.",
      "",
      `INPUT: ${input}`,
      "",
      `OUTPUT: ${output}`,
      "",
      "Respond with:",
      "SCORE: <number between 0 and 1>",
      "FEEDBACK: <your critique>",
    ].join("\n");

    const result = await this.runner.run(this.agent, prompt);
    const response = result.response;

    const scoreMatch = response.match(/SCORE:\s*([\d.]+)/);
    const feedbackMatch = response.match(/FEEDBACK:\s*(.+)/s);

    const score = scoreMatch ? Number.parseFloat(scoreMatch[1] ?? "0") : 0;
    const feedback = feedbackMatch?.[1]?.trim() ?? "No feedback provided";

    return {
      score,
      feedback,
      qualityMet: score >= this.qualityThreshold,
    };
  }
}

// ---------------------------------------------------------------------------
// RubricEvaluator
// ---------------------------------------------------------------------------

/** A single rubric criterion with name, weight, and scoring function. */
export interface RubricCriterion {
  readonly name: string;
  readonly weight: number;
  readonly score: (input: string, output: string) => number | Promise<number>;
}

/**
 * Scores output against a set of weighted rubric criteria.
 */
export class RubricEvaluator implements RefinementEvaluator {
  private readonly criteria: readonly RubricCriterion[];
  private readonly qualityThreshold: number;

  constructor(criteria: readonly RubricCriterion[], qualityThreshold = 0.8) {
    this.criteria = criteria;
    this.qualityThreshold = qualityThreshold;
  }

  async evaluate(
    input: string,
    output: string,
  ): Promise<{ score: number; feedback: string; qualityMet: boolean }> {
    let totalWeight = 0;
    let weightedSum = 0;
    const feedbackParts: string[] = [];

    for (const criterion of this.criteria) {
      const criterionScore = await criterion.score(input, output);
      const clampedScore = Math.max(0, Math.min(1, criterionScore));
      totalWeight += criterion.weight;
      weightedSum += criterion.weight * clampedScore;
      feedbackParts.push(`${criterion.name}: ${clampedScore.toFixed(2)}`);
    }

    const score = totalWeight > 0 ? weightedSum / totalWeight : 0;
    const feedback = feedbackParts.join("; ");

    return {
      score,
      feedback,
      qualityMet: score >= this.qualityThreshold,
    };
  }
}

// ---------------------------------------------------------------------------
// CompositeRefinementEvaluator
// ---------------------------------------------------------------------------

/** An evaluator with an associated weight for compositing. */
export interface WeightedEvaluator {
  readonly evaluator: RefinementEvaluator;
  readonly weight: number;
}

/**
 * Combines multiple evaluators into a weighted average score.
 */
export class CompositeRefinementEvaluator implements RefinementEvaluator {
  private readonly evaluators: readonly WeightedEvaluator[];
  private readonly qualityThreshold: number;

  constructor(evaluators: readonly WeightedEvaluator[], qualityThreshold = 0.8) {
    this.evaluators = evaluators;
    this.qualityThreshold = qualityThreshold;
  }

  async evaluate(
    input: string,
    output: string,
    context?: PatternContext,
  ): Promise<{ score: number; feedback: string; qualityMet: boolean }> {
    let totalWeight = 0;
    let weightedSum = 0;
    const feedbackParts: string[] = [];

    for (const { evaluator, weight } of this.evaluators) {
      const result = await evaluator.evaluate(input, output, context);
      totalWeight += weight;
      weightedSum += weight * result.score;
      feedbackParts.push(result.feedback);
    }

    const score = totalWeight > 0 ? weightedSum / totalWeight : 0;
    const feedback = feedbackParts.join("\n");

    return {
      score,
      feedback,
      qualityMet: score >= this.qualityThreshold,
    };
  }
}

/**
 * Goal Evaluators — Four implementations of GoalEvaluatorProtocol,
 * ranked cheapest to most expensive.
 *
 * Ported from Python: workflows/evaluators.py
 */

import type { AgentLike } from "../runner/agent-runner.js";
import type { RunnerProtocol } from "../runner/types.js";
import type { GoalEvaluationResult, GoalEvaluatorProtocol, PatternContext } from "./base.js";

// ---------------------------------------------------------------------------
// SimpleGoalEvaluator — pattern matching (no LLM call)
// ---------------------------------------------------------------------------

export interface SimpleGoalEvaluatorOptions {
  readonly successPatterns?: readonly string[];
  readonly failurePatterns?: readonly string[];
}

/**
 * Pattern-matching evaluator: checks output for success/failure substrings.
 * Returns not-confident if no patterns match.
 */
export class SimpleGoalEvaluator implements GoalEvaluatorProtocol {
  private readonly successPatterns: readonly string[];
  private readonly failurePatterns: readonly string[];

  constructor(options: SimpleGoalEvaluatorOptions = {}) {
    this.successPatterns = options.successPatterns ?? ["GOAL_ACHIEVED", "TASK_COMPLETE", "SUCCESS"];
    this.failurePatterns = options.failurePatterns ?? ["CANNOT_PROCEED", "FAILED", "ERROR"];
  }

  async evaluate(
    _goal: string,
    output: string,
    _context?: PatternContext,
  ): Promise<GoalEvaluationResult> {
    const upper = output.toUpperCase();

    for (const pattern of this.successPatterns) {
      if (upper.includes(pattern.toUpperCase())) {
        return [true, `Matched success pattern: ${pattern}`, true] as const;
      }
    }

    for (const pattern of this.failurePatterns) {
      if (upper.includes(pattern.toUpperCase())) {
        return [false, `Matched failure pattern: ${pattern}`, true] as const;
      }
    }

    return [false, "No patterns matched", false] as const;
  }
}

// ---------------------------------------------------------------------------
// SelfEvalGoalEvaluator — parses GOAL_STATUS/PROGRESS markers
// ---------------------------------------------------------------------------

/**
 * Parses agent output for structured markers:
 *   GOAL_STATUS: ACHIEVED|NOT_ACHIEVED
 *   PROGRESS: <text>
 */
export class SelfEvalGoalEvaluator implements GoalEvaluatorProtocol {
  async evaluate(
    _goal: string,
    output: string,
    _context?: PatternContext,
  ): Promise<GoalEvaluationResult> {
    const statusMatch = /GOAL_STATUS:\s*(ACHIEVED|NOT_ACHIEVED)/i.exec(output);
    const progressMatch = /PROGRESS:\s*(.+)/i.exec(output);

    if (statusMatch) {
      const achieved = statusMatch[1]?.toUpperCase() === "ACHIEVED";
      const reason =
        progressMatch?.[1]?.trim() ?? (achieved ? "Goal achieved" : "Goal not achieved");
      return [achieved, reason, true] as const;
    }

    if (progressMatch) {
      return [false, progressMatch[1]!.trim(), false] as const;
    }

    return [false, "No GOAL_STATUS or PROGRESS markers found", false] as const;
  }
}

// ---------------------------------------------------------------------------
// LLMGoalEvaluator — uses an evaluator agent
// ---------------------------------------------------------------------------

export interface LLMGoalEvaluatorOptions {
  readonly agent: AgentLike;
  readonly runner: RunnerProtocol;
}

/**
 * Sends goal + output to an evaluator agent, parses GOAL_STATUS from response.
 */
export class LLMGoalEvaluator implements GoalEvaluatorProtocol {
  private readonly agent: AgentLike;
  private readonly runner: RunnerProtocol;

  constructor(options: LLMGoalEvaluatorOptions) {
    this.agent = options.agent;
    this.runner = options.runner;
  }

  async evaluate(
    goal: string,
    output: string,
    _context?: PatternContext,
  ): Promise<GoalEvaluationResult> {
    const prompt = [
      "Evaluate whether the following output achieves the stated goal.",
      "",
      `GOAL: ${goal}`,
      "",
      `OUTPUT: ${output}`,
      "",
      "Respond with exactly one of:",
      "  GOAL_STATUS: ACHIEVED",
      "  GOAL_STATUS: NOT_ACHIEVED",
      "Followed by:",
      "  PROGRESS: <brief explanation>",
    ].join("\n");

    const result = await this.runner.run(this.agent, prompt);

    // Parse the response using SelfEvalGoalEvaluator logic
    const selfEval = new SelfEvalGoalEvaluator();
    return selfEval.evaluate(goal, result.response);
  }
}

// ---------------------------------------------------------------------------
// EvaluatorChain — cascade, stopping on first confident result
// ---------------------------------------------------------------------------

/**
 * Tries evaluators in order, stops on first confident result.
 * Falls back to last result if none are confident.
 */
export class EvaluatorChain implements GoalEvaluatorProtocol {
  private readonly evaluators: readonly GoalEvaluatorProtocol[];

  constructor(evaluators: GoalEvaluatorProtocol[]) {
    this.evaluators = evaluators;
  }

  async evaluate(
    goal: string,
    output: string,
    context?: PatternContext,
  ): Promise<GoalEvaluationResult> {
    let lastResult: GoalEvaluationResult = [false, "No evaluators", false] as const;

    for (const evaluator of this.evaluators) {
      const result = await evaluator.evaluate(goal, output, context);
      lastResult = result;

      const [, , confident] = result;
      if (confident) {
        return result;
      }
    }

    return lastResult;
  }
}

/**
 * TaskLoop — Goal-driven iterative loop.
 *
 * Runs an agent toward a goal, evaluating progress each iteration.
 *
 * Ported from Python: workflows/loops/task.py
 */

import type { AgentLike } from "../runner/agent-runner.js";
import type { RunnerProtocol, ToolExecutor } from "../runner/types.js";
import type { GoalEvaluatorProtocol, PatternContext, PatternHooks, PatternResult } from "./base.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TaskExitReason = "goal_achieved" | "max_iterations" | "explicit_stop" | "error";

export interface TaskState {
  readonly iteration: number;
  readonly history: readonly string[];
  getHistorySummary(): string;
}

export interface TaskResult extends PatternResult {
  readonly exitReason: TaskExitReason;
  readonly iterations: number;
  readonly state: TaskState;
}

// ---------------------------------------------------------------------------
// TaskLoopOptions
// ---------------------------------------------------------------------------

export interface TaskLoopOptions {
  readonly maxIterations?: number;
  readonly stopPhrases?: readonly string[];
  readonly includeHistory?: boolean;
  readonly hooks?: PatternHooks;
}

export interface TaskRunOptions {
  readonly runner: RunnerProtocol;
  readonly toolExecutor?: ToolExecutor;
  readonly hooks?: PatternHooks;
}

// ---------------------------------------------------------------------------
// TaskLoop
// ---------------------------------------------------------------------------

const DEFAULT_STOP_PHRASES = ["TASK_COMPLETE", "CANNOT_PROCEED"];

/**
 * Iterative loop that runs an agent toward a goal, evaluating progress.
 *
 * Example:
 *   const loop = new TaskLoop(agent, evaluator, { maxIterations: 5 });
 *   const result = await loop.run("Write a poem about TypeScript", {}, { runner });
 */
export class TaskLoop {
  private readonly agent: AgentLike;
  private readonly goalEvaluator: GoalEvaluatorProtocol;
  private readonly maxIterations: number;
  private readonly stopPhrases: readonly string[];
  private readonly includeHistory: boolean;
  private readonly defaultHooks: PatternHooks | undefined;

  constructor(
    agent: AgentLike,
    goalEvaluator: GoalEvaluatorProtocol,
    options: TaskLoopOptions = {},
  ) {
    this.agent = agent;
    this.goalEvaluator = goalEvaluator;
    this.maxIterations = options.maxIterations ?? 10;
    this.stopPhrases = options.stopPhrases ?? DEFAULT_STOP_PHRASES;
    this.includeHistory = options.includeHistory ?? true;
    this.defaultHooks = options.hooks;
  }

  async run(
    goal: string,
    context: PatternContext = {},
    options?: TaskRunOptions,
  ): Promise<TaskResult> {
    const runner = options?.runner;
    const hooks = options?.hooks ?? this.defaultHooks;
    const toolExecutor = options?.toolExecutor;

    if (!runner) {
      throw new Error("Runner is required for TaskLoop execution");
    }

    await hooks?.onPatternStart?.({
      type: "pattern.start",
      patternName: "TaskLoop",
      timestamp: new Date(),
    });

    const history: string[] = [];
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let exitReason: TaskExitReason = "max_iterations";
    let finalContent = "";

    for (let iteration = 0; iteration < this.maxIterations; iteration++) {
      await hooks?.onIterationStart?.({
        type: "pattern.iteration.start",
        iteration,
        timestamp: new Date(),
      });

      // Build prompt
      const prompt = this.buildPrompt(goal, history, context);

      // Run agent
      const runResult = await runner.run(this.agent, prompt, { toolExecutor });
      const content = runResult.response;
      totalInputTokens += runResult.inputTokens;
      totalOutputTokens += runResult.outputTokens;
      finalContent = content;
      history.push(content);

      await hooks?.onIterationComplete?.({
        type: "pattern.iteration.complete",
        iteration,
        timestamp: new Date(),
      });

      // Check stop phrases
      if (this.containsStopPhrase(content)) {
        exitReason = "explicit_stop";
        break;
      }

      // Evaluate goal
      const [achieved] = await this.goalEvaluator.evaluate(goal, content, context);
      if (achieved) {
        exitReason = "goal_achieved";
        break;
      }
    }

    const state: TaskState = {
      iteration: history.length,
      history: Object.freeze([...history]),
      getHistorySummary() {
        return history.join("\n---\n");
      },
    };

    const result: TaskResult = Object.freeze({
      exitReason,
      iterations: history.length,
      state,
      totalInputTokens,
      totalOutputTokens,
      succeeded: exitReason === "goal_achieved",
      finalContent,
    });

    await hooks?.onPatternComplete?.({
      type: "pattern.complete",
      patternName: "TaskLoop",
      result,
      timestamp: new Date(),
    });

    return result;
  }

  private buildPrompt(goal: string, history: readonly string[], _context: PatternContext): string {
    const parts = [`GOAL: ${goal}`];

    if (this.includeHistory && history.length > 0) {
      parts.push("");
      parts.push("PREVIOUS RESPONSES:");
      for (let i = 0; i < history.length; i++) {
        parts.push(`[Iteration ${i + 1}]: ${history[i]}`);
      }
    }

    parts.push("");
    parts.push("Continue working toward the goal.");

    return parts.join("\n");
  }

  private containsStopPhrase(content: string): boolean {
    const upper = content.toUpperCase();
    return this.stopPhrases.some((phrase) => upper.includes(phrase.toUpperCase()));
  }
}

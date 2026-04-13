/**
 * Workflow base types — shared types, events, hooks, and helpers
 * that all workflow patterns depend on.
 *
 * Ported from Python: workflows/base.py
 */

import type { AgentLike } from "../runner/agent-runner.js";
import type { RunResult, RunnerProtocol, ToolExecutor } from "../runner/types.js";

// Re-export AgentLike so workflow consumers don't need to import from runner
export type { AgentLike } from "../runner/agent-runner.js";

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

/** Shared context passed through workflow steps. */
export type PatternContext = Record<string, unknown>;

/** A message template: either a static string or a function that builds one. */
export type MessageTemplate = string | ((context: PatternContext) => string);

// ---------------------------------------------------------------------------
// Step
// ---------------------------------------------------------------------------

/** A single step in a workflow pattern. */
export interface Step {
  readonly agent: AgentLike;
  readonly messageTemplate: MessageTemplate;
  readonly name?: string;
  readonly outputKey?: string;
  readonly contextExtractor?: (result: StepResult, context: PatternContext) => PatternContext;
}

// ---------------------------------------------------------------------------
// StepResult
// ---------------------------------------------------------------------------

/** Result of executing a single step. */
export interface StepResult {
  readonly stepName: string;
  readonly runResult: RunResult;
  /** Shortcut for `runResult.response`. */
  readonly content: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/**
 * Create a frozen StepResult from a RunResult.
 */
export function createStepResult(stepName: string, runResult: RunResult): StepResult {
  return Object.freeze({
    stepName,
    runResult,
    content: runResult.response,
    inputTokens: runResult.inputTokens,
    outputTokens: runResult.outputTokens,
  });
}

// ---------------------------------------------------------------------------
// PatternResult
// ---------------------------------------------------------------------------

/** Aggregate result of a workflow pattern execution. */
export interface PatternResult {
  readonly totalInputTokens: number;
  readonly totalOutputTokens: number;
  readonly succeeded: boolean;
  readonly finalContent: string;
}

// ---------------------------------------------------------------------------
// PatternEvent — discriminated union of 7 event types
// ---------------------------------------------------------------------------

export interface PatternStartEvent {
  readonly type: "pattern.start";
  readonly patternName: string;
  readonly timestamp: Date;
}

export interface PatternStepStartEvent {
  readonly type: "pattern.step.start";
  readonly stepName: string;
  readonly stepIndex: number;
  readonly timestamp: Date;
}

export interface PatternStepCompleteEvent {
  readonly type: "pattern.step.complete";
  readonly stepName: string;
  readonly stepIndex: number;
  readonly result: StepResult;
  readonly timestamp: Date;
}

export interface PatternStepErrorEvent {
  readonly type: "pattern.step.error";
  readonly stepName: string;
  readonly stepIndex: number;
  readonly error: Error;
  readonly timestamp: Date;
}

export interface PatternIterationStartEvent {
  readonly type: "pattern.iteration.start";
  readonly iteration: number;
  readonly timestamp: Date;
}

export interface PatternIterationCompleteEvent {
  readonly type: "pattern.iteration.complete";
  readonly iteration: number;
  readonly timestamp: Date;
}

export interface PatternCompleteEvent {
  readonly type: "pattern.complete";
  readonly patternName: string;
  readonly result: PatternResult;
  readonly timestamp: Date;
}

export type PatternEvent =
  | PatternStartEvent
  | PatternStepStartEvent
  | PatternStepCompleteEvent
  | PatternStepErrorEvent
  | PatternIterationStartEvent
  | PatternIterationCompleteEvent
  | PatternCompleteEvent;

// ---------------------------------------------------------------------------
// PatternHooks
// ---------------------------------------------------------------------------

/**
 * Callbacks for pattern lifecycle events.
 *
 * NOTE: These are workflow-level hooks for pattern orchestration.
 * They are NOT the same as the deprecated runner-level Hooks interface.
 */
export interface PatternHooks {
  onPatternStart?: (event: PatternStartEvent) => void | Promise<void>;
  onStepStart?: (event: PatternStepStartEvent) => void | Promise<void>;
  onStepComplete?: (event: PatternStepCompleteEvent) => void | Promise<void>;
  onStepError?: (event: PatternStepErrorEvent) => void | Promise<void>;
  onIterationStart?: (event: PatternIterationStartEvent) => void | Promise<void>;
  onIterationComplete?: (event: PatternIterationCompleteEvent) => void | Promise<void>;
  onPatternComplete?: (event: PatternCompleteEvent) => void | Promise<void>;
}

// ---------------------------------------------------------------------------
// PatternRunOptions
// ---------------------------------------------------------------------------

/** Options passed to pattern.run(). */
export interface PatternRunOptions {
  readonly runner: RunnerProtocol;
  readonly hooks?: PatternHooks;
  readonly toolExecutor?: ToolExecutor;
  readonly traceId?: string;
}

// ---------------------------------------------------------------------------
// PatternProtocol
// ---------------------------------------------------------------------------

/** Interface that all workflow patterns implement. */
export interface PatternProtocol {
  run(context?: PatternContext, options?: PatternRunOptions): Promise<PatternResult>;
}

// ---------------------------------------------------------------------------
// GoalEvaluatorProtocol
// ---------------------------------------------------------------------------

/** Result tuple: [achieved, reason, confident]. */
export type GoalEvaluationResult = readonly [achieved: boolean, reason: string, confident: boolean];

/** Protocol for evaluating whether a goal has been achieved. */
export interface GoalEvaluatorProtocol {
  evaluate(goal: string, output: string, context?: PatternContext): Promise<GoalEvaluationResult>;
}

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

/**
 * Resolve a message template to a string.
 */
export function resolveMessage(template: MessageTemplate, context: PatternContext): string {
  if (typeof template === "string") {
    return template;
  }
  return template(context);
}

/**
 * Generate a step name, falling back to `step_<index>` if none provided.
 */
export function makeStepName(name: string | undefined, index: number): string {
  if (name !== undefined && name !== "") {
    return name;
  }
  return `step_${index}`;
}

/**
 * Execute a single step: resolve message, run agent, return result.
 */
export async function executeStep(
  step: Step,
  context: PatternContext,
  runner: RunnerProtocol,
  toolExecutor?: ToolExecutor,
): Promise<StepResult> {
  const message = resolveMessage(step.messageTemplate, context);
  const runResult = await runner.run(step.agent, message, { toolExecutor });
  const stepName = makeStepName(step.name, 0);
  return createStepResult(stepName, runResult);
}

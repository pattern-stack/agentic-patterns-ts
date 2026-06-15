/**
 * Sequential — Chain agents in sequence, threading context through the pipeline.
 *
 * Ported from Python: workflows/compositions/sequential.py
 */

import type {
  PatternContext,
  PatternProtocol,
  PatternResult,
  PatternRunOptions,
  Step,
  StepResult,
} from "./base.js";
import { applyStepModel, createStepResult, makeStepName, resolveMessage } from "./base.js";

// ---------------------------------------------------------------------------
// SequentialResult
// ---------------------------------------------------------------------------

export interface SequentialResult extends PatternResult {
  readonly steps: ReadonlyArray<StepResult | PatternResult>;
  readonly finalContext: Readonly<PatternContext>;
}

// ---------------------------------------------------------------------------
// SequentialOptions
// ---------------------------------------------------------------------------

export interface SequentialOptions {
  readonly continueOnError?: boolean;
}

// ---------------------------------------------------------------------------
// Sequential
// ---------------------------------------------------------------------------

/**
 * Chain agents in sequence, threading context through the pipeline.
 *
 * Each step reads context, writes via `outputKey` and `contextExtractor`.
 * Supports nested patterns (any PatternProtocol) as steps.
 *
 * Example:
 *   const seq = new Sequential([
 *     { agent: writer, messageTemplate: "Write about {topic}" },
 *     { agent: reviewer, messageTemplate: (ctx) => `Review: ${ctx.draft}` },
 *   ]);
 */
export class Sequential implements PatternProtocol {
  private readonly steps: ReadonlyArray<Step | PatternProtocol>;
  private readonly continueOnError: boolean;

  constructor(steps: Array<Step | PatternProtocol>, options?: SequentialOptions) {
    this.steps = steps;
    this.continueOnError = options?.continueOnError ?? false;
  }

  async run(context: PatternContext = {}, options?: PatternRunOptions): Promise<SequentialResult> {
    const runner = options?.runner;
    const hooks = options?.hooks;
    const toolExecutor = options?.toolExecutor;

    await hooks?.onPatternStart?.({
      type: "pattern.start",
      patternName: "Sequential",
      timestamp: new Date(),
    });

    let currentContext = { ...context };
    const stepResults: Array<StepResult | PatternResult> = [];
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let succeeded = true;
    let finalContent = "";

    for (let i = 0; i < this.steps.length; i++) {
      const step = this.steps[i]!;

      await hooks?.onStepStart?.({
        type: "pattern.step.start",
        stepName: isStep(step) ? makeStepName(step.name, i) : `nested_${i}`,
        stepIndex: i,
        timestamp: new Date(),
      });

      try {
        let result: StepResult | PatternResult;

        if (isStep(step)) {
          if (!runner) {
            throw new Error("Runner is required for Step execution");
          }
          const message = resolveMessage(step.messageTemplate, currentContext);
          const runResult = await runner.run(applyStepModel(step.agent, step.model), message, {
            toolExecutor,
            maxIterations: step.maxIterations,
          });
          const stepName = makeStepName(step.name, i);
          const stepResult = createStepResult(stepName, runResult);

          // Update context
          if (step.outputKey) {
            currentContext[step.outputKey] = stepResult.content;
          }
          if (step.contextExtractor) {
            currentContext = {
              ...currentContext,
              ...step.contextExtractor(stepResult, currentContext),
            };
          }

          result = stepResult;
          totalInputTokens += stepResult.inputTokens;
          totalOutputTokens += stepResult.outputTokens;
          finalContent = stepResult.content;
        } else {
          // Nested pattern
          const nestedResult = await step.run(currentContext, options);
          result = nestedResult;
          totalInputTokens += nestedResult.totalInputTokens;
          totalOutputTokens += nestedResult.totalOutputTokens;
          finalContent = nestedResult.finalContent;
          if (!nestedResult.succeeded) {
            succeeded = false;
          }
        }

        stepResults.push(result);

        await hooks?.onStepComplete?.({
          type: "pattern.step.complete",
          stepName: isStep(step) ? makeStepName(step.name, i) : `nested_${i}`,
          stepIndex: i,
          result: isStepResult(result)
            ? result
            : createStepResult(`nested_${i}`, {
                response: result.finalContent,
                inputTokens: result.totalInputTokens,
                outputTokens: result.totalOutputTokens,
                toolCallsCount: 0,
                iterations: 1,
                finishReason: "stop",
              }),
          timestamp: new Date(),
        });
      } catch (error) {
        succeeded = false;
        const err = error instanceof Error ? error : new Error(String(error));

        await hooks?.onStepError?.({
          type: "pattern.step.error",
          stepName: isStep(step) ? makeStepName(step.name, i) : `nested_${i}`,
          stepIndex: i,
          error: err,
          timestamp: new Date(),
        });

        if (!this.continueOnError) {
          break;
        }
      }
    }

    const result: SequentialResult = Object.freeze({
      steps: Object.freeze(stepResults),
      finalContext: Object.freeze(currentContext),
      totalInputTokens,
      totalOutputTokens,
      succeeded,
      finalContent,
    });

    await hooks?.onPatternComplete?.({
      type: "pattern.complete",
      patternName: "Sequential",
      result,
      timestamp: new Date(),
    });

    return result;
  }
}

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

function isStep(step: Step | PatternProtocol): step is Step {
  return "agent" in step && "messageTemplate" in step;
}

function isStepResult(result: StepResult | PatternResult): result is StepResult {
  return "stepName" in result;
}

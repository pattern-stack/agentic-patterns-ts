/**
 * `Sequential` — N named steps in order, threading typed output node→node
 * (DESIGN §6.2).
 *
 * The single typed `Sequential` (replaces the legacy string-pinned class). A
 * fluent builder whose each `.then()` seam type-checks `step[i].TOut ===
 * step[i+1].TIn` — return-value chaining REPLACES the old `outputKey` string
 * threading. The built object implements {@link Node}, so it nests anywhere a
 * node is accepted.
 */

import type { PatternHooks } from "./base.js";
import type { Node, NodeOutcome, NodeResult, NodeRunContext } from "./node.js";
import { createSlotStore } from "./slot.js";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface SeqOpts {
  /** Continue past a child returning `succeeded: false`. Default `false` (stop). */
  readonly continueOnError?: boolean;
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

/**
 * Accumulates a typed pipeline. `TIn` is the pipeline input; `TCur` is the
 * output type of the most recently appended node (and the required input type
 * of the next `.then()`).
 */
export class SequentialBuilder<TIn, TCur> {
  private constructor(
    // biome-ignore lint/suspicious/noExplicitAny: heterogeneous node list; the typed seams live on the builder methods.
    private readonly nodes: ReadonlyArray<Node<any, any>>,
    private readonly opts: SeqOpts,
  ) {}

  /** Begin a pipeline with its first node. */
  static start<A, B>(first: Node<A, B>, opts?: SeqOpts): SequentialBuilder<A, B> {
    return new SequentialBuilder<A, B>([first], opts ?? {});
  }

  /**
   * Append a node. Compile error if `node`'s `TIn` ≠ the current `TCur` — this
   * typed seam REPLACES `outputKey` threading.
   */
  // biome-ignore lint/suspicious/noThenProperty: `.then()` is the intended fluent-builder seam (DESIGN §6.2), not a thenable.
  then<TNext>(node: Node<TCur, TNext>): SequentialBuilder<TIn, TNext> {
    return new SequentialBuilder<TIn, TNext>([...this.nodes, node], this.opts);
  }

  /** Fold the pipeline into a single runnable `Node<TIn, TCur>`. */
  build(name?: string): Node<TIn, TCur> {
    return new SequentialNode<TIn, TCur>(this.nodes, this.opts, name);
  }
}

/** Public alias — author as `Sequential.start(a).then(b).build()`. */
export const Sequential = SequentialBuilder;

// ---------------------------------------------------------------------------
// The folded node
// ---------------------------------------------------------------------------

class SequentialNode<TIn, TCur> implements Node<TIn, TCur> {
  constructor(
    // biome-ignore lint/suspicious/noExplicitAny: heterogeneous, type-checked at build time.
    private readonly nodes: ReadonlyArray<Node<any, any>>,
    private readonly opts: SeqOpts,
    readonly name?: string,
  ) {}

  async run(input: TIn, ctx: NodeRunContext): Promise<NodeResult<TCur>> {
    const hooks: PatternHooks | undefined = ctx.hooks;
    const patternName = this.name ?? "Sequential";
    const continueOnError = this.opts.continueOnError ?? false;
    const childCtx: NodeRunContext = { ...ctx, slots: ctx.slots ?? createSlotStore() };

    await hooks?.onPatternStart?.({
      type: "pattern.start",
      patternName,
      timestamp: new Date(),
    });

    let current: unknown = input;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let succeeded = true;
    let error: Error | undefined;

    for (let i = 0; i < this.nodes.length; i++) {
      const node = this.nodes[i]!;
      const stepName = node.name ?? `step_${i}`;

      await hooks?.onStepStart?.({
        type: "pattern.step.start",
        stepName,
        stepIndex: i,
        timestamp: new Date(),
      });

      const res = await node.run(current, childCtx);
      totalInputTokens += res.totalInputTokens;
      totalOutputTokens += res.totalOutputTokens;
      current = res.output;

      if (res.succeeded) {
        const outcome: NodeOutcome<unknown> = {
          nodeName: stepName,
          output: res.output,
          succeeded: true,
          inputTokens: res.totalInputTokens,
          outputTokens: res.totalOutputTokens,
        };
        await hooks?.onStepComplete?.({
          type: "pattern.step.complete",
          stepName,
          stepIndex: i,
          result: outcome,
          timestamp: new Date(),
        });
      } else {
        succeeded = false;
        error = res.error;
        await hooks?.onStepError?.({
          type: "pattern.step.error",
          stepName,
          stepIndex: i,
          error: res.error ?? new Error(`Step "${stepName}" failed`),
          timestamp: new Date(),
        });
        if (!continueOnError) break;
      }
    }

    const result: NodeResult<TCur> = Object.freeze({
      output: current as TCur,
      succeeded,
      error,
      totalInputTokens,
      totalOutputTokens,
    });

    await hooks?.onPatternComplete?.({
      type: "pattern.complete",
      patternName,
      result,
      timestamp: new Date(),
    });

    return result;
  }
}

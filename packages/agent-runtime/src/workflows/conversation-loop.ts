/**
 * ConversationLoop — Multi-turn conversation orchestration.
 *
 * Wraps the Conversation class, driving exchanges via external
 * inputFn/outputFn callbacks. Exits on exit phrase, max exchanges, or error.
 *
 * Ported from Python: workflows/loops/conversation.py
 */

import { Conversation } from "../conversation/conversation.js";
import type { ConversationStoreProtocol } from "../conversation/store.js";
import type { AgentLike } from "../runner/agent-runner.js";
import type { RunnerProtocol, ToolExecutor } from "../runner/types.js";
import type { PatternHooks, PatternResult } from "./base.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ConversationExitReason = "exit_phrase" | "max_exchanges" | "input_closed" | "error";

export interface ConversationResult extends PatternResult {
  readonly exitReason: ConversationExitReason;
  readonly exchangeCount: number;
  readonly conversation: Conversation;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface ConversationLoopOptions {
  readonly maxExchanges?: number;
  readonly exitPhrases?: readonly string[];
  readonly store?: ConversationStoreProtocol;
  readonly toolExecutor?: ToolExecutor;
  readonly hooks?: PatternHooks;
}

export interface ConversationRunOptions {
  readonly runner: RunnerProtocol;
  readonly inputFn: () => string | null | Promise<string | null>;
  readonly outputFn?: (response: string) => void | Promise<void>;
  readonly hooks?: PatternHooks;
}

// ---------------------------------------------------------------------------
// ConversationLoop
// ---------------------------------------------------------------------------

const DEFAULT_EXIT_PHRASES = ["exit", "quit", "bye"];

/**
 * Multi-turn conversation loop with external I/O callbacks.
 *
 * Example:
 *   const loop = new ConversationLoop(agent, { maxExchanges: 10 });
 *   const result = await loop.run({
 *     runner,
 *     inputFn: () => readLine(),
 *     outputFn: (r) => console.log(r),
 *   });
 */
export class ConversationLoop {
  private readonly agent: AgentLike;
  private readonly maxExchanges: number;
  private readonly exitPhrases: readonly string[];
  private readonly store: ConversationStoreProtocol | undefined;
  private readonly toolExecutor: ToolExecutor | undefined;
  private readonly defaultHooks: PatternHooks | undefined;

  constructor(agent: AgentLike, options: ConversationLoopOptions = {}) {
    this.agent = agent;
    this.maxExchanges = options.maxExchanges ?? 100;
    this.exitPhrases = options.exitPhrases ?? DEFAULT_EXIT_PHRASES;
    this.store = options.store;
    this.toolExecutor = options.toolExecutor;
    this.defaultHooks = options.hooks;
  }

  async run(options: ConversationRunOptions): Promise<ConversationResult> {
    const { runner, inputFn, outputFn } = options;
    const hooks = options.hooks ?? this.defaultHooks;

    const conversation = new Conversation(this.agent, runner, {
      store: this.store,
      toolExecutor: this.toolExecutor,
    });

    await hooks?.onPatternStart?.({
      type: "pattern.start",
      patternName: "ConversationLoop",
      timestamp: new Date(),
    });

    let exitReason: ConversationExitReason = "max_exchanges";
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let finalContent = "";

    while (conversation.exchangeCount < this.maxExchanges) {
      await hooks?.onIterationStart?.({
        type: "pattern.iteration.start",
        iteration: conversation.exchangeCount,
        timestamp: new Date(),
      });

      // Get user input
      const userInput = await inputFn();

      if (userInput === null) {
        exitReason = "input_closed";
        break;
      }

      // Check exit phrases
      if (this.isExitPhrase(userInput)) {
        exitReason = "exit_phrase";
        break;
      }

      // Send message and get response
      const exchange = await conversation.send(userInput);
      totalInputTokens += exchange.inputTokens;
      totalOutputTokens += exchange.outputTokens;
      finalContent = exchange.assistant;

      // Output callback
      if (outputFn) {
        await outputFn(exchange.assistant);
      }

      await hooks?.onIterationComplete?.({
        type: "pattern.iteration.complete",
        iteration: conversation.exchangeCount - 1,
        timestamp: new Date(),
      });
    }

    const result: ConversationResult = Object.freeze({
      exitReason,
      exchangeCount: conversation.exchangeCount,
      conversation,
      totalInputTokens,
      totalOutputTokens,
      succeeded: true,
      finalContent,
    });

    await hooks?.onPatternComplete?.({
      type: "pattern.complete",
      patternName: "ConversationLoop",
      result,
      timestamp: new Date(),
    });

    return result;
  }

  private isExitPhrase(input: string): boolean {
    const lower = input.toLowerCase().trim();
    return this.exitPhrases.some((phrase) => lower === phrase.toLowerCase());
  }
}

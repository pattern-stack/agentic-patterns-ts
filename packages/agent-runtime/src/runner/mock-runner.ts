/**
 * MockRunner — Deterministic runner for testing agents without LLM calls.
 *
 * Pattern-based response routing with tool call simulation and event emission.
 * Implements RunnerProtocol for drop-in testing.
 */

import { generateId } from "ai";
import type { ZodType } from "zod";

import type { AgentEvent } from "../events/types.js";
import { createEvent } from "../events/types.js";
import type {
  AgentLike,
  RunOptions,
  RunResult,
  RunnerProtocol,
  StructuredRunResult,
} from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A canned response for the mock runner. */
export interface MockResponse {
  content: string;
  toolCalls?: Array<{
    name: string;
    arguments: Record<string, unknown>;
    result?: unknown;
  }>;
  inputTokens?: number;
  outputTokens?: number;
  delayMs?: number;
  error?: Error;
  /**
   * Object returned by {@link MockRunner.runStructured} when this response
   * matches. Validated against the caller's schema at call time so typed
   * `AgentStep`s are testable without an LLM.
   */
  object?: unknown;
}

/** A recorded call to the mock runner. */
export interface MockCall {
  message: string;
  agentName: string;
  model: string;
  /** `RunOptions.maxIterations` the call was made with (undefined = runner default). */
  maxIterations?: number;
  timestamp: Date;
}

// ---------------------------------------------------------------------------
// MockRunner
// ---------------------------------------------------------------------------

/**
 * Deterministic runner for testing agents without LLM calls.
 *
 * Supports substring-based trigger matching, wildcard defaults,
 * tool call simulation, delay simulation, and full event lifecycle.
 *
 * Example:
 *   const runner = new MockRunner()
 *     .addResponse("hello", { content: "Hi there!" })
 *     .addResponse("*", { content: "Default response" });
 */
export class MockRunner implements RunnerProtocol {
  private _responses: Array<{ trigger: string; response: MockResponse }> = [];
  private _callHistory: MockCall[] = [];

  /** Read-only call history. */
  get callHistory(): readonly MockCall[] {
    return this._callHistory;
  }

  /**
   * Add a canned response.
   *
   * @param trigger - Substring to match against the message, or "*" for wildcard default.
   * @param response - The response to return when triggered.
   * @returns this for fluent chaining.
   */
  addResponse(trigger: string, response: MockResponse): this {
    this._responses.push({ trigger, response });
    return this;
  }

  /**
   * Clear all responses and call history.
   *
   * @returns this for fluent chaining.
   */
  clear(): this {
    this._responses = [];
    this._callHistory = [];
    return this;
  }

  /**
   * Execute an agent and return a result (non-streaming).
   */
  async run(agent: AgentLike, message: string, options?: RunOptions): Promise<RunResult> {
    const matched = this._findResponse(message);

    this._callHistory.push({
      message,
      agentName: agent.role.name,
      model: agent.getModel() ?? "",
      maxIterations: options?.maxIterations,
      timestamp: new Date(),
    });

    if (matched.delayMs && matched.delayMs > 0) {
      await delay(matched.delayMs);
    }

    if (matched.error) {
      throw matched.error;
    }

    let toolCallsCount = 0;
    if (matched.toolCalls) {
      if (options?.toolExecutor) {
        for (const tc of matched.toolCalls) {
          await options.toolExecutor.execute(tc.name, tc.arguments);
          toolCallsCount++;
        }
      } else {
        toolCallsCount = matched.toolCalls.length;
      }
    }

    return {
      response: matched.content,
      inputTokens: matched.inputTokens ?? 0,
      outputTokens: matched.outputTokens ?? 0,
      toolCallsCount,
      iterations: 1,
      finishReason: "stop",
    };
  }

  /**
   * Execute an agent and return a typed object validated against `schema`.
   *
   * Mirrors {@link run}'s matching/recording, then validates the matched
   * response's configured `object` against the caller's schema. Throws if no
   * `object` was configured or it fails validation — so a typed `AgentStep`
   * can be exercised deterministically without an LLM.
   */
  async runStructured<T>(
    agent: AgentLike,
    message: string,
    schema: ZodType<T>,
    options?: RunOptions,
  ): Promise<StructuredRunResult<T>> {
    const matched = this._findResponse(message);

    this._callHistory.push({
      message,
      agentName: agent.role.name,
      model: agent.getModel() ?? "",
      maxIterations: options?.maxIterations,
      timestamp: new Date(),
    });

    if (matched.delayMs && matched.delayMs > 0) {
      await delay(matched.delayMs);
    }

    if (matched.error) {
      throw matched.error;
    }

    if (matched.object === undefined) {
      throw new Error(
        "MockRunner.runStructured: matched response has no `object` configured. " +
          "Add one via addResponse(trigger, { content, object }).",
      );
    }

    const parsed = schema.safeParse(matched.object);
    if (!parsed.success) {
      throw new Error(
        `MockRunner.runStructured: configured object failed schema validation — ${parsed.error.message}`,
      );
    }

    return {
      response: JSON.stringify(parsed.data),
      inputTokens: matched.inputTokens ?? 0,
      outputTokens: matched.outputTokens ?? 0,
      toolCallsCount: 0,
      iterations: 1,
      finishReason: "stop",
      object: parsed.data,
    };
  }

  /**
   * Execute an agent with streaming event emission.
   */
  async *stream(
    agent: AgentLike,
    message: string,
    options?: RunOptions,
  ): AsyncGenerator<AgentEvent> {
    const traceId = options?.traceId ?? generateId();
    const runId = generateId();

    yield createEvent("agent.message.start", {
      traceId,
      runId,
      agentName: agent.role.name,
    });

    const matched = this._findResponse(message);

    this._callHistory.push({
      message,
      agentName: agent.role.name,
      model: agent.getModel() ?? "",
      maxIterations: options?.maxIterations,
      timestamp: new Date(),
    });

    if (matched.delayMs && matched.delayMs > 0) {
      await delay(matched.delayMs);
    }

    if (matched.error) {
      yield createEvent("agent.error", {
        traceId,
        runId,
        errorType: matched.error.name,
        message: matched.error.message,
        recoverable: false,
        context: {},
      });
      return;
    }

    if (matched.toolCalls) {
      for (const tc of matched.toolCalls) {
        const toolCallId = generateId();
        yield createEvent("agent.tool.start", {
          traceId,
          runId,
          toolCallId,
          toolName: tc.name,
          arguments: tc.arguments,
        });

        let result: unknown = tc.result ?? null;
        let error: string | undefined;
        if (options?.toolExecutor) {
          try {
            result = await options.toolExecutor.execute(tc.name, tc.arguments);
          } catch (e) {
            error = e instanceof Error ? e.message : String(e);
          }
        }

        yield createEvent("agent.tool.end", {
          traceId,
          runId,
          toolCallId,
          toolName: tc.name,
          arguments: tc.arguments,
          result,
          error,
          durationMs: 0,
          resultTokens: 0,
        });
      }
    }

    yield createEvent("agent.message.chunk", {
      traceId,
      runId,
      delta: matched.content,
      chunkIndex: 0,
    });

    yield createEvent("agent.message.complete", {
      traceId,
      runId,
      content: matched.content,
      inputTokens: matched.inputTokens ?? 0,
      outputTokens: matched.outputTokens ?? 0,
      model: agent.getModel() ?? "",
    });
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  /** Find matching response: substring first, then wildcard, then auto-fallback. */
  private _findResponse(message: string): MockResponse {
    for (const entry of this._responses) {
      if (entry.trigger !== "*" && message.includes(entry.trigger)) {
        return entry.response;
      }
    }
    for (const entry of this._responses) {
      if (entry.trigger === "*") {
        return entry.response;
      }
    }
    return { content: `Mock response to: ${message}` };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

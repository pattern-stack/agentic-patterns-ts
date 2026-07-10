/**
 * Runner types — AgentLike, RunResult, ToolExecutor, RunnerProtocol, RunOptions.
 *
 * Ported from Python: systems/runners/base.py
 */

import type { ToolExecutionContext } from "@agentic-patterns/core";
import type { ZodType } from "zod";
import type { AgentEventBus } from "../events/agent-event-bus.js";
import type { AgentEvent } from "../events/types.js";

// ---------------------------------------------------------------------------
// AgentLike — canonical minimal agent shape at the runner protocol boundary
// ---------------------------------------------------------------------------

/**
 * The minimal agent shape consumed by runners, workflows, conversations,
 * and transport adapters.
 *
 * This is a projection of the full `Agent` class (from @agentic-patterns/core)
 * containing only the methods and properties needed to execute a tool loop.
 * `getTools()` returns `unknown[]` so protocol consumers don't need to import
 * `ToolSchema` from core — only `AgentRunner` itself narrows the type when
 * converting tools for the LLM.
 */
export interface AgentLike {
  readonly role: { readonly name: string };
  getModel(): string | undefined;
  getTools(): unknown[];
  renderInitialPrompt(): string;
}

// ---------------------------------------------------------------------------
// RunResult
// ---------------------------------------------------------------------------

/**
 * Result of an agent execution.
 */
export interface RunResult {
  /** The final text response from the agent. */
  readonly response: string;
  /** Total input tokens used across all iterations. */
  readonly inputTokens: number;
  /** Total output tokens generated across all iterations. */
  readonly outputTokens: number;
  /** Total number of tool calls executed. */
  readonly toolCallsCount: number;
  /** Number of loop iterations completed. */
  readonly iterations: number;
  /** Reason the run finished (e.g. "stop", "max_iterations"). */
  readonly finishReason: string;
}

/**
 * Result of a structured agent execution — a {@link RunResult} plus the typed
 * object parsed from the model's structured output.
 */
export type StructuredRunResult<T> = RunResult & {
  /** The schema-valid object produced by the structured-output path. */
  readonly object: T;
};

// ---------------------------------------------------------------------------
// ToolExecutor
// ---------------------------------------------------------------------------

/**
 * Protocol for executing tools.
 *
 * Implementations handle the actual tool execution logic.
 * The runner calls execute() for each tool call from the LLM.
 *
 * `ctx` is an optional {@link ToolExecutionContext} (event sink + correlation
 * ids) — a trailing optional param, so every existing `execute(name, args)`
 * implementation and caller stays assignment-compatible (#102).
 */
export interface ToolExecutor {
  execute(
    name: string,
    args: Record<string, unknown>,
    ctx?: ToolExecutionContext,
  ): Promise<unknown>;
}

// ---------------------------------------------------------------------------
// CanonicalMessage (for message history)
// ---------------------------------------------------------------------------

export interface CanonicalMessagePart {
  readonly type: string;
  readonly content?: string;
  readonly id?: string;
  readonly name?: string;
  readonly tool_name?: string;
  readonly tool_call_id?: string;
  readonly arguments?: Record<string, unknown>;
}

export interface CanonicalMessage {
  readonly kind: "request" | "response";
  readonly parts: CanonicalMessagePart[];
}

// ---------------------------------------------------------------------------
// RunOptions
// ---------------------------------------------------------------------------

/**
 * Options for agent execution.
 */
export interface RunOptions {
  /** Optional conversation history in canonical format. */
  messageHistory?: CanonicalMessage[];
  /** Optional executor for tool calls. */
  toolExecutor?: ToolExecutor;
  /** Optional event bus for emitting agent events. */
  eventBus?: AgentEventBus;
  /** Maximum tool loop iterations (default 10). */
  maxIterations?: number;
  /** Optional trace ID for multi-agent orchestration. */
  traceId?: string;
  /** Optional parent span ID linking to orchestrator. */
  parentSpanId?: string;
  /**
   * Allow open-object nodes (z.record / .passthrough() / .catchall() / z.map)
   * in a `runStructured` schema. Default `false`: the runner THROWS before any
   * LLM call, because schema-subset providers silently decode open objects to
   * `{}` (Gemini's responseSchema conversion drops `additionalProperties`;
   * OpenAI strict mode prohibits open maps). Set `true` only if your provider
   * genuinely supports open objects — the guard then warns once per schema
   * instead. Portable remedy: carry free-form objects as a JSON-encoded string
   * field and decode after parsing (the wire-seam pattern).
   */
  allowOpenObjectSchemas?: boolean;
  /**
   * Opaque host payload copied verbatim onto every `ToolExecutionContext`
   * this run's tool dispatches build (`buildToolCtx`). The runner never
   * reads it. The workflow layer uses it to carry `{ scratchpad, deps }`
   * across the agent-as-tool seam (#124).
   */
  host?: unknown;
}

// ---------------------------------------------------------------------------
// RunnerProtocol
// ---------------------------------------------------------------------------

/**
 * Protocol for agent runners.
 *
 * Runners execute agents with optional tool execution and hooks.
 * Two modes: run() for single response, stream() for streaming.
 */
export interface RunnerProtocol {
  /**
   * Execute an agent and return the final result.
   */
  run(agent: AgentLike, message: string, options?: RunOptions): Promise<RunResult>;

  /**
   * Execute an agent with streaming response.
   * Optional — not all runners support streaming.
   */
  stream?(agent: AgentLike, message: string, options?: RunOptions): AsyncGenerator<AgentEvent>;

  /**
   * Execute an agent and return a typed object validated against `schema`,
   * via a capability-gated structured-output path (see DESIGN §9.4).
   * Optional — not all runners support structured output.
   */
  runStructured?<T>(
    agent: AgentLike,
    message: string,
    schema: ZodType<T>,
    options?: RunOptions,
  ): Promise<StructuredRunResult<T>>;

  /**
   * Release any resources held by the runner (e.g. an isolated
   * CLAUDE_CONFIG_DIR). Optional — runners without resources omit it.
   * Safe to call multiple times; callers may invoke as `runner.dispose?.()`.
   */
  dispose?(): void;
}

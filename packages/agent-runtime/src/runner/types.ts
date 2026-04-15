/**
 * Runner types — AgentLike, RunResult, ToolExecutor, RunnerProtocol, RunOptions.
 *
 * Ported from Python: systems/runners/base.py
 */

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
  getModel(): string;
  getTools(): unknown[];
  getSystemPrompt(): string;
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

// ---------------------------------------------------------------------------
// ToolExecutor
// ---------------------------------------------------------------------------

/**
 * Protocol for executing tools.
 *
 * Implementations handle the actual tool execution logic.
 * The runner calls execute() for each tool call from the LLM.
 */
export interface ToolExecutor {
  execute(name: string, args: Record<string, unknown>): Promise<unknown>;
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
}

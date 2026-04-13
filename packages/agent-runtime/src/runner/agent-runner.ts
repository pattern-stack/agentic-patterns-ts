/**
 * AgentRunner — The standard agentic execution loop on Vercel AI SDK.
 *
 * Ported from Python: systems/runners/agent.py
 *
 * Key differences from Python:
 * - Parallel tool execution via Promise.all (Python is sequential)
 * - Vercel AI SDK handles tool schema conversion (Python manually builds OpenAI JSON)
 * - maxSteps: 1 forces one LLM call per iteration for gate interception control
 * - MockLanguageModelV1 for testing (replaces Python's MockRunner)
 */

import type { ToolSchema } from "@agentic-patterns/core";
import {
  type CoreMessage,
  type LanguageModelV1,
  type ToolCallPart,
  type ToolResultPart,
  generateId,
  generateText,
} from "ai";

import { type AgentEventBus, getAgentEventBus } from "../events/agent-event-bus.js";
import { type AgentEvent, createEvent } from "../events/types.js";
import { convertHistory } from "./message-utils.js";
import type { RunOptions, RunResult, RunnerProtocol, ToolExecutor } from "./types.js";

// ---------------------------------------------------------------------------
// Agent interface (minimal shape needed by the runner)
// ---------------------------------------------------------------------------

/** Minimal agent interface consumed by the runner. */
export interface AgentLike {
  readonly role: { readonly name: string };
  getModel(): string;
  getTools(): ToolSchema[];
  getSystemPrompt(): string;
  renderInitialPrompt(): string;
}

// ---------------------------------------------------------------------------
// ToolCallBlocked error
// ---------------------------------------------------------------------------

export class ToolCallBlocked extends Error {
  readonly toolName: string;
  readonly reason: string;

  constructor(toolName: string, reason: string) {
    super(`Tool call '${toolName}' blocked: ${reason}`);
    this.name = "ToolCallBlocked";
    this.toolName = toolName;
    this.reason = reason;
  }
}

// ---------------------------------------------------------------------------
// AgentRunner
// ---------------------------------------------------------------------------

/**
 * The standard agentic execution loop.
 *
 * Executes agents using a tool loop pattern with the Vercel AI SDK.
 *
 * The runner implements an agentic tool loop:
 * 1. Send message to LLM with system prompt and tools
 * 2. If LLM returns tool_calls, execute them via toolExecutor (parallel)
 * 3. Feed tool results back to LLM
 * 4. Repeat until LLM returns final response or maxIterations reached
 */
export class AgentRunner implements RunnerProtocol {
  private _eventBus: AgentEventBus | undefined;
  private readonly _model: LanguageModelV1;

  constructor(model: LanguageModelV1, eventBus?: AgentEventBus) {
    this._model = model;
    this._eventBus = eventBus;
  }

  private get eventBus(): AgentEventBus {
    if (!this._eventBus) {
      this._eventBus = getAgentEventBus();
    }
    return this._eventBus;
  }

  private async emit(event: AgentEvent): Promise<unknown[]> {
    return this.eventBus.publish(event);
  }

  /**
   * Emit an intent event and check if it was blocked by a gate.
   * Returns true if allowed, false if blocked.
   */
  private async emitIntent(event: AgentEvent): Promise<boolean> {
    const results = await this.eventBus.publish(event);
    // If no gates, always allowed; if gates exist and returned empty list, blocked
    return results.length > 0 || this.eventBus.gates.length === 0;
  }

  /**
   * Convert agent tools to Vercel AI SDK tool format.
   *
   * Note: We build a tools record that the AI SDK generateText() consumes.
   * We do NOT use the AI SDK tool() helper's built-in execute; instead we
   * handle execution manually so we can emit events and run gate checks.
   */
  private convertTools(
    agent: AgentLike,
    _executor?: ToolExecutor,
  ): Record<string, { description: string; parameters: unknown }> {
    const agentTools = agent.getTools();
    if (agentTools.length === 0) return {};

    const tools: Record<string, { description: string; parameters: unknown }> = {};
    for (const t of agentTools) {
      const vercel = t.toVercelAI();
      tools[t.name] = {
        description: vercel.description,
        parameters: vercel.parameters,
      };
    }
    return tools;
  }

  async run(agent: AgentLike, message: string, options?: RunOptions): Promise<RunResult> {
    // Set event bus if provided
    if (options?.eventBus) {
      this._eventBus = options.eventBus;
    }

    const runId = generateId();
    const effectiveTraceId = options?.traceId ?? runId;
    const maxIterations = options?.maxIterations ?? 10;
    const toolExecutor = options?.toolExecutor;

    // Resolve model name and tools
    const modelName = agent.getModel();
    const agentTools = agent.getTools();
    const tools = this.convertTools(agent, toolExecutor);
    const hasTools = agentTools.length > 0;

    // Emit message start event (root of the trace)
    const startEvent = createEvent("agent.message.start", {
      traceId: effectiveTraceId,
      runId,
      parentSpanId: options?.parentSpanId,
      agentName: agent.role.name,
      agentConfig: {
        role: agent.role.name,
        model: modelName,
        tools: agentTools.map((t) => t.name),
      },
    });
    const rootSpanId = startEvent.spanId;
    await this.emit(startEvent);

    // Build initial messages from history
    const messages: CoreMessage[] = [];
    if (options?.messageHistory) {
      messages.push(...convertHistory(options.messageHistory));
    }
    messages.push({ role: "user" as const, content: message });

    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalToolCalls = 0;

    // Get system prompt
    const system = agent.renderInitialPrompt();

    for (let iteration = 0; iteration < maxIterations; iteration++) {
      // Emit iteration start
      const iterStart = createEvent("agent.iteration.start", {
        traceId: effectiveTraceId,
        runId,
        parentSpanId: rootSpanId,
        iteration,
        maxIterations,
      });
      const iterSpanId = iterStart.spanId;
      await this.emit(iterStart);

      // Emit LLM call start
      const llmStart = createEvent("agent.llm.start", {
        traceId: effectiveTraceId,
        runId,
        parentSpanId: iterSpanId,
        model: modelName,
        messageCount: messages.length + 1, // +1 for system
        hasTools,
      });
      const llmSpanId = llmStart.spanId;
      await this.emit(llmStart);

      const llmStartTime = Date.now();

      let result: Awaited<ReturnType<typeof generateText>>;
      try {
        result = await generateText({
          model: this._model,
          system,
          messages,
          tools: hasTools ? tools : undefined,
          maxSteps: 1, // Force single step for gate interception
        });
      } catch (e: unknown) {
        const llmDuration = Date.now() - llmStartTime;
        await this.emit(
          createEvent("agent.llm.end", {
            traceId: effectiveTraceId,
            runId,
            spanId: llmSpanId,
            parentSpanId: iterSpanId,
            model: modelName,
            inputTokens: 0,
            outputTokens: 0,
            durationMs: llmDuration,
            hasToolCalls: false,
            finishReason: "error",
          }),
        );
        const err = e instanceof Error ? e : new Error(String(e));
        await this.emit(
          createEvent("agent.error", {
            traceId: effectiveTraceId,
            runId,
            parentSpanId: iterSpanId,
            errorType: err.name,
            message: err.message,
            recoverable: false,
            context: {},
          }),
        );
        throw e;
      }

      const llmDuration = Date.now() - llmStartTime;

      // Track token usage
      const iterInputTokens = result.usage?.promptTokens ?? 0;
      const iterOutputTokens = result.usage?.completionTokens ?? 0;
      totalInputTokens += iterInputTokens;
      totalOutputTokens += iterOutputTokens;

      const resultToolCalls = result.toolCalls ?? [];
      const hasToolCalls = resultToolCalls.length > 0;

      // Emit LLM call end
      await this.emit(
        createEvent("agent.llm.end", {
          traceId: effectiveTraceId,
          runId,
          spanId: llmSpanId,
          parentSpanId: iterSpanId,
          model: modelName,
          inputTokens: iterInputTokens,
          outputTokens: iterOutputTokens,
          durationMs: llmDuration,
          hasToolCalls,
          finishReason: hasToolCalls ? "tool_calls" : (result.finishReason ?? "stop"),
        }),
      );

      // No tool calls = done
      if (!hasToolCalls) {
        const content = result.text ?? "";

        // Emit iteration end
        await this.emit(
          createEvent("agent.iteration.end", {
            traceId: effectiveTraceId,
            runId,
            spanId: iterSpanId,
            parentSpanId: rootSpanId,
            iteration,
            toolCallsCount: 0,
            hasMore: false,
          }),
        );

        // Emit message complete
        await this.emit(
          createEvent("agent.message.complete", {
            traceId: effectiveTraceId,
            runId,
            spanId: rootSpanId,
            parentSpanId: rootSpanId,
            content,
            inputTokens: totalInputTokens,
            outputTokens: totalOutputTokens,
            model: modelName,
          }),
        );

        return {
          response: content,
          inputTokens: totalInputTokens,
          outputTokens: totalOutputTokens,
          toolCallsCount: totalToolCalls,
          iterations: iteration + 1,
          finishReason: result.finishReason ?? "stop",
        };
      }

      // Has tool calls — execute them in parallel
      // First, emit intents and gate check
      for (const tc of resultToolCalls) {
        const intent = createEvent("agent.tool.intent", {
          traceId: effectiveTraceId,
          runId,
          parentSpanId: iterSpanId,
          toolCallId: tc.toolCallId,
          toolName: tc.toolName,
          arguments: tc.args as Record<string, unknown>,
        });
        const allowed = await this.emitIntent(intent);
        if (!allowed) {
          throw new ToolCallBlocked(tc.toolName, "Blocked by gate");
        }
      }

      // Parallel tool execution
      const toolResults = await Promise.all(
        resultToolCalls.map(async (tc) => {
          // Emit tool call start
          const tcStart = createEvent("agent.tool.start", {
            traceId: effectiveTraceId,
            runId,
            parentSpanId: iterSpanId,
            toolCallId: tc.toolCallId,
            toolName: tc.toolName,
            arguments: tc.args as Record<string, unknown>,
          });
          const tcSpanId = tcStart.spanId;
          await this.emit(tcStart);

          const startTime = Date.now();
          let toolResult: unknown;
          let errorMsg: string | undefined;

          try {
            if (toolExecutor) {
              toolResult = await toolExecutor.execute(
                tc.toolName,
                tc.args as Record<string, unknown>,
              );
            } else {
              toolResult = { error: "No tool executor configured" };
              errorMsg = "No tool executor configured";
            }
          } catch (e: unknown) {
            const err = e instanceof Error ? e : new Error(String(e));
            toolResult = { error: err.message };
            errorMsg = err.message;
          }

          const durationMs = Date.now() - startTime;
          totalToolCalls++;

          // Emit tool call end
          await this.emit(
            createEvent("agent.tool.end", {
              traceId: effectiveTraceId,
              runId,
              spanId: tcSpanId,
              parentSpanId: iterSpanId,
              toolCallId: tc.toolCallId,
              toolName: tc.toolName,
              arguments: tc.args as Record<string, unknown>,
              result: toolResult,
              error: errorMsg,
              durationMs,
              resultTokens: 0, // Token counting not available without provider-specific API
            }),
          );

          return {
            toolCallId: tc.toolCallId,
            toolName: tc.toolName,
            result: toolResult,
          };
        }),
      );

      // Append assistant message with tool calls to messages
      const assistantContent: Array<ToolCallPart | { type: "text"; text: string }> = [];
      if (result.text) {
        assistantContent.push({ type: "text" as const, text: result.text });
      }
      for (const tc of resultToolCalls) {
        assistantContent.push({
          type: "tool-call" as const,
          toolCallId: tc.toolCallId,
          toolName: tc.toolName,
          args: tc.args,
        });
      }
      messages.push({ role: "assistant" as const, content: assistantContent });

      // Append tool results
      const toolResultParts: ToolResultPart[] = toolResults.map((tr) => ({
        type: "tool-result" as const,
        toolCallId: tr.toolCallId,
        toolName: tr.toolName,
        result: tr.result,
      }));
      messages.push({ role: "tool" as const, content: toolResultParts });

      // Emit iteration end
      await this.emit(
        createEvent("agent.iteration.end", {
          traceId: effectiveTraceId,
          runId,
          spanId: iterSpanId,
          parentSpanId: rootSpanId,
          iteration,
          toolCallsCount: resultToolCalls.length,
          hasMore: true,
        }),
      );
    }

    // Max iterations exceeded — return gracefully per issue spec
    return {
      response: "",
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      toolCallsCount: totalToolCalls,
      iterations: maxIterations,
      finishReason: "max_iterations",
    };
  }
}

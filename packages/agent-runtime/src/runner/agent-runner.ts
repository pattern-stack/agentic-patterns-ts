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
  streamText,
} from "ai";

import { type AgentEventBus, getAgentEventBus } from "../events/agent-event-bus.js";
import { type AgentEvent, createEvent } from "../events/types.js";
import { convertHistory } from "./message-utils.js";
import type { AgentLike, RunOptions, RunResult, RunnerProtocol, ToolExecutor } from "./types.js";

// Re-export AgentLike here so existing consumers importing from "./agent-runner"
// (including the public barrel and workflow modules) continue to work.
export type { AgentLike };

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
   *
   * We cannot infer allowed-vs-blocked from publish()'s return value: an
   * *allowed* intent returns `[]` whenever nothing is subscribed to
   * `agent.tool.intent` (gates are not handlers, so they don't contribute to
   * the handler-results array). That is indistinguishable from a block, so the
   * old `results.length > 0` heuristic wrongly blocked every tool call when a
   * gate was attached but no observability exporter happened to subscribe.
   * Instead, listen for the `agent.tool.rejected` event the gate chain emits
   * on a block. (Mirrors ClaudeCodeRunner.emitIntent.)
   */
  private async emitIntent(event: AgentEvent): Promise<boolean> {
    let blocked = false;
    const onRejected = () => {
      blocked = true;
    };
    this.eventBus.subscribe("agent.tool.rejected", onRejected);
    try {
      await this.eventBus.publish(event);
    } finally {
      this.eventBus.unsubscribe("agent.tool.rejected", onRejected);
    }
    return !blocked;
  }

  /**
   * Convert agent tools to Vercel AI SDK tool format.
   */
  private convertTools(
    agent: AgentLike,
    _executor?: ToolExecutor,
  ): Record<string, { description: string; parameters: unknown }> {
    // AgentLike.getTools() returns unknown[] at the protocol boundary;
    // AgentRunner knows real agents produce ToolSchema[] and narrows here.
    const agentTools = agent.getTools() as ToolSchema[];
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

    // Resolve model name and tools. Use the bound LanguageModelV1's actual
    // modelId for event attribution — agent.getModel() is the agent's
    // *declared* model (often a default) and can lie when the runtime
    // selected a different provider (e.g. agent declares claude-sonnet but
    // createRunner picked ollama qwen3:4b via OLLAMA_HOST).
    const modelName = this._model.modelId;
    const agentTools = agent.getTools() as ToolSchema[];
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

      // If the model produced reasoning (extended-thinking, o-series, etc.),
      // emit a single thinking.start + completed agent.reasoning pair. The
      // non-streaming path can't expose per-delta events, so one summary is
      // the faithful best-effort mapping.
      const reasoningContent = (result as { reasoning?: string | undefined }).reasoning;
      if (reasoningContent && reasoningContent.length > 0) {
        await this.emit(
          createEvent("agent.thinking.start", {
            traceId: effectiveTraceId,
            runId,
            parentSpanId: llmSpanId,
          }),
        );
        await this.emit(
          createEvent("agent.reasoning", {
            traceId: effectiveTraceId,
            runId,
            content: reasoningContent,
            isComplete: true,
          }),
        );
      }

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
              resultTokens: 0,
            }),
          );

          return {
            toolCallId: tc.toolCallId,
            toolName: tc.toolName,
            result: toolResult,
          };
        }),
      );

      // Append messages for next iteration
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

    // Max iterations exceeded
    return {
      response: "",
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      toolCallsCount: totalToolCalls,
      iterations: maxIterations,
      finishReason: "max_iterations",
    };
  }

  // ---------------------------------------------------------------------------
  // stream() — Streaming execution loop using fullStream
  // ---------------------------------------------------------------------------

  async *stream(
    agent: AgentLike,
    message: string,
    options?: RunOptions,
  ): AsyncGenerator<AgentEvent> {
    if (options?.eventBus) {
      this._eventBus = options.eventBus;
    }

    const runId = generateId();
    const effectiveTraceId = options?.traceId ?? runId;
    const maxIterations = options?.maxIterations ?? 10;
    const toolExecutor = options?.toolExecutor;
    const conversationId = generateId();

    const modelName = this._model.modelId;
    const agentTools = agent.getTools();
    const tools = this.convertTools(agent, toolExecutor);
    const hasTools = agentTools.length > 0;

    const system = agent.renderInitialPrompt();
    const messages: CoreMessage[] = [];
    if (options?.messageHistory) {
      messages.push(...convertHistory(options.messageHistory));
    }
    messages.push({ role: "user" as const, content: message });

    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalToolCalls = 0;
    let fullText = "";

    // Conversation start
    const convStart = createEvent("agent.conversation.start", {
      traceId: effectiveTraceId,
      runId,
      conversationId,
      agentName: agent.role.name,
    });
    await this.emit(convStart);
    yield convStart;

    // Message start
    const msgStart = createEvent("agent.message.start", {
      traceId: effectiveTraceId,
      runId,
      parentSpanId: options?.parentSpanId,
      agentName: agent.role.name,
    });
    const rootSpanId = msgStart.spanId;
    await this.emit(msgStart);
    yield msgStart;

    for (let iteration = 0; iteration < maxIterations; iteration++) {
      // Iteration start
      const iterStart = createEvent("agent.iteration.start", {
        traceId: effectiveTraceId,
        runId,
        parentSpanId: rootSpanId,
        iteration,
        maxIterations,
      });
      const iterSpanId = iterStart.spanId;
      await this.emit(iterStart);
      yield iterStart;

      // LLM start
      const llmStart = createEvent("agent.llm.start", {
        traceId: effectiveTraceId,
        runId,
        parentSpanId: iterSpanId,
        model: modelName,
        messageCount: messages.length + 1,
        hasTools,
      });
      const llmSpanId = llmStart.spanId;
      await this.emit(llmStart);
      yield llmStart;

      const llmStartTime = Date.now();

      // Use fullStream to get text + tool calls + errors in one pass
      const streamResult = streamText({
        model: this._model,
        system,
        messages,
        tools: hasTools ? tools : undefined,
        maxSteps: 1,
      });

      let iterText = "";
      let chunkIndex = 0;
      const pendingToolCalls: Array<{
        toolCallId: string;
        toolName: string;
        args: Record<string, unknown>;
        result?: unknown;
      }> = [];
      let stepUsage: { promptTokens: number; completionTokens: number } | undefined;
      let stepFinishReason = "stop";
      let hadError = false;

      // Reasoning-block tracking. Some models (Claude extended thinking,
      // o-series, Gemini 2.5 thinking, DeepSeek Reasoner) emit one or more
      // reasoning deltas before switching back to text/tool-calls. We emit
      // exactly one `agent.thinking.start` per block, stream per-delta
      // `agent.reasoning` events with `isComplete: false`, then one final
      // `agent.reasoning` with `isComplete: true` carrying the full
      // accumulated text when the block ends.
      let reasoningActive = false;
      let reasoningText = "";

      for await (const part of streamResult.fullStream) {
        switch (part.type) {
          case "text-delta": {
            // Transition reasoning -> text: close the reasoning block first.
            if (reasoningActive) {
              const reasoningCompleteEvent = createEvent("agent.reasoning", {
                traceId: effectiveTraceId,
                runId,
                content: reasoningText,
                isComplete: true,
              });
              await this.emit(reasoningCompleteEvent);
              yield reasoningCompleteEvent;
              reasoningActive = false;
              reasoningText = "";
            }
            iterText += part.textDelta;
            const chunkEvent = createEvent("agent.message.chunk", {
              traceId: effectiveTraceId,
              runId,
              delta: part.textDelta,
              chunkIndex: chunkIndex++,
            });
            await this.emit(chunkEvent);
            yield chunkEvent;
            break;
          }
          case "reasoning": {
            if (!reasoningActive) {
              reasoningActive = true;
              reasoningText = "";
              const startEvent = createEvent("agent.thinking.start", {
                traceId: effectiveTraceId,
                runId,
                parentSpanId: llmSpanId,
              });
              await this.emit(startEvent);
              yield startEvent;
            }
            reasoningText += part.textDelta;
            const deltaEvent = createEvent("agent.reasoning", {
              traceId: effectiveTraceId,
              runId,
              content: part.textDelta,
              isComplete: false,
            });
            await this.emit(deltaEvent);
            yield deltaEvent;
            break;
          }
          case "tool-call": {
            // Transition reasoning -> tool-call: close the reasoning block.
            if (reasoningActive) {
              const reasoningCompleteEvent = createEvent("agent.reasoning", {
                traceId: effectiveTraceId,
                runId,
                content: reasoningText,
                isComplete: true,
              });
              await this.emit(reasoningCompleteEvent);
              yield reasoningCompleteEvent;
              reasoningActive = false;
              reasoningText = "";
            }
            pendingToolCalls.push({
              toolCallId: part.toolCallId,
              toolName: part.toolName,
              args: part.args as Record<string, unknown>,
            });
            break;
          }
          case "step-finish": {
            stepUsage = part.usage;
            stepFinishReason = part.finishReason;
            break;
          }
          case "error": {
            hadError = true;
            const llmDuration = Date.now() - llmStartTime;
            const llmEndErr = createEvent("agent.llm.end", {
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
            });
            await this.emit(llmEndErr);
            yield llmEndErr;

            const err = part.error instanceof Error ? part.error : new Error(String(part.error));
            const errEvent = createEvent("agent.error", {
              traceId: effectiveTraceId,
              runId,
              parentSpanId: iterSpanId,
              errorType: err.name,
              message: err.message,
              recoverable: false,
              context: {},
            });
            await this.emit(errEvent);
            yield errEvent;
            break;
          }
          default:
            // step-start, finish, reasoning-signature, redacted-reasoning, etc. — skip
            break;
        }
      }

      // Stream ended while a reasoning block is still open — close it out.
      if (reasoningActive) {
        const reasoningCompleteEvent = createEvent("agent.reasoning", {
          traceId: effectiveTraceId,
          runId,
          content: reasoningText,
          isComplete: true,
        });
        await this.emit(reasoningCompleteEvent);
        yield reasoningCompleteEvent;
        reasoningActive = false;
        reasoningText = "";
      }

      if (hadError) {
        const convEnd = createEvent("agent.conversation.end", {
          traceId: effectiveTraceId,
          runId,
          conversationId,
          reason: "error" as const,
        });
        await this.emit(convEnd);
        yield convEnd;
        return;
      }

      fullText += iterText;

      // Update token tracking
      const iterInputTokens = stepUsage?.promptTokens ?? 0;
      const iterOutputTokens = stepUsage?.completionTokens ?? 0;
      totalInputTokens += iterInputTokens;
      totalOutputTokens += iterOutputTokens;

      const hasToolCalls = pendingToolCalls.length > 0;
      const llmDuration = Date.now() - llmStartTime;

      // LLM end
      const llmEnd = createEvent("agent.llm.end", {
        traceId: effectiveTraceId,
        runId,
        spanId: llmSpanId,
        parentSpanId: iterSpanId,
        model: modelName,
        inputTokens: iterInputTokens,
        outputTokens: iterOutputTokens,
        durationMs: llmDuration,
        hasToolCalls,
        finishReason: hasToolCalls ? "tool_calls" : stepFinishReason,
      });
      await this.emit(llmEnd);
      yield llmEnd;

      // No tool calls = done
      if (!hasToolCalls) {
        const iterEnd = createEvent("agent.iteration.end", {
          traceId: effectiveTraceId,
          runId,
          spanId: iterSpanId,
          parentSpanId: rootSpanId,
          iteration,
          toolCallsCount: 0,
          hasMore: false,
        });
        await this.emit(iterEnd);
        yield iterEnd;

        const msgComplete = createEvent("agent.message.complete", {
          traceId: effectiveTraceId,
          runId,
          spanId: rootSpanId,
          parentSpanId: rootSpanId,
          content: fullText,
          inputTokens: totalInputTokens,
          outputTokens: totalOutputTokens,
          model: modelName,
        });
        await this.emit(msgComplete);
        yield msgComplete;

        const convEnd = createEvent("agent.conversation.end", {
          traceId: effectiveTraceId,
          runId,
          conversationId,
          reason: "completed" as const,
        });
        await this.emit(convEnd);
        yield convEnd;
        return;
      }

      // Process tool calls
      for (const tc of pendingToolCalls) {
        const intent = createEvent("agent.tool.intent", {
          traceId: effectiveTraceId,
          runId,
          parentSpanId: iterSpanId,
          toolCallId: tc.toolCallId,
          toolName: tc.toolName,
          arguments: tc.args,
        });
        await this.emit(intent);
        yield intent;

        const allowed = await this.emitIntent(intent);
        if (!allowed) {
          const errEvent = createEvent("agent.error", {
            traceId: effectiveTraceId,
            runId,
            parentSpanId: iterSpanId,
            errorType: "ToolCallBlocked",
            message: `Tool call '${tc.toolName}' blocked by gate`,
            recoverable: false,
            context: {},
          });
          await this.emit(errEvent);
          yield errEvent;

          const convEnd = createEvent("agent.conversation.end", {
            traceId: effectiveTraceId,
            runId,
            conversationId,
            reason: "error" as const,
          });
          await this.emit(convEnd);
          yield convEnd;
          return;
        }

        const tcStart = createEvent("agent.tool.start", {
          traceId: effectiveTraceId,
          runId,
          parentSpanId: iterSpanId,
          toolCallId: tc.toolCallId,
          toolName: tc.toolName,
          arguments: tc.args,
        });
        const tcSpanId = tcStart.spanId;
        await this.emit(tcStart);
        yield tcStart;

        const startTime = Date.now();
        let toolResult: unknown;
        let errorMsg: string | undefined;

        try {
          if (toolExecutor) {
            toolResult = await toolExecutor.execute(tc.toolName, tc.args);
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
        tc.result = toolResult;

        const tcEnd = createEvent("agent.tool.end", {
          traceId: effectiveTraceId,
          runId,
          spanId: tcSpanId,
          parentSpanId: iterSpanId,
          toolCallId: tc.toolCallId,
          toolName: tc.toolName,
          arguments: tc.args,
          result: toolResult,
          error: errorMsg,
          durationMs,
          resultTokens: 0,
        });
        await this.emit(tcEnd);
        yield tcEnd;
      }

      // Build messages for next iteration
      const assistantContent: Array<ToolCallPart | { type: "text"; text: string }> = [];
      if (iterText) {
        assistantContent.push({ type: "text" as const, text: iterText });
      }
      for (const tc of pendingToolCalls) {
        assistantContent.push({
          type: "tool-call" as const,
          toolCallId: tc.toolCallId,
          toolName: tc.toolName,
          args: tc.args,
        });
      }
      messages.push({ role: "assistant" as const, content: assistantContent });

      const toolResultParts: ToolResultPart[] = pendingToolCalls.map((tc) => ({
        type: "tool-result" as const,
        toolCallId: tc.toolCallId,
        toolName: tc.toolName,
        result: tc.result,
      }));
      messages.push({ role: "tool" as const, content: toolResultParts });

      // Iteration end
      const iterEnd = createEvent("agent.iteration.end", {
        traceId: effectiveTraceId,
        runId,
        spanId: iterSpanId,
        parentSpanId: rootSpanId,
        iteration,
        toolCallsCount: pendingToolCalls.length,
        hasMore: true,
      });
      await this.emit(iterEnd);
      yield iterEnd;
    }

    // Max iterations reached
    const convEnd = createEvent("agent.conversation.end", {
      traceId: effectiveTraceId,
      runId,
      conversationId,
      reason: "completed" as const,
    });
    await this.emit(convEnd);
    yield convEnd;
  }
}

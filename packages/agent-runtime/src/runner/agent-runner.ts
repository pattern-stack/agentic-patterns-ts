/**
 * AgentRunner — The standard agentic execution loop on Vercel AI SDK.
 *
 * Ported from Python: systems/runners/agent.py
 *
 * Key differences from Python:
 * - Parallel tool execution via Promise.all (Python is sequential)
 * - Vercel AI SDK handles tool schema conversion (Python manually builds OpenAI JSON)
 * - One generateText/streamText call per iteration (v5 single-step default) for
 *   gate interception control (see GATE-CHAIN INVARIANT below)
 * - MockLanguageModelV2 for testing (replaces Python's MockRunner)
 *
 * GATE-CHAIN INVARIANT (do not break): the SDK must NOT auto-run or loop tools.
 * We deliberately (a) pass tools WITHOUT an `execute` function and (b) rely on
 * v5's single-step default (we removed v4's `maxSteps: 1`). Tool dispatch goes
 * through the gate chain + `toolExecutor` here, NOT the SDK. If you ever give a
 * tool an `execute`, or add `stopWhen` / `maxSteps`/`stepCountIs(>1)`, the SDK
 * will run and loop tools itself and the gate interception (and the T0-1
 * gate-allow regression test in agent-runner.test.ts) will be bypassed.
 */

import type { ToolExecutionContext, ToolSchema } from "@agentic-patterns/core";
import type { LanguageModelV2 } from "@ai-sdk/provider";
import {
  type ModelMessage,
  Output,
  type ToolSet,
  generateId,
  generateText,
  stepCountIs,
  streamText,
  tool,
} from "ai";
import type { ZodType } from "zod";

import { type AgentEventBus, getAgentEventBus } from "../events/agent-event-bus.js";
import { type AgentEvent, type BaseEvent, createEvent } from "../events/types.js";
import {
  type ModelResolver,
  constantModelResolver,
  isModelResolver,
} from "../providers/model-resolver.js";
import { convertHistory, sanitizeResponseMessages, toJsonValue } from "./message-utils.js";
import { guardOpenObjectSchemas } from "./schema-guard.js";
import type {
  AgentLike,
  RunOptions,
  RunResult,
  RunnerProtocol,
  StructuredRunResult,
  ToolExecutor,
} from "./types.js";

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
// Structured-output capability table (DESIGN §9.4 / §9.5)
// ---------------------------------------------------------------------------

/**
 * Does this model support a SINGLE-CALL tools + structured-output round-trip
 * (`experimental_output` while a tool loop runs)?
 *
 * Conservative, additive, empirically seeded (DESIGN §9.5). CAPABLE iff the
 * resolved model id matches one of the verified-good families below; EVERY
 * other id — including unknown ids and untested providers (anthropic, gemini
 * ≤3.1 / 2.5) — returns `false`, routing to the model-safe 2-tier path.
 *
 * Correctness never depends on this flag (the 2-tier fallback is always
 * correct); it only decides whether a round-trip can be saved.
 */
export function modelSupportsToolsWithStructuredOutput(modelId: string): boolean {
  const id = modelId.toLowerCase();
  // Strip any gateway/provider prefix (e.g. "bifrost:openai/gpt-4o" → "gpt-4o",
  // "openai/gpt-5" → "gpt-5") so the family match works on the bare model name.
  // Split on "/" only (NOT ":") so a version tag like "gpt-4o:2024-08-06"
  // keeps its family prefix instead of collapsing to the version.
  const bare = id.split("/").pop() ?? id;
  return (
    // openai/gpt-4o*  (gpt-4o, gpt-4o-mini, gpt-4o-2024-…)
    bare.startsWith("gpt-4o") ||
    // openai/gpt-5*
    bare.startsWith("gpt-5") ||
    // gemini 3.5 flash (NOT gemini 3.1 / 2.5)
    bare.includes("gemini-3.5-flash")
  );
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
  private readonly _resolver: ModelResolver;

  /**
   * @param model A {@link ModelResolver} — the runner resolves `agent.getModel()`
   *   per run, so the model belongs to the agent (overridable per-agent). OR a
   *   concrete `LanguageModelV2`, which is wrapped in a
   *   {@link constantModelResolver} so the model is pinned regardless of what the
   *   agent declares (back-compat; the path tests use with `MockLanguageModelV2`).
   */
  constructor(model: LanguageModelV2 | ModelResolver, eventBus?: AgentEventBus) {
    this._resolver = isModelResolver(model) ? model : constantModelResolver(model);
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
    // Correlate the rejection to THIS intent's toolCallId. The AI SDK runs
    // multiple tool calls within a step concurrently (the capable runStructured
    // path hands execute-bearing tools to the SDK), so a payload-blind handler
    // would let one tool's rejection spuriously block a concurrent sibling.
    const intentId = (event as { toolCallId?: string }).toolCallId;
    let blocked = false;
    const onRejected = (rejected: BaseEvent) => {
      // The gate chain emits the rejection carrying `originalIntent` (the intent
      // it blocked), NOT a top-level toolCallId — correlate on that so a
      // concurrent sibling's rejection can't flip this intent's `blocked`.
      const oi = (rejected as { originalIntent?: { toolCallId?: string } }).originalIntent;
      if (oi?.toolCallId === intentId) {
        blocked = true;
      }
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
   * Build the bus-bound {@link ToolExecutionContext} handed to `toolExecutor.execute`
   * at each dispatch site (#102). Single adapter so the three call sites don't drift.
   *
   * `parentSpanId` reuses the invoking tool call's own span id (`tcSpanId`, the
   * `spanId` stamped on that call's `agent.tool.start`) as the nesting anchor —
   * NOT a separate field. A tool call's span IS the parent span for anything it
   * spawns (a nested sub-agent's events, or this ctx's own `emit` progress
   * pings); do not "fix" this into a distinct `parentToolCallId`-derived span.
   *
   * INVARIANT (deliberate, load-bearing): `agent.tool.start` is stamped with
   * `spanId: toolCallId` at every dispatch site — NOT a freshly-generated id.
   * `node-tool.ts` anchors a nested sub-agent's root span at `parentSpanId ===
   * parentToolCallId` (this ctx's `parentToolCallId`, above), and real span
   * consumers (`exporters/otel.ts`, `exporters/langfuse.ts`) resolve parentage
   * strictly by matching `parentSpanId` against a KNOWN `event.spanId`. Unless
   * `tcSpanId === toolCallId` holds, the child resolves to no such span and
   * becomes an orphan root in every exporter. Do not "fix" this back to a
   * generated spanId — `toolCallId` IS the tool call's span id by design.
   */
  private buildToolCtx(a: {
    traceId: string;
    runId: string;
    parentToolCallId: string;
    parentSpanId: string;
    host?: unknown;
  }): ToolExecutionContext {
    return {
      runId: a.runId,
      traceId: a.traceId,
      parentToolCallId: a.parentToolCallId,
      host: a.host, // #124 — the single copy site
      // Channel B (secondary): a non-agent tool's only progress-reporting path.
      // Fire-and-forget — never let a tool author await bus/gate plumbing, and
      // never let a publish failure (sync OR async) surface into the tool's
      // own execution; the whole body is guarded, not just the promise, since
      // `createEvent`/`publish` could throw synchronously before returning a
      // promise to `.catch()`. NOTE: because it's fire-and-forget, a progress
      // event may settle AFTER the tool's own `agent.tool.end` — there is no
      // ordering guarantee between Channel B and the tool's own lifecycle.
      emit: (e) => {
        try {
          void this.eventBus
            .publish(
              createEvent("agent.tool.progress", {
                traceId: a.traceId,
                runId: a.runId,
                parentSpanId: a.parentSpanId,
                toolCallId: a.parentToolCallId,
                statusText: typeof e.data?.statusText === "string" ? e.data.statusText : e.type,
                progress: typeof e.data?.progress === "number" ? e.data.progress : undefined,
              }),
            )
            .catch(() => {
              // Swallow — emit is a best-effort sink (#99's non-throw contract).
            });
        } catch {
          // Swallow a SYNCHRONOUS throw too (e.g. from createEvent) — same
          // non-throw contract as the async catch above.
        }
      },
    };
  }

  /**
   * Convert agent tools to the Vercel AI SDK v5 tool format.
   *
   * v5 renamed the tool's schema field `parameters → inputSchema`. Core's
   * `ToolSchema.toVercelAI()` still returns `{ description, parameters }`, so we
   * do the rename here at the runner boundary (core stays `ai`-free).
   *
   * NOTE (gate-chain invariant): tools are intentionally `execute`-less — the
   * SDK never runs them; dispatch goes through the gate chain + `toolExecutor`.
   */
  private convertTools(agent: AgentLike, _executor?: ToolExecutor): ToolSet {
    // AgentLike.getTools() returns unknown[] at the protocol boundary;
    // AgentRunner knows real agents produce ToolSchema[] and narrows here.
    const agentTools = agent.getTools() as ToolSchema[];
    if (agentTools.length === 0) return {};

    const tools: ToolSet = {};
    for (const t of agentTools) {
      const vercel = t.toVercelAI();
      // Build via `tool()` WITHOUT an `execute` (gate-chain invariant): the SDK
      // exposes the schema to the model but never runs the tool. core's
      // `toVercelAI().parameters` is a Zod schema → a valid v5 `inputSchema`.
      tools[t.name] = tool({
        description: vercel.description,
        inputSchema: vercel.parameters,
      });
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

    // Resolve the agent's declared model to a live model for this run. With a
    // resolver-backed runner this honours agent.getModel() (the model belongs to
    // the agent); with the back-compat constant resolver it returns the pinned
    // model and ignores the id. Event attribution uses the *resolved* model's
    // modelId — the id actually dispatched.
    const model = await this._resolver.resolve(agent.getModel());
    const modelName = model.modelId;
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
    const messages: ModelMessage[] = [];
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
        // GATE-CHAIN INVARIANT: no `maxSteps`/`stopWhen` — v5 single-step is the
        // default. Tools are `execute`-less so the SDK can't run/loop them; we
        // dispatch through the gate chain + toolExecutor below.
        result = await generateText({
          model,
          system,
          messages,
          tools: hasTools ? tools : undefined,
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

      // Track token usage. v5 renamed usage fields (promptTokens→inputTokens,
      // completionTokens→outputTokens) and each is `number | undefined`. Each
      // iteration is a single step, so `result.usage` (last-step usage) is this
      // iteration's usage; the run-level total the events report is the
      // accumulation below (equivalent to summing result.totalUsage per step).
      const iterInputTokens = result.usage?.inputTokens ?? 0;
      const iterOutputTokens = result.usage?.outputTokens ?? 0;
      totalInputTokens += iterInputTokens;
      totalOutputTokens += iterOutputTokens;

      const resultToolCalls = result.toolCalls ?? [];
      const hasToolCalls = resultToolCalls.length > 0;

      // If the model produced reasoning (extended-thinking, o-series, etc.),
      // emit a single thinking.start + completed agent.reasoning pair. The
      // non-streaming path can't expose per-delta events, so one summary is
      // the faithful best-effort mapping. v5 exposes the joined reasoning as
      // `result.reasoningText` (was `result.reasoning`).
      const reasoningContent = result.reasoningText;
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

      // Has tool calls — execute them in parallel. v5's TypedToolCall carries
      // the call payload under `.input` (was `.args` in v4).
      for (const tc of resultToolCalls) {
        const intent = createEvent("agent.tool.intent", {
          traceId: effectiveTraceId,
          runId,
          parentSpanId: iterSpanId,
          toolCallId: tc.toolCallId,
          toolName: tc.toolName,
          arguments: tc.input as Record<string, unknown>,
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
            // #102 fix (Gate 2.5 blocker): stamp the tool call's OWN spanId
            // with its toolCallId (not a fresh generateId()). node-tool.ts
            // anchors a nested sub-agent's root at `parentSpanId ===
            // parentToolCallId`; span exporters (otel.ts, langfuse.ts) key
            // strictly by `event.spanId`, so unless `tcSpanId === toolCallId`
            // the child resolves to no known span and becomes an orphan root.
            spanId: tc.toolCallId,
            traceId: effectiveTraceId,
            runId,
            parentSpanId: iterSpanId,
            toolCallId: tc.toolCallId,
            toolName: tc.toolName,
            arguments: tc.input as Record<string, unknown>,
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
                tc.input as Record<string, unknown>,
                this.buildToolCtx({
                  traceId: effectiveTraceId,
                  runId,
                  parentToolCallId: tc.toolCallId,
                  parentSpanId: tcSpanId,
                  host: options?.host,
                }),
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
              arguments: tc.input as Record<string, unknown>,
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

      // Append messages for next iteration.
      //
      // ★ THOUGHT-SIGNATURE / REASONING ROUND-TRIP: append the SDK's own
      // assistant message(s) VERBATIM via `result.response.messages` instead of
      // hand-rebuilding `{ role: "assistant", content: [...] }`. Those messages
      // carry `providerOptions`/`providerMetadata` (Gemini's `thoughtSignature`,
      // Anthropic thinking blocks). Dropping them — as the old hand-rebuild did —
      // breaks Gemini 3.x multi-turn tool loops with "function call is missing a
      // thought_signature". This is the whole point of the v5 migration.
      messages.push(...sanitizeResponseMessages(result.response.messages));

      // Our own tool results (we ran the tools, not the SDK). v5's
      // ToolResultPart carries the result under `output` as a typed union.
      messages.push({
        role: "tool" as const,
        content: toolResults.map((tr) => ({
          type: "tool-result" as const,
          toolCallId: tr.toolCallId,
          toolName: tr.toolName,
          output: { type: "json" as const, value: toJsonValue(tr.result) },
        })),
      });

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
  // runStructured() — capability-gated structured output (DESIGN §9.4)
  // ---------------------------------------------------------------------------

  /**
   * Build the agent's tools WITH an `execute` function for the single-call
   * capable path. Unlike {@link convertTools} (execute-less, gate-chain
   * invariant), here the SDK DOES drive the tool loop — so each `execute`
   * still routes through the gate chain + `toolExecutor` + event emission,
   * preserving gate interception even though the SDK runs the loop.
   */
  private convertExecutableTools(
    agent: AgentLike,
    toolExecutor: ToolExecutor | undefined,
    ctx: { traceId: string; runId: string; parentSpanId: string; host?: unknown },
  ): ToolSet {
    const agentTools = agent.getTools() as ToolSchema[];
    if (agentTools.length === 0) return {};

    const tools: ToolSet = {};
    for (const t of agentTools) {
      const vercel = t.toVercelAI();
      const toolName = t.name;
      tools[toolName] = tool({
        description: vercel.description,
        inputSchema: vercel.parameters,
        execute: async (input: unknown) => {
          const args = (input ?? {}) as Record<string, unknown>;
          const intent = createEvent("agent.tool.intent", {
            traceId: ctx.traceId,
            runId: ctx.runId,
            parentSpanId: ctx.parentSpanId,
            toolCallId: generateId(),
            toolName,
            arguments: args,
          });
          const allowed = await this.emitIntent(intent);
          if (!allowed) {
            throw new ToolCallBlocked(toolName, "Blocked by gate");
          }

          const tcStart = createEvent("agent.tool.start", {
            // #102 fix: see the sibling dispatch site's comment — stamp
            // spanId with the toolCallId so span exporters can resolve a
            // nested sub-agent's `parentSpanId === parentToolCallId` anchor.
            spanId: intent.toolCallId,
            traceId: ctx.traceId,
            runId: ctx.runId,
            parentSpanId: ctx.parentSpanId,
            toolCallId: intent.toolCallId,
            toolName,
            arguments: args,
          });
          const tcSpanId = tcStart.spanId;
          await this.emit(tcStart);

          const startTime = Date.now();
          let toolResult: unknown;
          let errorMsg: string | undefined;
          try {
            if (toolExecutor) {
              toolResult = await toolExecutor.execute(
                toolName,
                args,
                this.buildToolCtx({
                  traceId: ctx.traceId,
                  runId: ctx.runId,
                  parentToolCallId: intent.toolCallId,
                  parentSpanId: tcSpanId,
                  host: ctx.host,
                }),
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

          await this.emit(
            createEvent("agent.tool.end", {
              traceId: ctx.traceId,
              runId: ctx.runId,
              spanId: tcSpanId,
              parentSpanId: ctx.parentSpanId,
              toolCallId: intent.toolCallId,
              toolName,
              arguments: args,
              result: toolResult,
              error: errorMsg,
              durationMs: Date.now() - startTime,
              resultTokens: 0,
            }),
          );

          return toJsonValue(toolResult);
        },
      });
    }
    return tools;
  }

  async runStructured<T>(
    agent: AgentLike,
    message: string,
    schema: ZodType<T>,
    options?: RunOptions,
  ): Promise<StructuredRunResult<T>> {
    // Fail LOUD before any LLM call: open-object schemas (z.record /
    // .passthrough() / .catchall() / z.map) silently decode to {} on
    // schema-subset providers (Gemini responseSchema, OpenAI strict).
    // See schema-guard.ts; RunOptions.allowOpenObjectSchemas downgrades
    // the error to a once-per-schema warning.
    guardOpenObjectSchemas(schema, options?.allowOpenObjectSchemas);

    if (options?.eventBus) {
      this._eventBus = options.eventBus;
    }

    const runId = generateId();
    const effectiveTraceId = options?.traceId ?? runId;
    const toolExecutor = options?.toolExecutor;

    const model = await this._resolver.resolve(agent.getModel());
    const modelName = model.modelId;
    const agentTools = agent.getTools() as ToolSchema[];
    const hasTools = agentTools.length > 0;
    const system = agent.renderInitialPrompt();

    // Emit message start event (root of the trace), mirroring run().
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

    const messages: ModelMessage[] = [];
    if (options?.messageHistory) {
      messages.push(...convertHistory(options.messageHistory));
    }
    messages.push({ role: "user" as const, content: message });

    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let toolCallsCount = 0;
    let iterations = 1;
    let finishReason = "stop";
    let rawObject: unknown;

    if (!hasTools) {
      // No tools → single Output.object call. Works on every model.
      const result = await generateText({
        model,
        system,
        messages,
        experimental_output: Output.object({ schema }),
      });
      totalInputTokens = result.usage?.inputTokens ?? 0;
      totalOutputTokens = result.usage?.outputTokens ?? 0;
      finishReason = result.finishReason ?? "stop";
      rawObject = result.experimental_output;
    } else if (modelSupportsToolsWithStructuredOutput(modelName)) {
      // Tools + capable model → single experimental_output + tools call. The
      // SDK drives the loop; execute-bearing tools keep gate interception.
      const tools = this.convertExecutableTools(agent, toolExecutor, {
        traceId: effectiveTraceId,
        runId,
        parentSpanId: rootSpanId,
        host: options?.host,
      });
      const result = await generateText({
        model,
        system,
        messages,
        tools,
        stopWhen: stepCountIs(options?.maxIterations ?? 10),
        experimental_output: Output.object({ schema }),
      });
      const steps = result.steps ?? [];
      // Prefer totalUsage (the whole multi-step loop). If a provider omits it,
      // result.usage is LAST-step only — sum per-step usage to avoid undercounting.
      const usage =
        result.totalUsage ??
        steps.reduce(
          (a, s) => ({
            inputTokens: (a.inputTokens ?? 0) + (s.usage?.inputTokens ?? 0),
            outputTokens: (a.outputTokens ?? 0) + (s.usage?.outputTokens ?? 0),
          }),
          { inputTokens: 0, outputTokens: 0 },
        );
      totalInputTokens = usage?.inputTokens ?? 0;
      totalOutputTokens = usage?.outputTokens ?? 0;
      finishReason = result.finishReason ?? "stop";
      toolCallsCount = steps.reduce((n, s) => n + (s.toolCalls?.length ?? 0), 0);
      iterations = Math.max(1, steps.length);
      rawObject = result.experimental_output;
    } else {
      // Tools + incapable/UNKNOWN model → 2-tier (model-safe). Tier 1: the
      // normal gate-respecting tool loop to text. Tier 2: a no-tools
      // Output.object finish over that text.
      // Thread the runStructured root's trace + span so tier-1's events nest
      // under it instead of forming a fresh, disjoint trace.
      const tier1 = await this.run(agent, message, {
        ...options,
        traceId: effectiveTraceId,
        parentSpanId: rootSpanId,
      });
      totalInputTokens += tier1.inputTokens;
      totalOutputTokens += tier1.outputTokens;
      toolCallsCount = tier1.toolCallsCount;
      iterations = tier1.iterations;

      // Guard: if tier 1 produced no text (e.g. its tool loop hit maxIterations),
      // the structured finish would get an empty body and throw an opaque schema
      // error. Surface the real cause instead.
      if (!tier1.response || tier1.response.trim() === "") {
        throw new Error(
          `runStructured: 2-tier fallback got empty tier-1 output (finishReason="${tier1.finishReason}") — the tool loop likely hit maxIterations before producing an answer. Raise maxIterations or simplify the step.`,
        );
      }

      const tier2 = await generateText({
        model,
        system,
        messages: [
          {
            role: "user" as const,
            content: `From the following, produce the structured object.\n\n${tier1.response}`,
          },
        ],
        experimental_output: Output.object({ schema }),
      });
      totalInputTokens += tier2.usage?.inputTokens ?? 0;
      totalOutputTokens += tier2.usage?.outputTokens ?? 0;
      iterations += 1;
      finishReason = tier2.finishReason ?? "stop";
      rawObject = tier2.experimental_output;
    }

    // Validate against the caller's schema — never trust the model's shape.
    const parsed = schema.safeParse(rawObject);
    if (!parsed.success) {
      const err = new Error(
        `runStructured: model output failed schema validation — ${parsed.error.message}`,
      );
      await this.emit(
        createEvent("agent.error", {
          traceId: effectiveTraceId,
          runId,
          parentSpanId: rootSpanId,
          errorType: err.name,
          message: err.message,
          recoverable: false,
          context: {},
        }),
      );
      throw err;
    }

    await this.emit(
      createEvent("agent.message.complete", {
        traceId: effectiveTraceId,
        runId,
        spanId: rootSpanId,
        parentSpanId: rootSpanId,
        content: JSON.stringify(parsed.data),
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        model: modelName,
      }),
    );

    return {
      response: JSON.stringify(parsed.data),
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      toolCallsCount,
      iterations,
      finishReason,
      object: parsed.data,
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

    const model = await this._resolver.resolve(agent.getModel());
    const modelName = model.modelId;
    const agentTools = agent.getTools();
    const tools = this.convertTools(agent, toolExecutor);
    const hasTools = agentTools.length > 0;

    const system = agent.renderInitialPrompt();
    const messages: ModelMessage[] = [];
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

      // Use fullStream to get text + tool calls + errors in one pass.
      // GATE-CHAIN INVARIANT: no `maxSteps`/`stopWhen` (v5 single-step default),
      // tools `execute`-less — the SDK won't run/loop tools; we dispatch below.
      const streamResult = streamText({
        model,
        system,
        messages,
        tools: hasTools ? tools : undefined,
      });

      let iterText = "";
      let chunkIndex = 0;
      const pendingToolCalls: Array<{
        toolCallId: string;
        toolName: string;
        args: Record<string, unknown>;
        result?: unknown;
      }> = [];
      let stepUsage: { inputTokens?: number; outputTokens?: number } | undefined;
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
            iterText += part.text;
            const chunkEvent = createEvent("agent.message.chunk", {
              traceId: effectiveTraceId,
              runId,
              delta: part.text,
              chunkIndex: chunkIndex++,
            });
            await this.emit(chunkEvent);
            yield chunkEvent;
            break;
          }
          case "reasoning-delta": {
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
            reasoningText += part.text;
            const deltaEvent = createEvent("agent.reasoning", {
              traceId: effectiveTraceId,
              runId,
              content: part.text,
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
              args: part.input as Record<string, unknown>,
            });
            break;
          }
          case "finish-step": {
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
            // start, start-step, text-start/end, reasoning-start/end,
            // tool-input-start/delta/end, finish, source, file, raw, etc. — skip
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

      // Update token tracking (v5 usage field names; each is number|undefined).
      const iterInputTokens = stepUsage?.inputTokens ?? 0;
      const iterOutputTokens = stepUsage?.outputTokens ?? 0;
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
          // #102 fix: see the first dispatch site's comment — stamp spanId
          // with the toolCallId so span exporters can resolve a nested
          // sub-agent's `parentSpanId === parentToolCallId` anchor.
          spanId: tc.toolCallId,
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
            toolResult = await toolExecutor.execute(
              tc.toolName,
              tc.args,
              this.buildToolCtx({
                traceId: effectiveTraceId,
                runId,
                parentToolCallId: tc.toolCallId,
                parentSpanId: tcSpanId,
                host: options?.host,
              }),
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

      // Build messages for next iteration.
      //
      // ★ THOUGHT-SIGNATURE / REASONING ROUND-TRIP: append the SDK's own
      // assistant message(s) VERBATIM. `streamResult.response` resolves (after
      // the fullStream drained above) to the response incl. `messages` that
      // carry `providerOptions`/`providerMetadata` — Gemini's `thoughtSignature`
      // and Anthropic thinking blocks. Hand-rebuilding the assistant turn drops
      // them and breaks Gemini 3.x multi-turn tool loops.
      const streamResponse = await streamResult.response;
      messages.push(...sanitizeResponseMessages(streamResponse.messages));

      // Our own tool results (we ran the tools, not the SDK). v5's
      // ToolResultPart carries the result under `output` as a typed union.
      messages.push({
        role: "tool" as const,
        content: pendingToolCalls.map((tc) => ({
          type: "tool-result" as const,
          toolCallId: tc.toolCallId,
          toolName: tc.toolName,
          output: { type: "json" as const, value: toJsonValue(tc.result) },
        })),
      });

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

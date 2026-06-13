/**
 * Claude Code LanguageModelV2 provider.
 *
 * Wraps the Claude Agent SDK's `query()` function in a Vercel AI SDK
 * `LanguageModelV2` so agents can be executed through `AgentRunner` using
 * a Claude Max subscription (OAuth cached in ~/.claude) or an
 * `ANTHROPIC_API_KEY` env var picked up by the SDK itself.
 *
 * Unlike `ClaudeCodeRunner` / `ClaudeCodeAPIRunner`, this provider plugs
 * into the *standard* AgentRunner execution loop. That means the full
 * canonical event vocabulary (`iteration.start`, `llm.start`, `tool.*`,
 * `iteration.end`, `llm.end`, …) fires automatically — closing the
 * observability gap those runners have.
 *
 * Each `doGenerate` / `doStream` call runs a fresh single-turn SDK query:
 *
 *   1. System prompt + conversation history (including prior tool
 *      use / tool result parts) is flattened to a string prompt.
 *   2. Tool schemas are registered as MCP tools on an in-process server.
 *   3. `canUseTool` intercepts tool invocations, records them, and denies
 *      with `interrupt: true` so the SDK stops immediately. The recorded
 *      tool calls are surfaced in the LanguageModelV2 response as
 *      `tool-call` content parts.
 *   4. SDK assistant / result messages are translated back to the
 *      LanguageModelV2 output shape (`content` parts, `finishReason`,
 *      `usage`).
 *   5. Claude-Code-native tools (Read/Write/Edit/Bash/…) are disallowed so
 *      only framework tools flow.
 */

import type {
  LanguageModelV2,
  LanguageModelV2CallOptions,
  LanguageModelV2Content,
  LanguageModelV2FinishReason,
  LanguageModelV2FunctionTool,
  LanguageModelV2Prompt,
  LanguageModelV2StreamPart,
  LanguageModelV2ToolCall,
} from "@ai-sdk/provider";
import {
  type McpSdkServerConfigWithInstance,
  type PermissionResult,
  type Options as SDKOptions,
  createSdkMcpServer,
  query,
  tool as sdkTool,
} from "@anthropic-ai/claude-agent-sdk";
import type { z } from "zod";

// ---------------------------------------------------------------------------
// Model name mapping
// ---------------------------------------------------------------------------

const MODEL_MAP: Record<string, string> = {
  opus: "opus",
  sonnet: "sonnet",
  haiku: "haiku",
};

function mapModel(modelName: string): string | undefined {
  const lower = modelName.toLowerCase();
  for (const [key, value] of Object.entries(MODEL_MAP)) {
    if (lower.includes(key)) return value;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Tools blocked in "API mode" — only framework tools flow
// ---------------------------------------------------------------------------

const BLOCKED_BUILTIN_TOOLS: readonly string[] = [
  "Read",
  "Write",
  "Edit",
  "Bash",
  "Glob",
  "Grep",
  "Agent",
  "NotebookEdit",
  "TodoRead",
  "TodoWrite",
  "WebFetch",
  "WebSearch",
];

// ---------------------------------------------------------------------------
// Provider options
// ---------------------------------------------------------------------------

export interface ClaudeCodeProviderOptions {
  /** Defaults merged with every SDK query call. */
  defaults?: Partial<SDKOptions>;
  /** Include Claude Code's built-in tools (Read/Write/Bash/…). Default: false. */
  allowBuiltinTools?: boolean;
  /**
   * Max turns inside the SDK loop. Default: 10.
   *
   * Within one `doGenerate`, Claude may emit prose-only on its first turn
   * and produce a tool call on a later turn. `canUseTool` aborts on the
   * first tool call regardless, so this only needs to be generous enough
   * to allow "plan-then-tool" sequences. A too-low value causes the SDK
   * to throw `Reached maximum number of turns` before Claude reaches any
   * tool call.
   */
  maxTurns?: number;
}

// ---------------------------------------------------------------------------
// Prompt flattening
// ---------------------------------------------------------------------------

/**
 * Extract the single system prompt from a LanguageModelV2 message array.
 *
 * LanguageModelV2Prompt only ever contains one leading system message (if
 * any) — the AI SDK normalizes `generateText({ system, messages })` into
 * a prompt that starts with `{ role: 'system' }`.
 */
function extractSystemPrompt(prompt: LanguageModelV2Prompt): string | undefined {
  const first = prompt[0];
  if (first && first.role === "system") return first.content;
  return undefined;
}

/** Stringify any JSON-ish value for embedding in a text prompt. */
function stringifyValue(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/**
 * Render non-system conversation messages into a single user-facing prompt
 * string. Tool call / tool result parts are rendered inline as tagged
 * blocks so Claude understands the history without requiring SDK session
 * resume support.
 */
function renderConversation(prompt: LanguageModelV2Prompt): string {
  const parts: string[] = [];

  for (const msg of prompt) {
    if (msg.role === "user") {
      const text = renderUserContent(msg);
      if (text) parts.push(text);
    } else if (msg.role === "assistant") {
      const text = renderAssistantContent(msg);
      if (text) parts.push(`Assistant: ${text}`);
    } else if (msg.role === "tool") {
      const text = renderToolContent(msg);
      if (text) parts.push(text);
    }
    // system is handled separately via extractSystemPrompt
  }

  return parts.join("\n\n");
}

type PromptMessage = LanguageModelV2Prompt[number];

function renderUserContent(msg: Extract<PromptMessage, { role: "user" }>): string {
  const chunks: string[] = [];
  for (const part of msg.content) {
    if (part.type === "text") chunks.push(part.text);
    // Image / file parts are dropped — Claude Agent SDK prompt string
    // cannot carry them losslessly without session APIs.
  }
  return chunks.join("\n");
}

function renderAssistantContent(msg: Extract<PromptMessage, { role: "assistant" }>): string {
  const chunks: string[] = [];
  for (const part of msg.content) {
    if (part.type === "text") {
      chunks.push(part.text);
    } else if (part.type === "tool-call") {
      // v5 ToolCallPart carries the payload under `input` (was `args`).
      chunks.push(
        `[tool-call name=${part.toolName} id=${part.toolCallId}] ${stringifyValue(part.input)}`,
      );
    }
  }
  return chunks.join("\n");
}

function renderToolContent(msg: Extract<PromptMessage, { role: "tool" }>): string {
  const chunks: string[] = [];
  for (const part of msg.content) {
    // v5 ToolResultPart carries the result under `output` as a typed union.
    chunks.push(
      `[tool-result name=${part.toolName} id=${part.toolCallId}] ${renderToolOutput(part.output)}`,
    );
  }
  return chunks.join("\n");
}

/** Render a v5 tool-result `output` union into a flat string for the prompt. */
function renderToolOutput(
  output: Extract<PromptMessage, { role: "tool" }>["content"][number]["output"],
): string {
  switch (output.type) {
    case "text":
    case "error-text":
      return output.value;
    case "json":
    case "error-json":
      return stringifyValue(output.value);
    case "content":
      return output.value
        .map((c) => (c.type === "text" ? c.text : `[media ${c.mediaType}]`))
        .join("\n");
    default:
      return "";
  }
}

// ---------------------------------------------------------------------------
// Tools → MCP server
// ---------------------------------------------------------------------------

const FRAMEWORK_SERVER = "agent_runner_tools";

/**
 * Build an in-process MCP server that exposes each LanguageModelV2 function
 * tool. The handlers never actually execute — `canUseTool` intercepts first
 * and aborts. They're still installed so Claude sees real tool schemas.
 */
function buildToolsServer(tools: ReadonlyArray<LanguageModelV2FunctionTool>):
  | {
      server: McpSdkServerConfigWithInstance;
      allowedTools: string[];
    }
  | undefined {
  if (tools.length === 0) return undefined;

  const sdkTools = tools.map((t) =>
    // We pass an empty Zod shape — Claude will still see the tool name +
    // description and `canUseTool` records the actual call arguments.
    sdkTool(t.name, t.description ?? "", {} as Record<string, z.ZodTypeAny>, async () => {
      // Never reached — canUseTool aborts before handler runs.
      return {
        content: [{ type: "text" as const, text: "__AGENT_RUNNER_INTERCEPTED__" }],
      };
    }),
  );

  const server = createSdkMcpServer({
    name: FRAMEWORK_SERVER,
    tools: sdkTools,
  });

  const allowedTools = sdkTools.map((t: { name: string }) => `mcp__${FRAMEWORK_SERVER}__${t.name}`);

  return { server, allowedTools };
}

/**
 * Resolve `mcp__server__tool` back to the original tool name Claude was
 * offered. For framework tools we strip the `mcp__agent_runner_tools__`
 * prefix so `LanguageModelV2` consumers see the original tool names.
 */
function normalizeToolName(sdkToolName: string): string {
  const prefix = `mcp__${FRAMEWORK_SERVER}__`;
  if (sdkToolName.startsWith(prefix)) return sdkToolName.slice(prefix.length);
  return sdkToolName;
}

// ---------------------------------------------------------------------------
// ClaudeCodeLanguageModel
// ---------------------------------------------------------------------------

interface PendingToolCall {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly args: Record<string, unknown>;
}

export class ClaudeCodeLanguageModel implements LanguageModelV2 {
  readonly specificationVersion = "v2" as const;
  readonly provider = "claude-code";
  readonly modelId: string;
  /**
   * No remote URLs are natively supported — the Claude Agent SDK takes a flat
   * string prompt, so any URL must be downloaded by the AI SDK and passed as
   * data. An empty map means "download everything".
   */
  readonly supportedUrls: Record<string, RegExp[]> = {};

  private readonly _opts: ClaudeCodeProviderOptions;

  constructor(modelId: string, opts: ClaudeCodeProviderOptions = {}) {
    this.modelId = modelId;
    this._opts = opts;
  }

  // -------------------------------------------------------------------------
  // doGenerate
  // -------------------------------------------------------------------------

  doGenerate(options: LanguageModelV2CallOptions): ReturnType<LanguageModelV2["doGenerate"]> {
    return this._doGenerate(options);
  }

  private async _doGenerate(
    options: LanguageModelV2CallOptions,
  ): Promise<Awaited<ReturnType<LanguageModelV2["doGenerate"]>>> {
    const { systemPrompt, promptString, sdkOptions, captured } = this._prepare(options);

    const textParts: string[] = [];
    let inputTokens = 0;
    let outputTokens = 0;
    let sdkStopReason: string | null = null;

    try {
      for await (const msg of query({
        prompt: promptString,
        options: { ...sdkOptions, systemPrompt },
      })) {
        if (msg.type === "assistant" && "message" in msg) {
          const content = msg.message?.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (
                block &&
                typeof block === "object" &&
                "text" in block &&
                typeof block.text === "string"
              ) {
                textParts.push(block.text);
              }
            }
          }
        } else if (msg.type === "result") {
          const m = msg as Record<string, unknown>;
          const usage = m.usage as Record<string, number> | undefined;
          if (usage) {
            inputTokens = usage.input_tokens ?? 0;
            outputTokens = usage.output_tokens ?? 0;
          }
          if (typeof m.stop_reason === "string") {
            sdkStopReason = m.stop_reason;
          }
        }
      }
    } catch (err) {
      // `canUseTool` may throw `AbortError` when we interrupt. If we have
      // captured tool calls, that's a successful short-circuit — fall
      // through. Otherwise rethrow.
      if (captured.toolCalls.length === 0) throw err;
    }

    const text = textParts.join("");

    // v5 output is an ordered `content` parts array (was top-level
    // text/toolCalls). Tool-call `input` is a stringified JSON object.
    const content: LanguageModelV2Content[] = [];
    if (text.length > 0) {
      content.push({ type: "text" as const, text });
    }
    for (const tc of captured.toolCalls) {
      content.push({
        type: "tool-call" as const,
        toolCallId: tc.toolCallId,
        toolName: tc.toolName,
        input: JSON.stringify(tc.args),
      });
    }

    const finishReason = deriveFinishReason({
      hasToolCalls: captured.toolCalls.length > 0,
      sdkStopReason,
    });

    return {
      content,
      finishReason,
      usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens },
      warnings: [],
    };
  }

  // -------------------------------------------------------------------------
  // doStream
  // -------------------------------------------------------------------------

  doStream(options: LanguageModelV2CallOptions): ReturnType<LanguageModelV2["doStream"]> {
    return this._doStream(options);
  }

  private async _doStream(
    options: LanguageModelV2CallOptions,
  ): Promise<Awaited<ReturnType<LanguageModelV2["doStream"]>>> {
    const { systemPrompt, promptString, sdkOptions, captured } = this._prepare(options);
    // v5 text deltas are grouped by a stable `id` between text-start/text-end.
    const textId = "text-0";

    const stream = new ReadableStream<LanguageModelV2StreamPart>({
      start: async (controller) => {
        let inputTokens = 0;
        let outputTokens = 0;
        let sdkStopReason: string | null = null;
        const emittedTextChunks = new Set<number>();
        const textBuffer: string[] = [];
        let textStarted = false;
        const startText = () => {
          if (!textStarted) {
            controller.enqueue({ type: "text-start", id: textId });
            textStarted = true;
          }
        };

        // v5 requires a leading `stream-start` carrying any warnings.
        controller.enqueue({ type: "stream-start", warnings: [] });

        try {
          for await (const msg of query({
            prompt: promptString,
            options: { ...sdkOptions, systemPrompt, includePartialMessages: true },
          })) {
            const msgType = (msg as { type?: string }).type;
            if (msgType === "stream_event" && "event" in msg) {
              const maybe = msg as { event?: { delta?: { text?: string } } };
              const delta = maybe.event?.delta?.text;
              if (delta) {
                textBuffer.push(delta);
                startText();
                controller.enqueue({ type: "text-delta", id: textId, delta });
              }
            } else if (msgType === "assistant" && "message" in msg) {
              const content = (msg as { message?: { content?: unknown[] } }).message?.content;
              if (Array.isArray(content)) {
                let idx = 0;
                for (const block of content) {
                  if (
                    block &&
                    typeof block === "object" &&
                    "text" in (block as Record<string, unknown>) &&
                    typeof (block as { text: unknown }).text === "string"
                  ) {
                    if (textBuffer.length === 0 && !emittedTextChunks.has(idx)) {
                      startText();
                      controller.enqueue({
                        type: "text-delta",
                        id: textId,
                        delta: (block as { text: string }).text,
                      });
                      emittedTextChunks.add(idx);
                    }
                  }
                  idx++;
                }
              }
            } else if (msgType === "result") {
              const m = msg as Record<string, unknown>;
              const usage = m.usage as Record<string, number> | undefined;
              if (usage) {
                inputTokens = usage.input_tokens ?? 0;
                outputTokens = usage.output_tokens ?? 0;
              }
              if (typeof m.stop_reason === "string") sdkStopReason = m.stop_reason;
            }
          }
        } catch (err) {
          if (captured.toolCalls.length === 0) {
            controller.enqueue({ type: "error", error: err });
            controller.close();
            return;
          }
        }

        if (textStarted) {
          controller.enqueue({ type: "text-end", id: textId });
        }

        for (const tc of captured.toolCalls) {
          controller.enqueue({
            type: "tool-call",
            toolCallId: tc.toolCallId,
            toolName: tc.toolName,
            input: JSON.stringify(tc.args),
          } satisfies LanguageModelV2ToolCall & { type: "tool-call" });
        }

        const finishReason = deriveFinishReason({
          hasToolCalls: captured.toolCalls.length > 0,
          sdkStopReason,
        });

        controller.enqueue({
          type: "finish",
          finishReason,
          usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens },
        });
        controller.close();
      },
    });

    return {
      stream,
      request: { body: promptString },
      response: {},
    };
  }

  // -------------------------------------------------------------------------
  // Internal — build SDK options + prompt string for a call
  // -------------------------------------------------------------------------

  private _prepare(options: LanguageModelV2CallOptions): {
    systemPrompt: string | undefined;
    promptString: string;
    sdkOptions: SDKOptions;
    captured: { toolCalls: PendingToolCall[] };
  } {
    const systemPrompt = extractSystemPrompt(options.prompt);
    const promptString = renderConversation(options.prompt) || " ";

    // v5 lifts tools to the top-level `options.tools` array (was
    // `options.mode.tools`). We only handle plain function tools.
    const fnTools: LanguageModelV2FunctionTool[] = [];
    if (options.tools) {
      for (const t of options.tools) {
        if (t.type === "function") fnTools.push(t);
      }
    }

    const captured: { toolCalls: PendingToolCall[] } = { toolCalls: [] };

    const canUseTool: SDKOptions["canUseTool"] = async (
      toolName: string,
      input: Record<string, unknown>,
      ctx: { toolUseID: string },
    ): Promise<PermissionResult> => {
      const normalized = normalizeToolName(toolName);
      captured.toolCalls.push({
        toolCallId: ctx.toolUseID,
        toolName: normalized,
        args: input,
      });
      return {
        behavior: "deny",
        message: "Tool call intercepted by AgentRunner",
        interrupt: true,
      };
    };

    const sdkOptions: SDKOptions = {
      ...(this._opts.defaults ?? {}),
      model: mapModel(this.modelId) ?? this._opts.defaults?.model ?? this.modelId,
      maxTurns: this._opts.maxTurns ?? 10,
      permissionMode: "default",
      canUseTool,
    };

    const built = buildToolsServer(fnTools);
    if (built) {
      sdkOptions.mcpServers = {
        ...(sdkOptions.mcpServers ?? {}),
        [FRAMEWORK_SERVER]: built.server,
      } as SDKOptions["mcpServers"];
      sdkOptions.allowedTools = [...(sdkOptions.allowedTools ?? []), ...built.allowedTools];
    }

    if (!this._opts.allowBuiltinTools) {
      sdkOptions.disallowedTools = [
        ...(sdkOptions.disallowedTools ?? []),
        ...BLOCKED_BUILTIN_TOOLS,
      ];
    }

    return { systemPrompt, promptString, sdkOptions, captured };
  }
}

// ---------------------------------------------------------------------------
// Derive finish reason
// ---------------------------------------------------------------------------

function deriveFinishReason(args: {
  hasToolCalls: boolean;
  sdkStopReason: string | null;
}): LanguageModelV2FinishReason {
  if (args.hasToolCalls) return "tool-calls";
  switch (args.sdkStopReason) {
    case "end_turn":
    case "stop_sequence":
      return "stop";
    case "max_tokens":
      return "length";
    case "tool_use":
      return "tool-calls";
    default:
      return "stop";
  }
}

// ---------------------------------------------------------------------------
// Provider factory
// ---------------------------------------------------------------------------

/**
 * Create a `LanguageModelV2` backed by the Claude Agent SDK.
 *
 * @example
 * ```ts
 * import { claudeCode } from "@agentic-patterns/runtime/providers";
 * import { AgentRunner } from "@agentic-patterns/runtime";
 *
 * const runner = new AgentRunner(claudeCode("sonnet"));
 * const result = await runner.run(agent, "What is 17 + 28?");
 * ```
 */
export function claudeCode(
  modelId: string,
  opts?: ClaudeCodeProviderOptions,
): ClaudeCodeLanguageModel {
  return new ClaudeCodeLanguageModel(modelId, opts);
}

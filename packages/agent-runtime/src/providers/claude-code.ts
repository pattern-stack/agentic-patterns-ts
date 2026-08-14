/**
 * Claude Code LanguageModelV4 provider.
 *
 * Wraps the Claude Agent SDK's `query()` function in a Vercel AI SDK
 * `LanguageModelV4` so agents can be executed through `AgentRunner` using
 * a Claude Max subscription (OAuth cached in ~/.claude) or an
 * `ANTHROPIC_API_KEY` env var picked up by the SDK itself.
 *
 * Unlike `ClaudeCodeRunner` / `ClaudeCodeAPIRunner`, this provider plugs
 * into the *standard* AgentRunner execution loop. That means the full
 * canonical event vocabulary (`iteration.start`, `llm.start`, `tool.*`,
 * `iteration.end`, `llm.end`, …) fires automatically — closing the
 * observability gap those runners have.
 *
 * ## Tool interception: `deferred_tool_use`, not `canUseTool`
 *
 * The framework owns tool execution (AgentRunner's `toolExecutor`), so the
 * provider must extract the model's tool call and hand control back rather
 * than letting the SDK run the tool. It does this with a **`PreToolUse` hook
 * returning `permissionDecision: "defer"`** (F-3;
 * `.ai-docs/stacks/harness-runners/f3-deferred-tools.md`). Defer terminates
 * the print-mode run *before the tool executes* and surfaces the call as
 * `result.deferred_tool_use = { id, name, input }` — cleanly, with no denial
 * written into history. This replaces the v1 `canUseTool` deny+`interrupt`
 * hack, which recorded a *denial* in the transcript and so made SDK session
 * resume desynchronize.
 *
 * ## Session economics (Axis A-2): two strategies
 *
 *   - **`deferred`** (default via `"auto"`): a single CC session is kept alive
 *     across tool-loop iterations. Turn 1 runs a fresh `query()` and captures
 *     the `session_id`; each later `doGenerate` parks the framework tool
 *     result where a host-controlled **stdio MCP shim** (`cc-shim.ts`) serves
 *     it, then `options.resume`s the session — append-only, prompt-cache
 *     friendly, ≤1 subprocess per LLM turn. See `cc-session.ts`.
 *   - **`flatten`** (v1 fallback, auto-selected when defer is unavailable):
 *     every `doGenerate` re-flattens the whole history into a string prompt
 *     and runs a fresh single-turn `query()` against an in-process SDK MCP
 *     server. Correct but re-sends the transcript each turn.
 *
 * Claude-Code-native tools (Read/Write/Edit/Bash/…) are disallowed so only
 * framework tools flow.
 */

import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4Content,
  LanguageModelV4FinishReason,
  LanguageModelV4FunctionTool,
  LanguageModelV4Prompt,
  LanguageModelV4StreamPart,
  LanguageModelV4Usage,
  SharedV4Warning,
} from "@ai-sdk/provider";
import {
  type McpSdkServerConfigWithInstance,
  type PreToolUseHookInput,
  type Options as SDKOptions,
  createSdkMcpServer,
  query,
  tool as sdkTool,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

import {
  type CCConfigSource,
  type OAuthTokenSource,
  applyIsolatedEnv,
  createIsolatedConfigDir,
  removeIsolatedConfigDir,
  resolveOAuthToken,
} from "../runner/cc-config.js";
import {
  DEFAULT_SESSION_TTL_MS,
  SessionCache,
  type SessionEntry,
  conversationIdentity,
  findPendingToolResult,
} from "./cc-session.js";
import {
  FRAMEWORK_SERVER,
  createShim,
  disposeShim,
  parkResult,
  writeShimSchemas,
} from "./cc-shim.js";

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

/**
 * How the provider spends CC subprocesses across an AgentRunner tool loop.
 *
 *   - `"auto"` (default): use `deferred` when the SDK/CLI supports it, and
 *     degrade to `flatten` on any contradiction at runtime (poisoned resume,
 *     shim spawn failure). Best of both — session economy where it works,
 *     correctness always.
 *   - `"deferred"`: force the session-resume path (opt-in; surfaces defer
 *     failures instead of silently degrading).
 *   - `"flatten"`: force the v1 stateless path (a fresh subprocess per turn).
 */
export type SessionStrategy = "auto" | "deferred" | "flatten";

/**
 * One-per-`doGenerate` observability event describing the session path taken.
 * Emitted to `ClaudeCodeProviderOptions.onDebug` when provided — the seam used
 * to verify session economics (≤1 subprocess per turn; append-only session):
 * a `resume` whose `resumeOf` equals the prior turn's `sessionId` proves the
 * CC session was continued, not re-spawned.
 */
export interface CCSessionDebugEvent {
  /** Which path this turn ran. */
  readonly phase: "fresh" | "resume" | "flatten";
  /** CC `session_id` this turn used (stable across an append-only run). */
  readonly sessionId: string | null;
  /** For `resume`, the session id being resumed (equals a prior `sessionId`). */
  readonly resumeOf: string | null;
  /** The deferred `tool_use_id` this turn handed back, if any. */
  readonly deferredId: string | null;
}

export interface ClaudeCodeProviderOptions {
  /** Defaults merged with every SDK query call. */
  defaults?: Partial<SDKOptions>;
  /** Include Claude Code's built-in tools (Read/Write/Bash/…). Default: false. */
  allowBuiltinTools?: boolean;
  /**
   * Max turns inside the SDK loop. Default: 10.
   *
   * Within one `doGenerate`, Claude may emit prose-only on its first turn and
   * produce a tool call on a later turn. The `PreToolUse` defer hook aborts on
   * the first tool call regardless, so this only needs to be generous enough
   * to allow "plan-then-tool" sequences. A too-low value causes the SDK to
   * throw `Reached maximum number of turns` before Claude reaches any tool
   * call.
   */
  maxTurns?: number;
  /**
   * Session economics strategy (Axis A-2). Default: `"auto"`.
   * @see SessionStrategy
   */
  sessionStrategy?: SessionStrategy;
  /**
   * Idle TTL (ms) for cached `deferred`-strategy sessions. A session untouched
   * this long is evicted and its shim child process torn down. Default: 5 min.
   */
  sessionTtlMs?: number;
  /**
   * Config source (Axis B). Defaults to `{ mode: "isolated" }`.
   *
   * As a plain-model endpoint the provider must NOT inherit the host's
   * ~/.claude — connectors, plugins, skills, settings, hooks — so isolated
   * mode is the default. Pass `{ mode: "host" }` to explicitly opt into the
   * developer's host config. Isolated mode redirects `CLAUDE_CONFIG_DIR` to
   * a fresh dir (optionally seeded from `profile`) and injects an OAuth token
   * (see `oauthToken`).
   */
  config?: CCConfigSource;
  /**
   * OAuth token source for isolated mode. Falls back to the
   * `CLAUDE_CODE_OAUTH_TOKEN` env var, then the macOS Keychain. In isolated
   * mode a token from one of those three sources is REQUIRED — construction
   * fails closed when none resolves (see the constructor). Re-resolved per
   * session so a thunk / rotated token is honored (not frozen at construction).
   */
  oauthToken?: OAuthTokenSource;
  /**
   * Optional per-`doGenerate` observability hook (see {@link CCSessionDebugEvent}).
   * No-op by default; used to verify session economics. Never throws into the
   * caller — a throwing handler is swallowed.
   */
  onDebug?: (event: CCSessionDebugEvent) => void;
}

/**
 * Thrown at construction when the provider is in isolated config mode but no
 * OAuth token resolves from any of the three sources. Failing closed here
 * (rather than silently falling through to the host config) guarantees the
 * provider never leaks the developer's connectors/plugins into a run that
 * asked to act as a plain model.
 */
const ISOLATED_NO_TOKEN_MESSAGE =
  "claudeCode provider: isolated config mode requires an OAuth token, but none " +
  "resolved. Provide one via the `oauthToken` option, the CLAUDE_CODE_OAUTH_TOKEN " +
  "environment variable, or a Claude Max login in the macOS Keychain. To use the " +
  'host ~/.claude config instead, pass `config: { mode: "host" }`.';

// ---------------------------------------------------------------------------
// Prompt flattening
// ---------------------------------------------------------------------------

/**
 * Extract the single system prompt from a LanguageModelV4 message array.
 *
 * LanguageModelV4Prompt only ever contains one leading system message (if
 * any) — the AI SDK normalizes `generateText({ system, messages })` into
 * a prompt that starts with `{ role: 'system' }`.
 */
function extractSystemPrompt(prompt: LanguageModelV4Prompt): string | undefined {
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
 * resume support. Used by the `flatten` strategy and by the first (fresh)
 * turn of the `deferred` strategy.
 */
function renderConversation(prompt: LanguageModelV4Prompt): string {
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

type PromptMessage = LanguageModelV4Prompt[number];

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
      // ToolCallPart carries the payload under `input` (was `args` pre-v5;
      // unrelated to the V2→V4 LanguageModel spec axis this file promotes).
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
    // V4 adds a `tool-approval-response` part to the tool-message union
    // alongside `tool-result` — skip it here (the approval loop is #389's
    // surface, out of scope for this promotion).
    if (part.type !== "tool-result") continue;
    // ToolResultPart carries the result under `output` as a typed union
    // (ai package's v5+ shape; unrelated to the V2→V4 spec axis).
    chunks.push(
      `[tool-result name=${part.toolName} id=${part.toolCallId}] ${renderToolOutput(part.output)}`,
    );
  }
  return chunks.join("\n");
}

type ToolResultPart = Extract<
  Extract<PromptMessage, { role: "tool" }>["content"][number],
  { type: "tool-result" }
>;

/** Render a V4 tool-result `output` union into a flat string for the prompt. */
function renderToolOutput(output: ToolResultPart["output"]): string {
  switch (output.type) {
    case "text":
    case "error-text":
      return output.value;
    case "json":
    case "error-json":
      return stringifyValue(output.value);
    case "execution-denied":
      return `[tool execution denied${output.reason ? `: ${output.reason}` : ""}]`;
    case "content":
      return output.value
        .map((c) => {
          switch (c.type) {
            case "text":
              return c.text;
            case "file":
              return `[file ${c.mediaType}]`;
            case "custom":
              return "[custom content]";
            default: {
              const _exhaustive: never = c;
              void _exhaustive;
              return "[custom content]";
            }
          }
        })
        .join("\n");
    default: {
      // Exhaustiveness check — a future V5 ToolResultOutput variant will fail
      // typecheck here instead of silently falling through to "".
      const _exhaustive: never = output;
      void _exhaustive;
      return "";
    }
  }
}

// ---------------------------------------------------------------------------
// JSON Schema → Zod (just enough to round-trip the tool param schemas)
//
// The provider sits at the LanguageModelV4 boundary, where the AI SDK has
// already projected each tool to JSON Schema (the original Zod is gone). But the
// Agent SDK's tool() helper only accepts a ZodRawShape — so we rebuild one from
// `inputSchema` for the in-process (flatten) server. Without it Claude sees NO
// parameter types and serializes nested objects (filter/rank_by) as strings →
// the real tool's Zod rejects them. We only need enough for Claude to form valid
// calls; the framework's real tool does the authoritative validation after the
// deferred call hands execution back to AgentRunner.
// ---------------------------------------------------------------------------

type JsonSchemaNode = Record<string, unknown>;

function resolveRef(node: JsonSchemaNode, root: JsonSchemaNode): JsonSchemaNode {
  const ref = node.$ref;
  if (typeof ref !== "string" || !ref.startsWith("#/")) return node;
  let cur: unknown = root;
  for (const seg of ref.slice(2).split("/")) cur = (cur as JsonSchemaNode | undefined)?.[seg];
  return (cur as JsonSchemaNode) ?? node;
}

function objectShape(node: JsonSchemaNode, root: JsonSchemaNode): Record<string, z.ZodTypeAny> {
  const props = (node.properties as Record<string, JsonSchemaNode>) ?? {};
  const required = new Set(Array.isArray(node.required) ? (node.required as string[]) : []);
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [k, v] of Object.entries(props)) {
    const zt = jsonSchemaToZod(v, root);
    shape[k] = required.has(k) ? zt : zt.optional();
  }
  return shape;
}

function jsonSchemaToZod(schema: JsonSchemaNode | undefined, root: JsonSchemaNode): z.ZodTypeAny {
  if (!schema || typeof schema !== "object") return z.any();
  const node = "$ref" in schema ? resolveRef(schema, root) : schema;
  const desc = typeof node.description === "string" ? node.description : undefined;
  const withDesc = (zt: z.ZodTypeAny): z.ZodTypeAny => (desc ? zt.describe(desc) : zt);
  if (node.anyOf || node.oneOf || node.allOf) return withDesc(z.any());
  const type = Array.isArray(node.type) ? node.type[0] : node.type;
  switch (type) {
    case "string": {
      const en = node.enum;
      if (Array.isArray(en) && en.length > 0 && en.every((v) => typeof v === "string")) {
        return withDesc(z.enum(en as [string, ...string[]]));
      }
      return withDesc(z.string());
    }
    case "number":
    case "integer":
      return withDesc(z.number());
    case "boolean":
      return withDesc(z.boolean());
    case "array":
      return withDesc(z.array(jsonSchemaToZod(node.items as JsonSchemaNode, root)));
    case "object":
      return withDesc(z.object(objectShape(node, root)).passthrough());
    default:
      return withDesc(z.any());
  }
}

/** Top-level JSON Schema → ZodRawShape for the Agent SDK's tool() helper. */
function jsonSchemaToZodShape(schema: unknown): Record<string, z.ZodTypeAny> {
  const root = (schema ?? {}) as JsonSchemaNode;
  return objectShape(root, root);
}

/**
 * Build an in-process MCP server exposing each LanguageModelV4 function tool,
 * used by the `flatten` strategy and by `doStream`. The handlers never run —
 * the `PreToolUse` defer hook aborts before any handler is reached — they're
 * installed only so Claude sees real tool schemas. (The `deferred` strategy
 * uses the stdio shim in `cc-shim.ts` instead, because the in-process server
 * is not resumable; see F-3.)
 *
 * V4's `strict`/`inputExamples` `FunctionTool` fields are accepted (the type
 * carries them) but intentionally ignored here — these advisory schemas only
 * need to be good enough for Claude to form a call; the framework's real Zod
 * schema does the authoritative validation after the deferred call hands
 * execution back to AgentRunner. No warning is emitted for the unsupported
 * knobs, matching this provider's existing silent-ignore posture.
 */
function buildToolsServer(tools: ReadonlyArray<LanguageModelV4FunctionTool>):
  | {
      server: McpSdkServerConfigWithInstance;
      allowedTools: string[];
    }
  | undefined {
  if (tools.length === 0) return undefined;

  const sdkTools = tools.map((t) =>
    sdkTool(t.name, t.description ?? "", jsonSchemaToZodShape(t.inputSchema), async () => {
      // Never reached — the defer hook aborts before the handler runs.
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
 * prefix so `LanguageModelV4` consumers see the original tool names.
 */
function normalizeToolName(sdkToolName: string): string {
  const prefix = `mcp__${FRAMEWORK_SERVER}__`;
  if (sdkToolName.startsWith(prefix)) return sdkToolName.slice(prefix.length);
  return sdkToolName;
}

// ---------------------------------------------------------------------------
// Defer hook
// ---------------------------------------------------------------------------

/**
 * Build the `PreToolUse` hook that drives tool interception.
 *
 *   - Fresh turns (`allowId = null`): **defer every call** — the SDK ends the
 *     run and surfaces the single call as `result.deferred_tool_use`.
 *   - Resumed turns (`allowId = <pending tool_use_id>`): **allow exactly that
 *     call** so the stdio shim executes it and serves the host-parked result;
 *     defer any *new* call the model then makes (it becomes the next deferred
 *     hand-back). Without the allow, resume would re-defer the pending call and
 *     never consume the parked result (F-3: defer re-chaining on resume).
 */
function makeDeferHook(allowId: string | null): NonNullable<SDKOptions["hooks"]> {
  return {
    PreToolUse: [
      {
        hooks: [
          async (input): Promise<{ hookSpecificOutput: PreToolUseHookSpecificOutputShape }> => {
            const toolUseId = (input as PreToolUseHookInput).tool_use_id;
            if (allowId && toolUseId === allowId) {
              return {
                hookSpecificOutput: {
                  hookEventName: "PreToolUse",
                  permissionDecision: "allow",
                  permissionDecisionReason: "host-parked framework tool result",
                },
              };
            }
            return {
              hookSpecificOutput: {
                hookEventName: "PreToolUse",
                permissionDecision: "defer",
                permissionDecisionReason: "handed back to AgentRunner",
              },
            };
          },
        ],
      },
    ],
  };
}

interface PreToolUseHookSpecificOutputShape {
  hookEventName: "PreToolUse";
  permissionDecision: "allow" | "defer";
  permissionDecisionReason: string;
}

// ---------------------------------------------------------------------------
// Query execution
// ---------------------------------------------------------------------------

interface DeferredCall {
  readonly id: string;
  readonly name: string;
  readonly input: Record<string, unknown>;
}

interface QueryOutcome {
  readonly text: string;
  /** The single deferred call this turn produced, if any (normalized name). */
  readonly deferred: DeferredCall | null;
  /** CC `session_id` observed (from init and/or the result message). */
  readonly sessionId: string | null;
  readonly isError: boolean;
  readonly stopReason: string | null;
  readonly terminalReason: string | null;
  /**
   * The raw SDK result usage object, captured whole (not just
   * `input_tokens`/`output_tokens`) so cache — and any future — fields
   * survive to {@link buildUsage}. `null` when a result carried no usage.
   */
  readonly usage: Record<string, number> | null;
}

/**
 * Run one `query()` to its first `result` message and translate it.
 *
 * Junk-turn guard (F-3): on resume with an empty prompt the CLI synthesizes a
 * "Continue…" turn *after* the genuine continuation. We consume the first
 * result (the real one) and stop iterating; a best-effort `interrupt()` closes
 * the subprocess so no spurious extra turn runs.
 */
async function runQuery(promptString: string, sdkOptions: SDKOptions): Promise<QueryOutcome> {
  const textParts: string[] = [];
  let deferred: DeferredCall | null = null;
  let sessionId: string | null = null;
  let isError = false;
  let stopReason: string | null = null;
  let terminalReason: string | null = null;
  let usage: Record<string, number> | null = null;

  const q = query({ prompt: promptString, options: sdkOptions });
  try {
    for await (const msg of q) {
      const m = msg as Record<string, unknown>;
      const type = m.type;
      if (type === "system" && m.subtype === "init" && typeof m.session_id === "string") {
        sessionId = m.session_id;
      } else if (type === "assistant" && "message" in m) {
        const content = (m.message as { content?: unknown[] } | undefined)?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (
              block &&
              typeof block === "object" &&
              "text" in block &&
              typeof (block as { text: unknown }).text === "string"
            ) {
              textParts.push((block as { text: string }).text);
            }
          }
        }
      } else if (type === "result") {
        if (typeof m.session_id === "string") sessionId = m.session_id;
        if (m.usage && typeof m.usage === "object") {
          usage = m.usage as Record<string, number>;
        }
        if (typeof m.stop_reason === "string") stopReason = m.stop_reason;
        if (typeof m.terminal_reason === "string") terminalReason = m.terminal_reason;
        isError = m.is_error === true;
        const dtu = m.deferred_tool_use as
          | { id?: unknown; name?: unknown; input?: unknown }
          | undefined;
        if (dtu && typeof dtu.id === "string" && typeof dtu.name === "string") {
          deferred = {
            id: dtu.id,
            name: normalizeToolName(dtu.name),
            input: (dtu.input as Record<string, unknown> | undefined) ?? {},
          };
        }
        // First result is terminal for this turn — stop consuming.
        break;
      }
    }
  } finally {
    const maybeInterrupt = (q as { interrupt?: () => Promise<unknown> }).interrupt;
    if (typeof maybeInterrupt === "function") {
      try {
        await maybeInterrupt.call(q);
      } catch {
        // interrupt() is only effective on streaming input; ignore otherwise.
      }
    }
  }

  return {
    text: textParts.join(""),
    deferred,
    sessionId,
    isError,
    stopReason,
    terminalReason,
    usage,
  };
}

/**
 * Map the CLI's raw result usage (`NonNullableUsage`-shaped `BetaUsage`) into
 * a V4 nested `LanguageModelV4Usage`. The **cache** formula mirrors
 * `@ai-sdk/anthropic@4` for cross-provider consistency: `total = input_tokens
 * + cache_creation + cache_read`, `noCache = input_tokens`. Absent cache
 * fields (a degraded CLI path, or a test mock that omits them) coalesce to
 * `0` — matching `NonNullableUsage`'s all-present contract. A wholly-absent
 * `raw` (no usage on the result at all) yields all-`undefined` nested fields
 * instead of fabricating zeros.
 *
 * `outputTokens.text`/`.reasoning` are intentionally left `undefined` rather
 * than mirroring anthropic@4's `output_tokens_details.thinking_tokens` split
 * — the lock-resolved `@anthropic-ai/sdk` `BetaUsage` (the CLI's usage shape)
 * carries no `output_tokens_details` field today, so there is nothing to
 * derive from. Output-token detail is intentionally deferred; #388 will wire
 * it through here if/when the CLI's usage payload grows that field.
 */
function buildUsage(raw: Record<string, number> | null): LanguageModelV4Usage {
  if (!raw) {
    return {
      inputTokens: {
        total: undefined,
        noCache: undefined,
        cacheRead: undefined,
        cacheWrite: undefined,
      },
      outputTokens: { total: undefined, text: undefined, reasoning: undefined },
      raw: undefined,
    };
  }
  const inputTokens = raw.input_tokens ?? 0;
  const outputTokens = raw.output_tokens ?? 0;
  const cacheWrite = raw.cache_creation_input_tokens ?? 0;
  const cacheRead = raw.cache_read_input_tokens ?? 0;
  return {
    inputTokens: {
      total: inputTokens + cacheWrite + cacheRead,
      noCache: inputTokens,
      cacheRead,
      cacheWrite,
    },
    outputTokens: {
      total: outputTokens,
      text: undefined,
      reasoning: undefined,
    },
    raw,
  };
}

/** Translate a `QueryOutcome` into a V4 `doGenerate` return value. */
function buildGenerateResult(
  out: QueryOutcome,
  warnings: SharedV4Warning[],
): Awaited<ReturnType<LanguageModelV4["doGenerate"]>> {
  const content: LanguageModelV4Content[] = [];
  if (out.text.length > 0) content.push({ type: "text", text: out.text });
  if (out.deferred) {
    content.push({
      type: "tool-call",
      toolCallId: out.deferred.id,
      toolName: out.deferred.name,
      input: JSON.stringify(out.deferred.input),
    });
  }
  return {
    content,
    finishReason: deriveFinishReason({
      hasToolCalls: out.deferred !== null,
      sdkStopReason: out.stopReason,
    }),
    usage: buildUsage(out.usage),
    warnings,
  };
}

// ---------------------------------------------------------------------------
// ClaudeCodeLanguageModel
// ---------------------------------------------------------------------------

export class ClaudeCodeLanguageModel implements LanguageModelV4 {
  readonly specificationVersion = "v4" as const;
  readonly provider = "claude-code";
  readonly modelId: string;
  /**
   * No remote URLs are natively supported — the Claude Agent SDK takes a flat
   * string prompt, so any URL must be downloaded by the AI SDK and passed as
   * data. An empty map means "download everything".
   */
  readonly supportedUrls: Record<string, RegExp[]> = {};

  private readonly _opts: ClaudeCodeProviderOptions;
  private readonly _config: CCConfigSource;
  private readonly _oauthToken: OAuthTokenSource | undefined;
  private readonly _sessionStrategy: SessionStrategy;
  /** Isolated CLAUDE_CONFIG_DIR created at construction; null in host mode. */
  private readonly _isolatedConfigDir: string | null;
  /** Token resolved once at construction (fail-closed); re-resolved per call. */
  private readonly _isolatedTokenAtConstruction: string | null;
  /** Live CC sessions for the `deferred` strategy. */
  private readonly _sessions: SessionCache;
  /** Set once "auto" hits a defer contradiction — sticks to flatten thereafter. */
  private _degradedToFlatten = false;
  private _disposed = false;

  constructor(modelId: string, opts: ClaudeCodeProviderOptions = {}) {
    this.modelId = modelId;
    this._opts = opts;
    this._config = opts.config ?? { mode: "isolated" };
    this._oauthToken = opts.oauthToken;
    this._sessionStrategy = opts.sessionStrategy ?? "auto";
    this._sessions = new SessionCache(opts.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS);

    if (this._config.mode === "isolated") {
      // Fail closed (D11): resolve the token BEFORE creating the tmpdir so the
      // throw path leaks nothing. Isolated mode with no resolvable token is a
      // construction-time error — never a silent fall-through to host config.
      const token = resolveOAuthToken(this._oauthToken);
      if (!token) {
        throw new Error(ISOLATED_NO_TOKEN_MESSAGE);
      }
      this._isolatedTokenAtConstruction = token;
      this._isolatedConfigDir = createIsolatedConfigDir(this._config.profile);
    } else {
      this._isolatedTokenAtConstruction = null;
      this._isolatedConfigDir = null;
    }
  }

  /**
   * Tear down every live `deferred`-strategy session (shim children + tmpdirs)
   * and remove the isolated CLAUDE_CONFIG_DIR, if any. Idempotent, and a no-op
   * for host-mode providers with no open sessions. Dispose a provider you no
   * longer need so it does not leak subprocesses or tmpdirs.
   */
  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    this._sessions.disposeAll();
    if (this._isolatedConfigDir) {
      removeIsolatedConfigDir(this._isolatedConfigDir);
    }
  }

  // -------------------------------------------------------------------------
  // doGenerate
  // -------------------------------------------------------------------------

  doGenerate(options: LanguageModelV4CallOptions): ReturnType<LanguageModelV4["doGenerate"]> {
    return this._doGenerate(options);
  }

  private async _doGenerate(
    options: LanguageModelV4CallOptions,
  ): Promise<Awaited<ReturnType<LanguageModelV4["doGenerate"]>>> {
    if (this._resolveStrategy() === "flatten") {
      return this._flattenGenerate(options);
    }
    try {
      return await this._deferGenerate(options);
    } catch (err) {
      // Unexpected defer failure (shim spawn, SDK resolution). In "auto",
      // degrade permanently and fall back; explicit "deferred" surfaces it.
      if (this._sessionStrategy === "auto") {
        this._degradedToFlatten = true;
        return this._flattenGenerate(options);
      }
      throw err;
    }
  }

  /** `"deferred"`/`"auto"` → attempt defer; `"flatten"` or degraded → flatten. */
  private _resolveStrategy(): "deferred" | "flatten" {
    if (this._sessionStrategy === "flatten") return "flatten";
    if (this._degradedToFlatten) return "flatten";
    return "deferred";
  }

  // -------------------------------------------------------------------------
  // deferred strategy — one CC session across the tool loop
  // -------------------------------------------------------------------------

  private async _deferGenerate(
    options: LanguageModelV4CallOptions,
  ): Promise<Awaited<ReturnType<LanguageModelV4["doGenerate"]>>> {
    const systemPrompt = extractSystemPrompt(options.prompt);
    const fnTools = extractFunctionTools(options);
    const identity = conversationIdentity(
      systemPrompt,
      options.prompt,
      fnTools.map((t) => t.name),
    );
    const session = this._sessions.get(identity);
    const pendingResult = findPendingToolResult(options.prompt, session?.pendingDeferredId ?? null);

    if (session?.pendingDeferredId && pendingResult) {
      return this._deferResume(options, identity, session, pendingResult, fnTools, systemPrompt);
    }
    return this._deferFresh(options, identity, fnTools, systemPrompt);
  }

  /** First turn of a conversation: fresh session, capture `session_id`. */
  private async _deferFresh(
    options: LanguageModelV4CallOptions,
    identity: string,
    fnTools: LanguageModelV4FunctionTool[],
    systemPrompt: string | undefined,
  ): Promise<Awaited<ReturnType<LanguageModelV4["doGenerate"]>>> {
    if (fnTools.length === 0) {
      // Nothing to keep a session for — a plain single-turn flatten suffices.
      return this._flattenGenerate(options);
    }
    const shim = createShim(fnTools, this._stringEnv());
    const { sdkOptions, warnings } = this._baseSdkOptions(options);
    sdkOptions.systemPrompt = systemPrompt;
    sdkOptions.mcpServers = shim.mcpServers;
    sdkOptions.allowedTools = [...(sdkOptions.allowedTools ?? []), ...shim.allowedTools];
    sdkOptions.hooks = makeDeferHook(null);

    const promptString = renderConversation(options.prompt) || " ";
    const out = await runQuery(promptString, sdkOptions);

    if (!out.sessionId) {
      // Never learned a session id — cannot resume later; drop the shim and
      // treat this turn's output as-is (flatten will run next turn).
      disposeShim(shim.storeDir);
      return buildGenerateResult(out, warnings);
    }

    const entry: SessionEntry = {
      sessionId: out.sessionId,
      shim,
      pendingDeferredId: out.deferred?.id ?? null,
      lastSeenAt: Date.now(),
    };
    this._sessions.set(identity, entry);
    this._emitDebug({
      phase: "fresh",
      sessionId: out.sessionId,
      resumeOf: null,
      deferredId: out.deferred?.id ?? null,
    });
    return buildGenerateResult(out, warnings);
  }

  /** Later turn: park the tool result and resume the live session. */
  private async _deferResume(
    options: LanguageModelV4CallOptions,
    identity: string,
    session: SessionEntry,
    pendingResult: NonNullable<ReturnType<typeof findPendingToolResult>>,
    fnTools: LanguageModelV4FunctionTool[],
    systemPrompt: string | undefined,
  ): Promise<Awaited<ReturnType<LanguageModelV4["doGenerate"]>>> {
    // Park the framework's real result where the shim will serve it, and keep
    // the advertised schemas current (tool set can shift between turns).
    parkResult(session.shim.resultFile, pendingResult);
    writeShimSchemas(session.shim.schemasFile, fnTools);

    const { sdkOptions, warnings } = this._baseSdkOptions(options);
    sdkOptions.systemPrompt = systemPrompt;
    sdkOptions.mcpServers = session.shim.mcpServers;
    sdkOptions.allowedTools = [...(sdkOptions.allowedTools ?? []), ...session.shim.allowedTools];
    sdkOptions.hooks = makeDeferHook(session.pendingDeferredId);
    sdkOptions.resume = session.sessionId;

    // Empty resume prompt: the parked tool result drives the continuation.
    const out = await runQuery("", sdkOptions);

    if (out.isError || out.terminalReason === "tool_deferred_unavailable") {
      // Poisoned-call guard (F-3): the deferred state was consumed by a failed
      // availability check. Drop the session and recover this turn via flatten
      // (the full history is still in the prompt, so correctness holds).
      this._sessions.delete(identity);
      if (this._sessionStrategy === "auto") this._degradedToFlatten = true;
      return this._flattenGenerate(options);
    }

    // Advance the session: the next pending call (if any) is this turn's
    // deferred hand-back; a terminal turn clears it.
    session.pendingDeferredId = out.deferred?.id ?? null;
    this._sessions.set(identity, session);
    this._emitDebug({
      phase: "resume",
      sessionId: out.sessionId ?? session.sessionId,
      resumeOf: session.sessionId,
      deferredId: out.deferred?.id ?? null,
    });
    return buildGenerateResult(out, warnings);
  }

  // -------------------------------------------------------------------------
  // flatten strategy — v1 stateless path (a fresh subprocess per turn)
  // -------------------------------------------------------------------------

  private async _flattenGenerate(
    options: LanguageModelV4CallOptions,
  ): Promise<Awaited<ReturnType<LanguageModelV4["doGenerate"]>>> {
    const systemPrompt = extractSystemPrompt(options.prompt);
    const fnTools = extractFunctionTools(options);
    const { sdkOptions, warnings } = this._baseSdkOptions(options);
    sdkOptions.systemPrompt = systemPrompt;
    sdkOptions.hooks = makeDeferHook(null);

    const built = buildToolsServer(fnTools);
    if (built) {
      sdkOptions.mcpServers = {
        ...(sdkOptions.mcpServers ?? {}),
        [FRAMEWORK_SERVER]: built.server,
      } as SDKOptions["mcpServers"];
      sdkOptions.allowedTools = [...(sdkOptions.allowedTools ?? []), ...built.allowedTools];
    }

    const promptString = renderConversation(options.prompt) || " ";
    const out = await runQuery(promptString, sdkOptions);
    this._emitDebug({
      phase: "flatten",
      sessionId: out.sessionId,
      resumeOf: null,
      deferredId: out.deferred?.id ?? null,
    });
    return buildGenerateResult(out, warnings);
  }

  private _emitDebug(event: CCSessionDebugEvent): void {
    const onDebug = this._opts.onDebug;
    if (!onDebug) return;
    try {
      onDebug(event);
    } catch {
      // Observability must never break a generation.
    }
  }

  // -------------------------------------------------------------------------
  // doStream — single-turn stream (flatten-style; no session resume)
  // -------------------------------------------------------------------------

  doStream(options: LanguageModelV4CallOptions): ReturnType<LanguageModelV4["doStream"]> {
    return this._doStream(options);
  }

  private async _doStream(
    options: LanguageModelV4CallOptions,
  ): Promise<Awaited<ReturnType<LanguageModelV4["doStream"]>>> {
    const systemPrompt = extractSystemPrompt(options.prompt);
    const fnTools = extractFunctionTools(options);
    const promptString = renderConversation(options.prompt) || " ";

    const { sdkOptions, warnings } = this._baseSdkOptions(options);
    sdkOptions.systemPrompt = systemPrompt;
    sdkOptions.hooks = makeDeferHook(null);
    const built = buildToolsServer(fnTools);
    if (built) {
      sdkOptions.mcpServers = {
        ...(sdkOptions.mcpServers ?? {}),
        [FRAMEWORK_SERVER]: built.server,
      } as SDKOptions["mcpServers"];
      sdkOptions.allowedTools = [...(sdkOptions.allowedTools ?? []), ...built.allowedTools];
    }

    const textId = "text-0";
    const stream = new ReadableStream<LanguageModelV4StreamPart>({
      start: async (controller) => {
        let usage: Record<string, number> | null = null;
        let sdkStopReason: string | null = null;
        let deferred: DeferredCall | null = null;
        const emittedTextChunks = new Set<number>();
        const textBuffer: string[] = [];
        let textStarted = false;
        const startText = () => {
          if (!textStarted) {
            controller.enqueue({ type: "text-start", id: textId });
            textStarted = true;
          }
        };

        controller.enqueue({ type: "stream-start", warnings });

        const q = query({
          prompt: promptString,
          options: { ...sdkOptions, includePartialMessages: true },
        });
        try {
          for await (const msg of q) {
            const m = msg as Record<string, unknown>;
            const type = m.type;
            if (type === "stream_event" && "event" in m) {
              const delta = (m as { event?: { delta?: { text?: string } } }).event?.delta?.text;
              if (delta) {
                textBuffer.push(delta);
                startText();
                controller.enqueue({ type: "text-delta", id: textId, delta });
              }
            } else if (type === "assistant" && "message" in m) {
              const content = (m.message as { content?: unknown[] } | undefined)?.content;
              if (Array.isArray(content)) {
                let idx = 0;
                for (const block of content) {
                  if (
                    block &&
                    typeof block === "object" &&
                    "text" in block &&
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
            } else if (type === "result") {
              if (m.usage && typeof m.usage === "object") {
                usage = m.usage as Record<string, number>;
              }
              if (typeof m.stop_reason === "string") sdkStopReason = m.stop_reason;
              const dtu = m.deferred_tool_use as
                | { id?: unknown; name?: unknown; input?: unknown }
                | undefined;
              if (dtu && typeof dtu.id === "string" && typeof dtu.name === "string") {
                deferred = {
                  id: dtu.id,
                  name: normalizeToolName(dtu.name),
                  input: (dtu.input as Record<string, unknown> | undefined) ?? {},
                };
              }
              break;
            }
          }
        } catch (err) {
          controller.enqueue({ type: "error", error: err });
          controller.close();
          return;
        } finally {
          const maybeInterrupt = (q as { interrupt?: () => Promise<unknown> }).interrupt;
          if (typeof maybeInterrupt === "function") {
            try {
              await maybeInterrupt.call(q);
            } catch {
              // ignore — streaming-input only
            }
          }
        }

        if (textStarted) {
          controller.enqueue({ type: "text-end", id: textId });
        }
        if (deferred) {
          controller.enqueue({
            type: "tool-call",
            toolCallId: deferred.id,
            toolName: deferred.name,
            input: JSON.stringify(deferred.input),
          });
        }

        controller.enqueue({
          type: "finish",
          finishReason: deriveFinishReason({ hasToolCalls: deferred !== null, sdkStopReason }),
          usage: buildUsage(usage),
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
  // Internal — shared SDK option assembly
  // -------------------------------------------------------------------------

  /**
   * Base SDK options common to every query: model, turns, isolation, blocks,
   * and the V4 `reasoning` CallOption mapped onto the harness's `effort` /
   * `thinking` knobs. Any warnings the reasoning mapping produces (currently
   * just the `'minimal'` compatibility downgrade) are returned alongside the
   * options so callers can thread them into the result.
   */
  private _baseSdkOptions(options: LanguageModelV4CallOptions): {
    sdkOptions: SDKOptions;
    warnings: SharedV4Warning[];
  } {
    const sdkOptions: SDKOptions = {
      ...(this._opts.defaults ?? {}),
      model: mapModel(this.modelId) ?? this._opts.defaults?.model ?? this.modelId,
      maxTurns: this._opts.maxTurns ?? 10,
      permissionMode: "default",
    };

    if (!this._opts.allowBuiltinTools) {
      sdkOptions.disallowedTools = [
        ...(sdkOptions.disallowedTools ?? []),
        ...BLOCKED_BUILTIN_TOOLS,
      ];
    }

    // Axis B — isolated config dir + injected OAuth (re-resolved per call so a
    // rotated / thunk token is honored — not frozen at construction).
    if (this._isolatedConfigDir) {
      const token = this._resolveIsolatedToken();
      if (token) applyIsolatedEnv(sdkOptions, this._isolatedConfigDir, token);
    }

    // Applied after the `defaults` spread so a caller-set `reasoning` wins
    // over `opts.defaults.effort`/`thinking`; unset / `'provider-default'`
    // touches nothing, preserving any defaults the caller configured.
    const warnings = applyReasoning(sdkOptions, options.reasoning);

    return { sdkOptions, warnings };
  }

  /**
   * Re-resolve the isolated-mode OAuth token per call (A-1 review nit: don't
   * freeze the token at construction). Falls back to the construction-time
   * value that already satisfied fail-closed, so a transiently-empty thunk
   * never breaks a call.
   */
  private _resolveIsolatedToken(): string | null {
    if (!this._isolatedConfigDir) return null;
    return resolveOAuthToken(this._oauthToken) ?? this._isolatedTokenAtConstruction;
  }

  /** Current process env as a `Record<string, string>` for the shim child. */
  private _stringEnv(): Record<string, string> {
    return Object.fromEntries(
      Object.entries(process.env).filter(([, v]) => typeof v === "string") as [string, string][],
    );
  }
}

// ---------------------------------------------------------------------------
// Reasoning mapping
// ---------------------------------------------------------------------------

/**
 * Apply the V4 `reasoning` CallOption to the SDK options (effort / thinking),
 * mutating `sdkOptions` in place. Returns any warnings the mapping produces
 * (only `'minimal'`, which has no harness equivalent, warns).
 *
 *   - unset / `'provider-default'` — untouched; the harness default
 *     (adaptive thinking) and any caller `defaults.effort`/`defaults.thinking`
 *     stand as-is.
 *   - `'none'` — `thinking: { type: "disabled" }`, and any caller-configured
 *     `defaults.effort` is cleared too, so the disable is total rather than
 *     half-applied (a lingering `effort` alongside `thinking:disabled` would
 *     be an incoherent option pair).
 *   - `'minimal'` — no harness equivalent; mapped to `effort: "low"` with a
 *     `compatibility` warning.
 *   - `'low'` / `'medium'` / `'high'` / `'xhigh'` — `effort` set to the same
 *     value (the harness silently downgrades `xhigh` on models that don't
 *     support it — no warning of our own for that).
 */
function applyReasoning(
  sdkOptions: SDKOptions,
  reasoning: LanguageModelV4CallOptions["reasoning"],
): SharedV4Warning[] {
  switch (reasoning) {
    case undefined:
    case "provider-default":
      return [];
    case "none":
      sdkOptions.thinking = { type: "disabled" };
      sdkOptions.effort = undefined;
      return [];
    case "minimal":
      sdkOptions.effort = "low";
      return [
        {
          type: "compatibility",
          feature: "reasoning",
          details: "'minimal' is not supported by the Claude Code harness; mapped to effort 'low'",
        },
      ];
    case "low":
    case "medium":
    case "high":
    case "xhigh":
      sdkOptions.effort = reasoning;
      return [];
    default: {
      const _exhaustive: never = reasoning;
      void _exhaustive;
      return [];
    }
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Pull the plain function tools out of the call options (drop provider tools). */
function extractFunctionTools(options: LanguageModelV4CallOptions): LanguageModelV4FunctionTool[] {
  const fnTools: LanguageModelV4FunctionTool[] = [];
  if (options.tools) {
    for (const t of options.tools) {
      if (t.type === "function") fnTools.push(t);
    }
  }
  return fnTools;
}

// ---------------------------------------------------------------------------
// Derive finish reason
// ---------------------------------------------------------------------------

function deriveFinishReason(args: {
  hasToolCalls: boolean;
  sdkStopReason: string | null;
}): LanguageModelV4FinishReason {
  const raw = args.sdkStopReason ?? undefined;
  const unified = ((): LanguageModelV4FinishReason["unified"] => {
    if (args.hasToolCalls) return "tool-calls";
    switch (args.sdkStopReason) {
      case null:
        // No stop reason at all reads as a successful completion.
        return "stop";
      case "end_turn":
      case "stop_sequence":
        return "stop";
      case "max_tokens":
        return "length";
      case "tool_use":
      case "tool_deferred":
        return "tool-calls";
      default:
        // Deliberately NOT converted to a `never`-typed exhaustiveness guard
        // like the ToolResultOutput/reasoning switches above: `sdkStopReason`
        // is raw `string | null` off the CLI's untyped result message, not a
        // closed AI-SDK union — new real-world stop-reason strings are
        // expected here, not a sign of a stale union migration. V4 has an
        // "other" slot for exactly this (V2 forced it to "stop").
        return "other";
    }
  })();
  return { unified, raw };
}

// ---------------------------------------------------------------------------
// Provider factory
// ---------------------------------------------------------------------------

/**
 * Create a `LanguageModelV4` backed by the Claude Agent SDK.
 *
 * Runs in isolated config mode by default — the provider acts as a plain
 * model and does NOT inherit the host's ~/.claude connectors/plugins/skills.
 * Isolated mode requires a resolvable OAuth token (the `oauthToken` option,
 * the `CLAUDE_CODE_OAUTH_TOKEN` env var, or the macOS Keychain) and fails
 * closed at construction when none is available. Pass `config: { mode: "host" }`
 * to opt into the host config instead. Dispose the model when done to remove
 * the isolated tmpdir and tear down any live `deferred`-strategy sessions.
 *
 * @example
 * ```ts
 * import { claudeCode } from "@pattern-stack/agentic-runtime/providers";
 * import { AgentRunner } from "@pattern-stack/agentic-runtime";
 *
 * const model = claudeCode("sonnet");
 * try {
 *   const runner = new AgentRunner(model);
 *   const result = await runner.run(agent, "What is 17 + 28?");
 * } finally {
 *   model.dispose();
 * }
 * ```
 */
export function claudeCode(
  modelId: string,
  opts?: ClaudeCodeProviderOptions,
): ClaudeCodeLanguageModel {
  return new ClaudeCodeLanguageModel(modelId, opts);
}

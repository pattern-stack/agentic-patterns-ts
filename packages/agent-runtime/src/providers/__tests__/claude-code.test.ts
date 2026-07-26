/**
 * Tests for the Claude Code LanguageModelV4 provider.
 *
 * Unit tests mock `@anthropic-ai/claude-agent-sdk` so they run offline.
 * The integration test is skipped unless the `claude` CLI is installed
 * and `RUN_LIVE_CLAUDE=1` is set in the environment.
 */

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { ToolSchema } from "@agentic-patterns/core";
import type {
  LanguageModelV4CallOptions,
  LanguageModelV4Content,
  LanguageModelV4Prompt,
} from "@ai-sdk/provider";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Mock the SDK — must be hoisted before the provider module is imported.
// ---------------------------------------------------------------------------

// Scripted SDK behavior, reset per-test.
type Scripted = {
  toolCalls: Array<{ toolName: string; input: Record<string, unknown> }>;
  assistantText: string[];
  inputTokens: number;
  outputTokens: number;
  stopReason: string | null;
  sessionId?: string;
  /** Optional cache token fields (BetaUsage-shaped) for the cache-mapping test. */
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
};

const script: { current: Scripted } = {
  current: {
    toolCalls: [],
    assistantText: [],
    inputTokens: 0,
    outputTokens: 0,
    stopReason: "end_turn",
    sessionId: "sess-1",
  },
};

// Records the SDK `options` object of the most recent query() call so tests
// can assert what the provider assembled (e.g. isolated-mode env injection).
const captured: { options: Record<string, unknown> | null } = { options: null };

vi.mock("@anthropic-ai/claude-agent-sdk", () => {
  return {
    createSdkMcpServer: (opts: { name: string; tools: unknown[] }) => ({
      type: "sdk",
      name: opts.name,
      instance: { tools: opts.tools },
    }),
    tool: (
      name: string,
      description: string,
      _schema: unknown,
      handler: (args: Record<string, unknown>) => Promise<unknown>,
    ) => ({ name, description, handler }),
    query: ({ options }: { prompt: string; options: Record<string, unknown> }) => {
      captured.options = options;
      // Fire the PreToolUse defer hook for fidelity — the provider extracts
      // tool calls via `deferred_tool_use`, not `canUseTool` (deleted).
      type Hook = (
        input: Record<string, unknown>,
        toolUseId: string,
        ctx: { signal: AbortSignal },
      ) => Promise<unknown>;
      const preToolUse = (options.hooks as { PreToolUse?: Array<{ hooks?: Hook[] }> } | undefined)
        ?.PreToolUse;
      const hook = preToolUse?.[0]?.hooks?.[0];

      async function* gen() {
        const pending = script.current;
        yield { type: "system", subtype: "init", session_id: pending.sessionId ?? "sess-1" };

        if (pending.assistantText.length > 0) {
          yield {
            type: "assistant",
            message: { content: pending.assistantText.map((text) => ({ text })) },
          };
        }

        // Solo-only: at most one deferred call per run (matches the CLI).
        const first = pending.toolCalls[0];
        let deferred: { id: string; name: string; input: Record<string, unknown> } | undefined;
        if (first) {
          const sdkName = `mcp__agent_runner_tools__${first.toolName}`;
          if (hook) {
            await hook(
              {
                hook_event_name: "PreToolUse",
                tool_name: sdkName,
                tool_input: first.input,
                tool_use_id: "tc-0",
              },
              "tc-0",
              { signal: new AbortController().signal },
            );
          }
          deferred = { id: "tc-0", name: sdkName, input: first.input };
        }

        yield {
          type: "result",
          subtype: "success",
          is_error: false,
          usage: {
            input_tokens: pending.inputTokens,
            output_tokens: pending.outputTokens,
            ...(pending.cacheCreationInputTokens !== undefined
              ? { cache_creation_input_tokens: pending.cacheCreationInputTokens }
              : {}),
            ...(pending.cacheReadInputTokens !== undefined
              ? { cache_read_input_tokens: pending.cacheReadInputTokens }
              : {}),
          },
          stop_reason: first ? "tool_deferred" : pending.stopReason,
          terminal_reason: first ? "tool_deferred" : "completed",
          session_id: pending.sessionId ?? "sess-1",
          deferred_tool_use: deferred,
        };
      }

      return gen();
    },
  };
});

// Import provider after the mock is declared.
import { claudeCode } from "../claude-code.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCallOptions(
  prompt: LanguageModelV4Prompt,
  tools: Array<{ name: string; description?: string }> = [],
  overlay: Partial<LanguageModelV4CallOptions> = {},
): LanguageModelV4CallOptions {
  return {
    // v5 lifts tools to a top-level array; the schema field is `inputSchema`.
    tools: tools.map((t) => ({
      type: "function" as const,
      name: t.name,
      description: t.description ?? "",
      inputSchema: { type: "object", properties: {}, additionalProperties: true } as const,
    })),
    prompt,
    ...overlay,
  };
}

/** Extract the joined text from a v5 doGenerate `content` array. */
function contentText(content: LanguageModelV4Content[]): string {
  return content
    .filter((c): c is Extract<LanguageModelV4Content, { type: "text" }> => c.type === "text")
    .map((c) => c.text)
    .join("");
}

/** Extract the tool-call parts from a v5 doGenerate `content` array. */
function contentToolCalls(
  content: LanguageModelV4Content[],
): Array<Extract<LanguageModelV4Content, { type: "tool-call" }>> {
  return content.filter(
    (c): c is Extract<LanguageModelV4Content, { type: "tool-call" }> => c.type === "tool-call",
  );
}

const TOKEN = "test-oauth-token-1234567890";

// Isolated providers create a tmpdir at construction; track + dispose them so
// the suite doesn't leak.
const disposables: Array<{ dispose: () => void }> = [];
function track<T extends { dispose: () => void }>(m: T): T {
  disposables.push(m);
  return m;
}

/**
 * Default test model — host config mode so the generation-behavior tests
 * neither require a token nor create isolated tmpdirs. Isolation + fail-closed
 * are covered by the dedicated tests below and in cc-fail-closed.test.ts.
 */
function makeModel(modelId = "sonnet") {
  // `flatten` keeps these generation-behavior tests off the subprocess-
  // spawning defer path; the defer path has its own suite
  // (cc-session-strategy.test.ts).
  return claudeCode(modelId, { config: { mode: "host" }, sessionStrategy: "flatten" });
}

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

describe("claudeCode provider", () => {
  beforeEach(() => {
    script.current = {
      toolCalls: [],
      assistantText: [],
      inputTokens: 0,
      outputTokens: 0,
      stopReason: "end_turn",
      sessionId: "sess-1",
    };
    captured.options = null;
  });

  afterEach(() => {
    for (const d of disposables) d.dispose();
    disposables.length = 0;
    vi.clearAllMocks();
  });

  it("factory returns a LanguageModelV4-shaped object", () => {
    const model = makeModel();
    expect(model.specificationVersion).toBe("v4");
    expect(model.provider).toBe("claude-code");
    expect(model.modelId).toBe("sonnet");
    expect(typeof model.doGenerate).toBe("function");
    expect(typeof model.doStream).toBe("function");
  });

  it("doGenerate returns text and usage for a simple prompt", async () => {
    script.current = {
      toolCalls: [],
      assistantText: ["The answer is 45."],
      inputTokens: 12,
      outputTokens: 7,
      stopReason: "end_turn",
    };

    const model = makeModel();
    const result = await model.doGenerate(
      makeCallOptions([
        { role: "system", content: "You are a math assistant." },
        { role: "user", content: [{ type: "text", text: "What is 17 + 28?" }] },
      ]),
    );

    expect(contentText(result.content)).toBe("The answer is 45.");
    expect(contentToolCalls(result.content)).toHaveLength(0);
    expect(result.finishReason).toEqual({ unified: "stop", raw: "end_turn" });
    expect(result.usage).toEqual({
      inputTokens: { total: 12, noCache: 12, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 7, text: undefined, reasoning: undefined },
      raw: { input_tokens: 12, output_tokens: 7 },
    });
  });

  it("doGenerate surfaces cache read/write token numbers (anthropic-parity formula)", async () => {
    script.current = {
      toolCalls: [],
      assistantText: ["cached"],
      inputTokens: 12,
      outputTokens: 7,
      stopReason: "end_turn",
      cacheCreationInputTokens: 100,
      cacheReadInputTokens: 50,
    };

    const model = makeModel();
    const result = await model.doGenerate(
      makeCallOptions([{ role: "user", content: [{ type: "text", text: "hi" }] }]),
    );

    expect(result.usage).toEqual({
      inputTokens: { total: 12 + 100 + 50, noCache: 12, cacheRead: 50, cacheWrite: 100 },
      outputTokens: { total: 7, text: undefined, reasoning: undefined },
      raw: {
        input_tokens: 12,
        output_tokens: 7,
        cache_creation_input_tokens: 100,
        cache_read_input_tokens: 50,
      },
    });
  });

  it("doGenerate surfaces tool calls captured by canUseTool", async () => {
    script.current = {
      toolCalls: [{ toolName: "add", input: { a: 17, b: 28 } }],
      assistantText: [],
      inputTokens: 20,
      outputTokens: 5,
      stopReason: "tool_use",
    };

    const model = makeModel();
    const result = await model.doGenerate(
      makeCallOptions(
        [
          { role: "system", content: "You are a math assistant." },
          { role: "user", content: [{ type: "text", text: "Add 17 and 28." }] },
        ],
        [{ name: "add", description: "Add two numbers" }],
      ),
    );

    const toolCalls = contentToolCalls(result.content);
    expect(toolCalls).toHaveLength(1);
    const tc = toolCalls[0];
    expect(tc?.toolName).toBe("add");
    expect(JSON.parse(tc?.input ?? "{}")).toEqual({ a: 17, b: 28 });
    expect(result.finishReason).toEqual({ unified: "tool-calls", raw: "tool_deferred" });
  });

  it("doStream emits text-delta, tool-call, and finish parts", async () => {
    script.current = {
      toolCalls: [{ toolName: "multiply", input: { a: 6, b: 7 } }],
      assistantText: ["Thinking…"],
      inputTokens: 11,
      outputTokens: 3,
      stopReason: "tool_use",
    };

    const model = makeModel();
    const { stream } = await model.doStream(
      makeCallOptions(
        [
          { role: "system", content: "You are a math assistant." },
          { role: "user", content: [{ type: "text", text: "Multiply." }] },
        ],
        [{ name: "multiply", description: "Multiply" }],
      ),
    );

    const parts: unknown[] = [];
    const reader = stream.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
    }

    const types = parts.map((p) => (p as { type: string }).type);
    expect(types).toContain("text-delta");
    expect(types).toContain("tool-call");
    expect(types[types.length - 1]).toBe("finish");
  });

  it("renders conversation history with prior tool calls/results", async () => {
    script.current = {
      toolCalls: [],
      assistantText: ["45"],
      inputTokens: 30,
      outputTokens: 2,
      stopReason: "end_turn",
    };

    const model = makeModel();
    const result = await model.doGenerate(
      makeCallOptions([
        { role: "system", content: "Math bot." },
        { role: "user", content: [{ type: "text", text: "17 + 28?" }] },
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "t1",
              toolName: "add",
              input: { a: 17, b: 28 },
            },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "t1",
              toolName: "add",
              output: { type: "json", value: { result: 45 } },
            },
          ],
        },
      ]),
    );

    expect(contentText(result.content)).toBe("45");
    expect(result.finishReason).toEqual({ unified: "stop", raw: "end_turn" });
  });

  // -------------------------------------------------------------------------
  // Isolated config mode (Axis B) — env injection + host opt-out
  // -------------------------------------------------------------------------

  it("isolated mode (default) injects CLAUDE_CONFIG_DIR + OAuth token into SDK options.env", async () => {
    script.current = {
      toolCalls: [],
      assistantText: ["ok"],
      inputTokens: 1,
      outputTokens: 1,
      stopReason: "end_turn",
    };

    // Explicit token → deterministic across platforms (no Keychain probe).
    const model = track(claudeCode("sonnet", { oauthToken: TOKEN }));
    await model.doGenerate(
      makeCallOptions([{ role: "user", content: [{ type: "text", text: "hi" }] }]),
    );

    const env = (captured.options?.env ?? {}) as Record<string, string>;
    expect(env.CLAUDE_CONFIG_DIR).toContain("ap-cc-cfg-");
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe(TOKEN);
  });

  it("host mode (explicit opt-out) injects no isolated env", async () => {
    script.current = {
      toolCalls: [],
      assistantText: ["ok"],
      inputTokens: 1,
      outputTokens: 1,
      stopReason: "end_turn",
    };

    const model = makeModel(); // { config: { mode: "host" } }
    await model.doGenerate(
      makeCallOptions([{ role: "user", content: [{ type: "text", text: "hi" }] }]),
    );

    const env = captured.options?.env as Record<string, string> | undefined;
    expect(env?.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(env?.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });

  it("dispose() removes the isolated config dir and is idempotent", () => {
    const model = claudeCode("sonnet", { oauthToken: TOKEN });
    model.dispose();
    expect(() => model.dispose()).not.toThrow();
  });

  // -------------------------------------------------------------------------
  // Reasoning CallOption mapping (V4 `reasoning` → harness effort/thinking)
  // -------------------------------------------------------------------------

  it("maps reasoning: 'high' to captured SDK options.effort", async () => {
    const model = makeModel();
    await model.doGenerate(
      makeCallOptions(
        [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        [],
        { reasoning: "high" },
      ),
    );
    expect(captured.options?.effort).toBe("high");
  });

  it("maps reasoning: 'none' to captured SDK options.thinking = { type: 'disabled' }", async () => {
    const model = makeModel();
    await model.doGenerate(
      makeCallOptions(
        [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        [],
        { reasoning: "none" },
      ),
    );
    expect(captured.options?.thinking).toEqual({ type: "disabled" });
  });

  it("maps reasoning: 'minimal' to effort 'low' with a compatibility warning", async () => {
    const model = makeModel();
    const result = await model.doGenerate(
      makeCallOptions(
        [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        [],
        { reasoning: "minimal" },
      ),
    );
    expect(captured.options?.effort).toBe("low");
    expect(result.warnings).toEqual([
      {
        type: "compatibility",
        feature: "reasoning",
        details:
          "'minimal' is not supported by the Claude Code harness; mapped to effort 'low'",
      },
    ]);
  });

  it("leaves SDK options untouched for reasoning: 'provider-default' / unset", async () => {
    const model = makeModel();
    await model.doGenerate(
      makeCallOptions([{ role: "user", content: [{ type: "text", text: "hi" }] }]),
    );
    expect(captured.options?.effort).toBeUndefined();
    expect(captured.options?.thinking).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Integration test — only runs when claude CLI is available and the user
// opts in by setting RUN_LIVE_CLAUDE=1.
// ---------------------------------------------------------------------------

function hasClaudeCli(): boolean {
  try {
    execSync("command -v claude", { stdio: "ignore" });
    return true;
  } catch {
    return (
      existsSync(`${process.env.HOME ?? ""}/.claude/local/claude`) ||
      existsSync("/usr/local/bin/claude")
    );
  }
}

const runLive = process.env.RUN_LIVE_CLAUDE === "1" && !process.env.CI && hasClaudeCli();
const runOllama = Boolean(process.env.OLLAMA_HOST) && !process.env.CI;

// ---------------------------------------------------------------------------
// Shared math-agent harness for live integration tests
// ---------------------------------------------------------------------------

async function buildMathHarness() {
  const { AgentBuilder, Capability, Persona, RoleBuilder, Toolbox } = await import(
    "@agentic-patterns/core"
  );
  const { AgentEventBus, AgentRunner } = await import("../../index.js");

  class MathToolbox extends Toolbox {
    readonly name = "math_operations";
    readonly description = "Basic math";
    readonly tools = {
      add: {
        description: "Add two numbers",
        parameters: z.object({ a: z.number(), b: z.number() }),
        execute: async (args: Record<string, unknown>) => {
          const { a, b } = args as { a: number; b: number };
          return { result: a + b };
        },
      },
    };
  }

  const role = new RoleBuilder("math-assistant")
    .withPersona(
      new Persona({
        identity: "A precise math assistant",
        tone: "concise",
        priorities: ["accuracy"],
        principles: ["always use the provided tools for calculations"],
      }),
    )
    .withCapability(new Capability("math_operations", "Math", new MathToolbox()))
    .withDefaultModel("sonnet")
    .build();

  const { Mission } = await import("@agentic-patterns/core");
  const agent = new AgentBuilder(role)
    .withMission(
      new Mission({
        objective: "Help with math using the provided tools",
        successCriteria: ["Correct answers"],
      }),
    )
    .build();

  const bus = new AgentEventBus();
  const events: string[] = [];
  for (const type of [
    "agent.message.start",
    "agent.iteration.start",
    "agent.llm.start",
    "agent.llm.end",
    "agent.tool.intent",
    "agent.tool.start",
    "agent.tool.end",
    "agent.iteration.end",
    "agent.message.complete",
  ]) {
    bus.subscribe(type, (e) => events.push(e.type));
  }

  const toolboxExecutor = {
    execute: async (name: string, args: Record<string, unknown>) => {
      if (name === "add") {
        const { a, b } = args as { a: number; b: number };
        return { result: a + b };
      }
      throw new Error(`Unknown tool: ${name}`);
    },
  };

  return { agent, bus, events, toolboxExecutor, AgentRunner };
}

// ---------------------------------------------------------------------------
// Live integration: Claude Code provider (claude CLI required)
// ---------------------------------------------------------------------------

describe.skipIf(!runLive)("claudeCode provider — live integration", () => {
  it("runs math agent end-to-end through AgentRunner with full event vocabulary", async () => {
    vi.doUnmock("@anthropic-ai/claude-agent-sdk");
    const { agent, bus, events, toolboxExecutor, AgentRunner } = await buildMathHarness();

    const runner = new AgentRunner((await import("../claude-code.js")).claudeCode("sonnet"), bus);

    const result = await runner.run(agent, "What is 17 + 28? Use the add tool.", {
      toolExecutor: toolboxExecutor,
      maxIterations: 4,
    });

    expect(result.response).toMatch(/45/);
    expect(result.toolCallsCount).toBeGreaterThanOrEqual(1);

    expect(events).toContain("agent.iteration.start");
    expect(events).toContain("agent.llm.start");
    expect(events).toContain("agent.tool.start");
    expect(events).toContain("agent.tool.end");
    expect(events).toContain("agent.iteration.end");
    expect(events).toContain("agent.llm.end");
    void ToolSchema;
  }, 120_000);
});

// ---------------------------------------------------------------------------
// Live integration: Ollama local provider (OLLAMA_HOST required)
//
// Run with: OLLAMA_HOST=http://10.88.111.52:11434 pnpm --filter @agentic-patterns/runtime test
// ---------------------------------------------------------------------------

describe.skipIf(!runOllama)("ollama provider — live integration", () => {
  it("runs math agent end-to-end via Ollama with AgentRunner events", async () => {
    const { agent, bus, events, toolboxExecutor, AgentRunner } = await buildMathHarness();

    // Use the ollamaProvider adapter — tier defaults to sonnet (qwen3:14b).
    const { ollamaProvider, resolveModelId } = await import("../index.js");
    const modelId = resolveModelId(ollamaProvider, process.env.OLLAMA_MODEL, "sonnet");
    const model = await ollamaProvider.load(modelId);

    const runner = new AgentRunner(model, bus);

    const result = await runner.run(agent, "What is 17 + 28? Use the add tool.", {
      toolExecutor: toolboxExecutor,
      maxIterations: 6,
    });

    console.log(`\n[ollama live] model=${modelId} response="${result.response.slice(0, 100)}"`);
    console.log(`[ollama live] tokens: ${result.inputTokens} in / ${result.outputTokens} out`);
    console.log(`[ollama live] tool calls: ${result.toolCallsCount}, events: ${events.join(", ")}`);

    // Looser assertion than Claude — OSS models may format differently.
    expect(result.response).toBeTruthy();
    expect(result.finishReason).toBeTruthy();

    // Core event vocabulary must still fire through AgentRunner.
    expect(events).toContain("agent.message.start");
    expect(events).toContain("agent.message.complete");

    // If the model used the add tool, we should see tool events.
    if (result.toolCallsCount > 0) {
      expect(events).toContain("agent.tool.start");
      expect(events).toContain("agent.tool.end");
    }
  }, 120_000);
});

/**
 * `ClaudeCodeAdapter` structured-output plumbing (#547).
 *
 * `query` is mocked so `start()` never spawns a real subprocess — the SDK
 * message stream is an empty async iterable with no-op `interrupt`/`return`.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(() => {
    const iterable = {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            return { done: true, value: undefined };
          },
        };
      },
      async interrupt() {},
      async return() {},
    };
    return iterable;
  }),
}));

import { query } from "@anthropic-ai/claude-agent-sdk";

import type { AgentLikeForBridge } from "../../sdk-bridge.js";
import { ClaudeCodeAdapter } from "../claude-code/claude-code-adapter.js";
import type { HarnessRunRequest } from "../types.js";

afterEach(() => {
  vi.clearAllMocks();
});

function makeAgent(): AgentLikeForBridge {
  return {
    role: { name: "test-agent", capabilities: [] },
    getModel: () => "claude-sonnet-4-6",
    getTools: () => [],
    renderInitialPrompt: () => "system",
  };
}

describe("ClaudeCodeAdapter — structured output (#547)", () => {
  it("probe() reports features.structuredOutput === true", async () => {
    const buildOptions = vi.fn(() => ({}) as never);
    const adapter = new ClaudeCodeAdapter({ buildOptions: buildOptions as never });
    const probe = await adapter.probe({});
    expect(probe.features.structuredOutput).toBe(true);
  });

  it("start() forwards req.structured.jsonSchema as outputSchema to buildOptions", async () => {
    const buildOptions = vi.fn((_agent, _options, _ctx) => ({}) as never);
    const adapter = new ClaudeCodeAdapter({ buildOptions: buildOptions as never });

    const jsonSchema = { type: "object", properties: { a: { type: "number" } } };
    const req: HarnessRunRequest<AgentLikeForBridge> = {
      agent: makeAgent(),
      message: "hi",
      options: undefined,
      runId: "r",
      traceId: "t",
      correlationId: "c",
      streaming: false,
      evaluateIntent: async () => ({ allowed: true }) as never,
      structured: { jsonSchema },
    };

    await adapter.start(req);

    expect(buildOptions).toHaveBeenCalledTimes(1);
    const ctxArg = buildOptions.mock.calls[0]?.[2] as { outputSchema?: unknown };
    expect(ctxArg.outputSchema).toEqual(jsonSchema);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("start() without req.structured leaves outputSchema undefined", async () => {
    const buildOptions = vi.fn((_agent, _options, _ctx) => ({}) as never);
    const adapter = new ClaudeCodeAdapter({ buildOptions: buildOptions as never });

    const req: HarnessRunRequest<AgentLikeForBridge> = {
      agent: makeAgent(),
      message: "hi",
      options: undefined,
      runId: "r",
      traceId: "t",
      correlationId: "c",
      streaming: false,
      evaluateIntent: async () => ({ allowed: true }) as never,
    };

    await adapter.start(req);

    const ctxArg = buildOptions.mock.calls[0]?.[2] as { outputSchema?: unknown };
    expect(ctxArg.outputSchema).toBeUndefined();
  });
});

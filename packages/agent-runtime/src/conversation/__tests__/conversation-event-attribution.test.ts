/**
 * Verifies that agent.message.complete events emitted via
 * `Conversation.stream()` -> `AgentRunner.stream()` carry the runtime
 * model id (from the bound LanguageModelV2) rather than the agent's
 * declared model. Discovered while smoke-testing AP-13: footers showed
 * the agent's default ("claude-sonnet-4-20250514") even though Ollama
 * was actually servicing the call.
 */

import type { LanguageModelV2StreamPart } from "@ai-sdk/provider";
import { MockLanguageModelV2 } from "ai/test";
import { describe, expect, it } from "vitest";

import type { AgentEvent } from "../../events/types.js";
import { AgentRunner } from "../../runner/agent-runner.js";
import type { AgentLike } from "../../runner/types.js";
import { Conversation } from "../conversation.js";

const RUNTIME_MODEL_ID = "qwen3:14b";
const AGENT_DECLARED_MODEL = "claude-sonnet-4-20250514";

function makeAgent(): AgentLike {
  return {
    role: { name: "test-agent" },
    getModel: () => AGENT_DECLARED_MODEL,
    getTools: () => [],
    getSystemPrompt: () => "system",
    renderInitialPrompt: () => "system",
  };
}

function makeMockModel(): MockLanguageModelV2 {
  return new MockLanguageModelV2({
    modelId: RUNTIME_MODEL_ID,
    doStream: async () => ({
      stream: new ReadableStream<LanguageModelV2StreamPart>({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          controller.enqueue({ type: "text-start", id: "t0" });
          controller.enqueue({ type: "text-delta", id: "t0", delta: "OK" });
          controller.enqueue({ type: "text-end", id: "t0" });
          controller.enqueue({
            type: "finish",
            finishReason: "stop",
            usage: { inputTokens: 5, outputTokens: 1, totalTokens: 6 },
          });
          controller.close();
        },
      }),
    }),
  });
}

async function collect(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

describe("Conversation event attribution", () => {
  it("agent.message.complete reports the runtime model id, not the agent's declared model", async () => {
    const runner = new AgentRunner(makeMockModel());
    const conversation = new Conversation(makeAgent(), runner);

    const events = await collect(conversation.stream("hi"));
    const complete = events.find((e) => e.type === "agent.message.complete");

    expect(complete).toBeDefined();
    // biome-ignore lint/suspicious/noExplicitAny: union narrowing in test
    const model = (complete as any).model;
    expect(model).toBe(RUNTIME_MODEL_ID);
    expect(model).not.toBe(AGENT_DECLARED_MODEL);
  });
});

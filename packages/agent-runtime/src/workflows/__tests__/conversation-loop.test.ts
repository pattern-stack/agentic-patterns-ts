import { describe, expect, it } from "vitest";
import { MemoryStore } from "../../conversation/store.js";
import type { AgentLike } from "../../runner/agent-runner.js";
import { MockRunner } from "../../runner/mock-runner.js";
import { ConversationLoop } from "../conversation-loop.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeAgent(name = "chat-agent"): AgentLike {
  return {
    role: { name },
    getModel: () => "mock-model",
    getTools: () => [],
    getSystemPrompt: () => "You are a chat agent.",
    renderInitialPrompt: () => "Initial prompt",
  };
}

/** Creates an inputFn from a list of messages. Returns null after all consumed. */
function inputsFrom(messages: string[]): () => string | null {
  let i = 0;
  return () => {
    if (i >= messages.length) return null;
    return messages[i++] ?? null;
  };
}

// ---------------------------------------------------------------------------
// ConversationLoop
// ---------------------------------------------------------------------------

describe("ConversationLoop", () => {
  it("runs a 3-exchange conversation", async () => {
    const runner = new MockRunner().addResponse("*", {
      content: "response",
      inputTokens: 3,
      outputTokens: 5,
    });

    const loop = new ConversationLoop(makeAgent(), { maxExchanges: 10 });
    const result = await loop.run({
      runner,
      inputFn: inputsFrom(["hello", "how are you", "thanks"]),
    });

    expect(result.exitReason).toBe("input_closed");
    expect(result.exchangeCount).toBe(3);
    expect(result.totalInputTokens).toBe(9);
    expect(result.totalOutputTokens).toBe(15);
    expect(result.finalContent).toBe("response");
    expect(result.succeeded).toBe(true);
  });

  it("terminates on exit phrase", async () => {
    const runner = new MockRunner().addResponse("*", { content: "ok" });

    const loop = new ConversationLoop(makeAgent(), { maxExchanges: 10 });
    const result = await loop.run({
      runner,
      inputFn: inputsFrom(["hello", "quit"]),
    });

    expect(result.exitReason).toBe("exit_phrase");
    expect(result.exchangeCount).toBe(1);
  });

  it("terminates on custom exit phrase (case-insensitive)", async () => {
    const runner = new MockRunner().addResponse("*", { content: "ok" });

    const loop = new ConversationLoop(makeAgent(), {
      maxExchanges: 10,
      exitPhrases: ["DONE"],
    });
    const result = await loop.run({
      runner,
      inputFn: inputsFrom(["hello", "done"]),
    });

    expect(result.exitReason).toBe("exit_phrase");
    expect(result.exchangeCount).toBe(1);
  });

  it("terminates on max exchanges", async () => {
    const runner = new MockRunner().addResponse("*", { content: "ok" });
    let callCount = 0;

    const loop = new ConversationLoop(makeAgent(), { maxExchanges: 2 });
    const result = await loop.run({
      runner,
      inputFn: () => {
        callCount++;
        return `message-${callCount}`;
      },
    });

    expect(result.exitReason).toBe("max_exchanges");
    expect(result.exchangeCount).toBe(2);
  });

  it("terminates on null input (input closed)", async () => {
    const runner = new MockRunner().addResponse("*", { content: "ok" });

    const loop = new ConversationLoop(makeAgent(), { maxExchanges: 10 });
    const result = await loop.run({
      runner,
      inputFn: inputsFrom(["hello"]),
    });

    // "hello" processes, then null → input_closed
    expect(result.exitReason).toBe("input_closed");
    expect(result.exchangeCount).toBe(1);
  });

  it("calls outputFn with each response", async () => {
    const runner = new MockRunner().addResponse("*", { content: "reply" });
    const outputs: string[] = [];

    const loop = new ConversationLoop(makeAgent(), { maxExchanges: 10 });
    await loop.run({
      runner,
      inputFn: inputsFrom(["a", "b"]),
      outputFn: (r) => {
        outputs.push(r);
      },
    });

    expect(outputs).toEqual(["reply", "reply"]);
  });

  it("integrates with MemoryStore", async () => {
    const runner = new MockRunner().addResponse("*", {
      content: "stored-response",
      inputTokens: 1,
      outputTokens: 2,
    });
    const store = new MemoryStore();

    const loop = new ConversationLoop(makeAgent(), {
      maxExchanges: 10,
      store,
    });
    const result = await loop.run({
      runner,
      inputFn: inputsFrom(["hello"]),
    });

    // Verify conversation was persisted
    expect(result.exchangeCount).toBe(1);
    // The conversation object has the exchange recorded
    expect(result.conversation.history).toHaveLength(1);
    expect(result.conversation.history[0]?.assistant).toBe("stored-response");
  });

  it("fires hook callbacks", async () => {
    const runner = new MockRunner().addResponse("*", { content: "ok" });
    const events: string[] = [];

    const hooks = {
      onPatternStart: () => {
        events.push("start");
      },
      onIterationStart: () => {
        events.push("iter-start");
      },
      onIterationComplete: () => {
        events.push("iter-complete");
      },
      onPatternComplete: () => {
        events.push("complete");
      },
    };

    const loop = new ConversationLoop(makeAgent(), { maxExchanges: 10 });
    await loop.run({
      runner,
      inputFn: inputsFrom(["hello"]),
      hooks,
    });

    // input_closed happens on second inputFn call, no iter-start/complete for that
    expect(events).toEqual(["start", "iter-start", "iter-complete", "iter-start", "complete"]);
  });

  it("returns frozen result", async () => {
    const runner = new MockRunner().addResponse("*", { content: "ok" });
    const loop = new ConversationLoop(makeAgent());
    const result = await loop.run({
      runner,
      inputFn: inputsFrom([]),
    });
    expect(Object.isFrozen(result)).toBe(true);
  });
});

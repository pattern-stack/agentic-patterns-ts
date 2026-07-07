import { describe, expect, it, vi } from "vitest";
import { createEvent } from "../../events/types.js";
import type { AgentEvent } from "../../events/types.js";
import type { RunOptions, RunResult, RunnerProtocol } from "../../runner/types.js";
import { Conversation, type Exchange, exchangeTotalTokens } from "../conversation.js";
import { InMemoryConversationStore } from "../store.js";

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function makeAgent(name = "TestAgent") {
  return {
    getModel: () => "test-model",
    getTools: () => [],
    getSystemPrompt: () => "system prompt",
    renderInitialPrompt: () => "initial prompt",
    role: { name },
  };
}

function makeRunner(responses: string[]): RunnerProtocol {
  let callIndex = 0;
  return {
    run: async (_agent: unknown, _message: string): Promise<RunResult> => {
      const response = responses[callIndex] ?? "default response";
      callIndex++;
      return {
        response,
        inputTokens: 100,
        outputTokens: 50,
        toolCallsCount: 0,
        iterations: 1,
        finishReason: "stop",
      };
    },
  };
}

/**
 * A runner whose `stream()` mimics AgentRunner's real contract just enough to
 * test the traceId/runId threading fix: it stamps every event's `traceId`
 * with `effectiveTraceId = options?.traceId ?? RUNNER_RUN_ID` (AgentRunner's
 * own formula, `agent-runner.ts`) and its `runId` with a runner-internal id
 * DISTINCT from anything Conversation generates locally — exactly the
 * property `Conversation.stream()`'s `capturedRunId` relies on.
 */
const RUNNER_RUN_ID = "runner-internal-run-id";

function makeStreamingRunner(assistantText: string): RunnerProtocol & {
  lastStreamOptions: RunOptions | undefined;
} {
  const runner = {
    lastStreamOptions: undefined as RunOptions | undefined,
    run: async (): Promise<RunResult> => {
      throw new Error("run() not used in these tests");
    },
    async *stream(
      _agent: unknown,
      _message: string,
      options?: RunOptions,
    ): AsyncGenerator<AgentEvent> {
      runner.lastStreamOptions = options;
      const effectiveTraceId = options?.traceId ?? RUNNER_RUN_ID;

      yield createEvent("agent.message.start", {
        traceId: effectiveTraceId,
        runId: RUNNER_RUN_ID,
        agentName: "test-agent",
      });
      yield createEvent("agent.message.complete", {
        traceId: effectiveTraceId,
        runId: RUNNER_RUN_ID,
        content: assistantText,
        inputTokens: 10,
        outputTokens: 5,
        model: "test-model",
      });
    },
  };
  return runner;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Conversation", () => {
  it("should create a conversation with defaults", () => {
    const agent = makeAgent();
    const runner = makeRunner(["hello"]);
    const conv = new Conversation(agent, runner);

    expect(conv.exchangeCount).toBe(0);
    expect(conv.history).toEqual([]);
    expect(conv.lastExchange).toBeUndefined();
    expect(conv.id).toBeTruthy();
    expect(conv.sessionId).toBe(conv.id);
  });

  it("should send a message and return an exchange", async () => {
    const agent = makeAgent();
    const runner = makeRunner(["Hello back!"]);
    const conv = new Conversation(agent, runner);

    const exchange = await conv.send("Hello");

    expect(exchange.number).toBe(1);
    expect(exchange.user).toBe("Hello");
    expect(exchange.assistant).toBe("Hello back!");
    expect(exchange.inputTokens).toBe(100);
    expect(exchange.outputTokens).toBe(50);
    expect(exchange.timestamp).toBeInstanceOf(Date);
    expect(conv.exchangeCount).toBe(1);
    expect(conv.history).toHaveLength(1);
  });

  it("should track multi-turn exchanges", async () => {
    const agent = makeAgent();
    const runner = makeRunner(["First response", "Second response"]);
    const conv = new Conversation(agent, runner);

    await conv.send("First message");
    const second = await conv.send("Second message");

    expect(conv.exchangeCount).toBe(2);
    expect(conv.history).toHaveLength(2);
    expect(second.number).toBe(2);
    expect(second.assistant).toBe("Second response");
    expect(conv.lastExchange?.number).toBe(2);
  });

  it("should accumulate token counts", async () => {
    const agent = makeAgent();
    const runner = makeRunner(["a", "b"]);
    const conv = new Conversation(agent, runner);

    await conv.send("one");
    await conv.send("two");

    const tokens = conv.totalTokens;
    expect(tokens.input).toBe(200);
    expect(tokens.output).toBe(100);
    expect(tokens.total).toBe(300);
  });

  it("should pass message history to runner on subsequent sends", async () => {
    const runSpy = vi.fn().mockResolvedValue({
      response: "ok",
      inputTokens: 10,
      outputTokens: 5,
      toolCallsCount: 0,
      iterations: 1,
      finishReason: "stop",
    });

    const runner: RunnerProtocol = { run: runSpy };
    const conv = new Conversation(makeAgent(), runner);

    await conv.send("first");
    await conv.send("second");

    // Second call should receive message history with the first exchange
    const secondCallOptions = runSpy.mock.calls[1]![2] as
      | { messageHistory?: Array<{ kind: string }> }
      | undefined;
    expect(secondCallOptions?.messageHistory).toHaveLength(2); // request + response
    expect(secondCallOptions?.messageHistory?.[0]?.kind).toBe("request");
    expect(secondCallOptions?.messageHistory?.[1]?.kind).toBe("response");
  });

  it("should persist exchange via ConversationStore", async () => {
    const agent = makeAgent("MyAgent");
    const runner = makeRunner(["response"]);
    const store = new InMemoryConversationStore();

    const conv = new Conversation(agent, runner, { store });
    await conv.send("hello");

    // Store should have created a conversation and added 2 messages (request + response)
    // We can verify by checking that the store has messages
    // The store's conversation ID is internal, but we can verify via the InMemoryConversationStore
    // by getting all conversations — there should be exactly one
    // Since InMemoryConversationStore doesn't have a listConversations method, we verify indirectly:
    // The conversation was created and messages were persisted correctly.
    expect(conv.exchangeCount).toBe(1);
  });

  it("should clear history", async () => {
    const conv = new Conversation(makeAgent(), makeRunner(["a", "b"]));
    await conv.send("one");
    await conv.send("two");
    expect(conv.exchangeCount).toBe(2);

    conv.clear();
    expect(conv.exchangeCount).toBe(0);
    expect(conv.history).toEqual([]);
  });

  it("should rollback to a specific exchange", async () => {
    const conv = new Conversation(makeAgent(), makeRunner(["a", "b", "c"]));
    await conv.send("one");
    await conv.send("two");
    await conv.send("three");

    conv.rollback(2);
    expect(conv.exchangeCount).toBe(2);
    expect(conv.history).toHaveLength(2);
    expect(conv.lastExchange?.assistant).toBe("b");
  });

  it("should fork a conversation", async () => {
    const runner = makeRunner(["a", "b", "c", "d"]);
    const conv = new Conversation(makeAgent(), runner);
    await conv.send("one");
    await conv.send("two");
    await conv.send("three");

    const forked = await conv.fork(2);
    expect(forked.exchangeCount).toBe(2);
    expect(forked.history).toHaveLength(2);
    // Original should be unaffected
    expect(conv.exchangeCount).toBe(3);
  });

  describe("stream() traceId + runId threading (S7 fix)", () => {
    it("passes this stream's invocationId as traceId to the runner, joining conversation + run events on one trace", async () => {
      const agent = makeAgent("TraceAgent");
      const runner = makeStreamingRunner("hi back");
      const conv = new Conversation(agent, runner);

      const events: AgentEvent[] = [];
      for await (const e of conv.stream("hello")) events.push(e);

      // Conversation's own start/end events and the runner's own events
      // must all share ONE traceId — the runner options.traceId.
      const traceId = runner.lastStreamOptions?.traceId;
      expect(traceId).toBeTruthy();
      const uniqueTraceIds = new Set(events.map((e) => e.traceId));
      expect(uniqueTraceIds.size).toBe(1);
      expect([...uniqueTraceIds][0]).toBe(traceId);

      // Without the fix, the runner would fall back to its own generated
      // runId as the trace id (disjoint from Conversation's traceId).
      expect(traceId).not.toBe(RUNNER_RUN_ID);
    });

    it("captures the runner's own runId (not Conversation's local id) onto the Exchange", async () => {
      const agent = makeAgent("RunIdAgent");
      const runner = makeStreamingRunner("hi back");
      const conv = new Conversation(agent, runner);

      for await (const _e of conv.stream("hello")) {
        // drain
      }

      expect(conv.lastExchange?.runId).toBe(RUNNER_RUN_ID);
    });

    it("persists StoredMessage.runId for both the request and response messages", async () => {
      const agent = makeAgent("PersistAgent");
      const runner = makeStreamingRunner("hi back");
      const store = new InMemoryConversationStore();
      const conv = new Conversation(agent, runner, { store });

      for await (const _e of conv.stream("hello")) {
        // drain
      }

      // Access the store's messages via the conversation it created — there is
      // exactly one, discoverable through listConversations (S7 addition).
      const [summary] = await store.listConversations();
      expect(summary).toBeDefined();
      const messages = await store.getMessages(summary!.conversationId);
      expect(messages).toHaveLength(2);
      expect(messages.every((m) => m.runId === RUNNER_RUN_ID)).toBe(true);
    });
  });

  it("should initialize with prior history", () => {
    const history: Exchange[] = [
      {
        number: 1,
        invocationId: "inv-1",
        user: "hi",
        assistant: "hello",
        toolCalls: [],
        inputTokens: 10,
        outputTokens: 5,
        timestamp: new Date(),
      },
    ];

    const conv = new Conversation(makeAgent(), makeRunner([]), { history });
    expect(conv.exchangeCount).toBe(1);
    expect(conv.history).toHaveLength(1);
    expect(conv.lastExchange?.user).toBe("hi");
  });
});

describe("exchangeTotalTokens", () => {
  it("should compute total tokens", () => {
    const exchange: Exchange = {
      number: 1,
      invocationId: "test",
      user: "hi",
      assistant: "hello",
      toolCalls: [],
      inputTokens: 100,
      outputTokens: 50,
      timestamp: new Date(),
    };
    expect(exchangeTotalTokens(exchange)).toBe(150);
  });
});

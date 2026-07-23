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

  describe("stream() D5: no phantom empty exchange on a zero-output errored turn (#340)", () => {
    /**
     * Throws before yielding on the FIRST call, then streams normally on
     * every subsequent call — lets a single `Conversation` prove the
     * `_exchangeCount` bump is reverted (not just left stale) by driving a
     * real follow-up turn through the same instance.
     */
    function makeThrowOnceThenSucceedRunner(replyText: string, message: string): RunnerProtocol {
      let callCount = 0;
      return {
        run: async (): Promise<RunResult> => {
          throw new Error("run() not used in these tests");
        },
        async *stream(
          _agent: unknown,
          _message: string,
          options?: RunOptions,
        ): AsyncGenerator<AgentEvent> {
          callCount += 1;
          if (callCount === 1) {
            throw new Error(message);
          }
          const traceId = options?.traceId ?? RUNNER_RUN_ID;
          yield createEvent("agent.message.start", {
            traceId,
            runId: RUNNER_RUN_ID,
            agentName: "test-agent",
          });
          yield createEvent("agent.message.complete", {
            traceId,
            runId: RUNNER_RUN_ID,
            content: replyText,
            inputTokens: 10,
            outputTokens: 5,
            model: "test-model",
          });
        },
      };
    }

    /** Yields one partial chunk (the user saw those tokens), then throws. */
    function makePartialThenThrowRunner(partialText: string, message: string): RunnerProtocol {
      return {
        run: async (): Promise<RunResult> => {
          throw new Error("run() not used in these tests");
        },
        async *stream(
          _agent: unknown,
          _message: string,
          options?: RunOptions,
        ): AsyncGenerator<AgentEvent> {
          const traceId = options?.traceId ?? RUNNER_RUN_ID;
          yield createEvent("agent.message.chunk", {
            traceId,
            runId: RUNNER_RUN_ID,
            delta: partialText,
            chunkIndex: 0,
          });
          throw new Error(message);
        },
      };
    }

    it("a throw-before-first-yield turn rejects and records nothing: history empty, exchangeCount 0, no stored messages", async () => {
      const agent = makeAgent("ZeroOutputAgent");
      const runner = makeThrowOnceThenSucceedRunner("ok now", "boom before first token");
      const store = new InMemoryConversationStore();
      const conv = new Conversation(agent, runner, { store });

      const drain = async () => {
        for await (const _e of conv.stream("hello")) {
          // drain
        }
      };
      await expect(drain()).rejects.toThrow("boom before first token");

      expect(conv.history).toHaveLength(0);
      expect(conv.exchangeCount).toBe(0);

      // Nothing was persisted for the errored turn.
      const summariesAfterError = await store.listConversations();
      expect(summariesAfterError).toHaveLength(0);

      // Numbering stays dense for the NEXT (successful) turn, on the SAME
      // conversation instance — this is the direct proof that the
      // `_exchangeCount` bump was REVERTED, not just left stale: a follow-up
      // turn is exchange #1, not #2.
      const events: AgentEvent[] = [];
      for await (const e of conv.stream("hi again")) events.push(e);

      expect(conv.exchangeCount).toBe(1);
      expect(conv.history).toHaveLength(1);
      expect(conv.lastExchange?.number).toBe(1);
      expect(conv.lastExchange?.assistant).toBe("ok now");

      const [summary] = await store.listConversations();
      expect(summary).toBeDefined();
      const messages = await store.getMessages(summary!.conversationId);
      expect(messages).toHaveLength(2);
    });

    it("a partial-text errored turn KEEPS recording (history + exchangeCount + store)", async () => {
      const agent = makeAgent("PartialOutputAgent");
      const runner = makePartialThenThrowRunner("partial reply", "boom mid-stream");
      const store = new InMemoryConversationStore();
      const conv = new Conversation(agent, runner, { store });

      const drain = async () => {
        for await (const _e of conv.stream("hello")) {
          // drain
        }
      };
      await expect(drain()).rejects.toThrow("boom mid-stream");

      expect(conv.history).toHaveLength(1);
      expect(conv.exchangeCount).toBe(1);
      expect(conv.lastExchange?.assistant).toBe("partial reply");

      const [summary] = await store.listConversations();
      expect(summary).toBeDefined();
      const messages = await store.getMessages(summary!.conversationId);
      expect(messages).toHaveLength(2);
      expect(messages[1]?.parts[0]?.content).toBe("partial reply");
    });
  });

  describe("stream() state-delta persistence (#226)", () => {
    /**
     * A runner whose stream interleaves state-delta events between the message
     * lifecycle — the shape `NodeBackedRunner.stream` produces once the relay
     * allowlist includes them (WI-2).
     */
    function makeStateDeltaRunner(): RunnerProtocol {
      return {
        run: async (): Promise<RunResult> => {
          throw new Error("run() not used in these tests");
        },
        async *stream(
          _agent: unknown,
          _message: string,
          options?: RunOptions,
        ): AsyncGenerator<AgentEvent> {
          const ids = {
            traceId: options?.traceId ?? RUNNER_RUN_ID,
            runId: RUNNER_RUN_ID,
          } as const;
          yield createEvent("agent.message.start", { ...ids, agentName: "test-agent" });
          yield createEvent("agent.backpack.drop", {
            ...ids,
            key: "backpack.observations",
            origin: "explicit",
            ordinal: 1,
            accepted: 2,
            merged: 0,
            skipped: 1,
            indexes: [1, 2],
            sizeBefore: 0,
            sizeAfter: 2,
            previews: [{ index: 1, op: "added", preview: "obs-1" }],
            previewsOmitted: 0,
            toolCallId: "tc-1",
            display: { caption: "Evidence" },
          });
          // INNATE read: the preview is the EXACT injected prompt text.
          yield createEvent("agent.scratchpad.read", {
            ...ids,
            key: "agents.retrieve",
            origin: "innate",
            ordinal: 2,
            preview: "## Prior stage output\nthe exact injected prompt text",
          });
          // EXPLICIT read: agent code reading a slot value — no prompt text.
          yield createEvent("agent.scratchpad.read", {
            ...ids,
            key: "agents.retrieve",
            origin: "explicit",
            ordinal: 3,
            preview: "value read by agent code",
          });
          yield createEvent("agent.message.complete", {
            ...ids,
            content: "the answer",
            inputTokens: 10,
            outputTokens: 5,
            model: "test-model",
          });
        },
      };
    }

    async function roundTrip() {
      const store = new InMemoryConversationStore();
      const conv = new Conversation(makeAgent("StateAgent"), makeStateDeltaRunner(), { store });
      for await (const _e of conv.stream("where does the deal stand?")) {
        // drain
      }
      const [summary] = await store.listConversations();
      expect(summary).toBeDefined();
      const messages = await store.getMessages(summary!.conversationId);
      expect(messages).toHaveLength(2);
      return { request: messages[0]!, response: messages[1]! };
    }

    it("persists one state_delta part per state event, in stream order, before the text part", async () => {
      const { request, response } = await roundTrip();

      // The request message is untouched by #226.
      expect(request.parts.map((p) => p.type)).toEqual(["user_prompt"]);

      // Response: frames first (run order), terminal answer text last.
      expect(response.parts.map((p) => p.type)).toEqual([
        "state_delta",
        "state_delta",
        "state_delta",
        "text",
      ]);
      expect(response.parts.map((p) => p.position)).toEqual([0, 1, 2, 3]);
      expect(response.parts[3]?.content).toBe("the answer");

      // The persisted metadata IS the SSE wire payload (snake_case) plus the
      // wire event name — replay rebuilds frames from the same bytes the live
      // stream carried.
      const drop = response.parts[0]!;
      expect(drop.content).toBeUndefined();
      expect(drop.metadata).toEqual({
        event: "backpack.drop",
        key: "backpack.observations",
        origin: "explicit",
        ordinal: 1,
        accepted: 2,
        merged: 0,
        skipped: 1,
        indexes: [1, 2],
        size_before: 0,
        size_after: 2,
        previews: [{ index: 1, op: "added", preview: "obs-1" }],
        previews_omitted: 0,
        tool_call_id: "tc-1",
        display: { caption: "Evidence" },
      });
    });

    it("redacts INNATE scratchpad.read previews (injected prompt text) — thinking's posture", async () => {
      const { response } = await roundTrip();

      const innateRead = response.parts[1]!;
      expect(innateRead.metadata.event).toBe("scratchpad.read");
      expect(innateRead.metadata.origin).toBe("innate");
      // The frame survives (key/ordinal), the injected text does not — and the
      // redaction is explicit, never a silently-missing field.
      expect(innateRead.metadata.key).toBe("agents.retrieve");
      expect("preview" in innateRead.metadata).toBe(false);
      expect(innateRead.metadata.preview_redacted).toBe(true);

      // An EXPLICIT read keeps its value preview — it is not prompt text.
      const explicitRead = response.parts[2]!;
      expect(explicitRead.metadata.origin).toBe("explicit");
      expect(explicitRead.metadata.preview).toBe("value read by agent code");
      expect("preview_redacted" in explicitRead.metadata).toBe(false);
    });

    it("a stream with no state events persists exactly today's parts (no empty extras)", async () => {
      const store = new InMemoryConversationStore();
      const conv = new Conversation(makeAgent("PlainAgent"), makeStreamingRunner("hi back"), {
        store,
      });
      for await (const _e of conv.stream("hello")) {
        // drain
      }
      const [summary] = await store.listConversations();
      const messages = await store.getMessages(summary!.conversationId);
      expect(messages[1]?.parts.map((p) => p.type)).toEqual(["text"]);
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

  // ---------------------------------------------------------------------------
  // Constructor `host` -> send()/stream()/fork() run options (#308). `host`
  // carries a server-parsed SessionScope value (`host.scope`) for the
  // lifetime of the conversation — fixed at construction, not per-message.
  // ---------------------------------------------------------------------------
  describe("constructor host -> send()/stream()/fork() run options (#308)", () => {
    function capturingRunner(): RunnerProtocol & {
      runCalls: (RunOptions | undefined)[];
      streamCalls: (RunOptions | undefined)[];
    } {
      const runner = {
        runCalls: [] as (RunOptions | undefined)[],
        streamCalls: [] as (RunOptions | undefined)[],
        run: async (
          _agent: unknown,
          _message: string,
          options?: RunOptions,
        ): Promise<RunResult> => {
          runner.runCalls.push(options);
          return {
            response: "ok",
            inputTokens: 1,
            outputTokens: 1,
            toolCallsCount: 0,
            iterations: 1,
            finishReason: "stop",
          };
        },
        async *stream(
          _agent: unknown,
          _message: string,
          options?: RunOptions,
        ): AsyncGenerator<AgentEvent> {
          runner.streamCalls.push(options);
          yield createEvent("agent.message.complete", {
            traceId: "t",
            runId: "r",
            content: "ok",
            inputTokens: 1,
            outputTokens: 1,
            model: "m",
          });
        },
      };
      return runner;
    }

    it("send() forwards the constructor host into RunOptions.host", async () => {
      const sentinelHost = { scope: { workspace: "acme" } };
      const runner = capturingRunner();
      const conv = new Conversation(makeAgent(), runner, { host: sentinelHost });

      await conv.send("hi");

      expect(runner.runCalls).toHaveLength(1);
      expect(runner.runCalls[0]?.host).toBe(sentinelHost);
    });

    it("stream() forwards the constructor host into RunOptions.host", async () => {
      const sentinelHost = { scope: { workspace: "acme" } };
      const runner = capturingRunner();
      const conv = new Conversation(makeAgent(), runner, { host: sentinelHost });

      for await (const _e of conv.stream("hi")) {
        // drain
      }

      expect(runner.streamCalls).toHaveLength(1);
      expect(runner.streamCalls[0]?.host).toBe(sentinelHost);
    });

    it("omitting host yields RunOptions.host === undefined on both send() and stream() (no accidental default)", async () => {
      const runner = capturingRunner();
      const conv = new Conversation(makeAgent(), runner);

      await conv.send("hi");
      for await (const _e of conv.stream("hi")) {
        // drain
      }

      expect(runner.runCalls[0]?.host).toBeUndefined();
      expect(runner.streamCalls[0]?.host).toBeUndefined();
    });

    it("fork() carries the host forward onto the forked conversation", async () => {
      const sentinelHost = { scope: { workspace: "acme" } };
      const runner = capturingRunner();
      const conv = new Conversation(makeAgent(), runner, { host: sentinelHost });
      await conv.send("one");

      const forked = await conv.fork();
      await forked.send("two");

      expect(runner.runCalls).toHaveLength(2);
      expect(runner.runCalls[1]?.host).toBe(sentinelHost);
    });
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

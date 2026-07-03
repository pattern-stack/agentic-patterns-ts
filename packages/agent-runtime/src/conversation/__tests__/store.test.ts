import { describe, expect, it } from "vitest";
import { InMemoryConversationStore } from "../store.js";

describe("InMemoryConversationStore", () => {
  it("should create a conversation with correct fields", async () => {
    const store = new InMemoryConversationStore();
    const conv = await store.createConversation("TestAgent", "gpt-4");

    expect(conv.id).toBeTruthy();
    expect(conv.agentName).toBe("TestAgent");
    expect(conv.model).toBe("gpt-4");
    expect(conv.createdAt).toBeInstanceOf(Date);
    expect(conv.updatedAt).toBeInstanceOf(Date);
    expect(conv.metadata).toEqual({});
  });

  it("should return null for unknown conversation", async () => {
    const store = new InMemoryConversationStore();
    const result = await store.getConversation("nonexistent");
    expect(result).toBeNull();
  });

  it("should get a stored conversation", async () => {
    const store = new InMemoryConversationStore();
    const created = await store.createConversation("Agent", "model");
    const fetched = await store.getConversation(created.id);

    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(created.id);
    expect(fetched!.agentName).toBe("Agent");
  });

  it("should update conversation metadata", async () => {
    const store = new InMemoryConversationStore();
    const conv = await store.createConversation("Agent", "model");

    const updated = await store.updateConversation(conv.id, {
      topic: "testing",
    });

    expect(updated.metadata).toEqual({ topic: "testing" });
    expect(updated.updatedAt.getTime()).toBeGreaterThanOrEqual(conv.updatedAt.getTime());
  });

  it("should merge metadata on update", async () => {
    const store = new InMemoryConversationStore();
    const conv = await store.createConversation("Agent", "model");

    await store.updateConversation(conv.id, { a: 1 });
    const updated = await store.updateConversation(conv.id, { b: 2 });

    expect(updated.metadata).toEqual({ a: 1, b: 2 });
  });

  it("should throw on update of unknown conversation", async () => {
    const store = new InMemoryConversationStore();
    await expect(store.updateConversation("nonexistent", {})).rejects.toThrow(
      "Conversation not found",
    );
  });

  it("should add a message with parts", async () => {
    const store = new InMemoryConversationStore();
    const conv = await store.createConversation("Agent", "model");

    const msg = await store.addMessage(conv.id, "request", [
      { type: "user_prompt", content: "Hello" },
    ]);

    expect(msg.id).toBeTruthy();
    expect(msg.conversationId).toBe(conv.id);
    expect(msg.kind).toBe("request");
    expect(msg.parts).toHaveLength(1);
    expect(msg.parts[0]!.type).toBe("user_prompt");
    expect(msg.parts[0]!.content).toBe("Hello");
    expect(msg.parts[0]!.messageId).toBe(msg.id);
    expect(msg.createdAt).toBeInstanceOf(Date);
  });

  it("should store message options", async () => {
    const store = new InMemoryConversationStore();
    const conv = await store.createConversation("Agent", "model");

    const msg = await store.addMessage(conv.id, "response", [{ type: "text", content: "Hi" }], {
      runId: "run-1",
      inputTokens: 100,
      outputTokens: 50,
    });

    expect(msg.runId).toBe("run-1");
    expect(msg.inputTokens).toBe(100);
    expect(msg.outputTokens).toBe(50);
  });

  it("should default token counts to 0", async () => {
    const store = new InMemoryConversationStore();
    const conv = await store.createConversation("Agent", "model");

    const msg = await store.addMessage(conv.id, "request", [{ type: "text", content: "test" }]);

    expect(msg.inputTokens).toBe(0);
    expect(msg.outputTokens).toBe(0);
  });

  it("should throw on addMessage for unknown conversation", async () => {
    const store = new InMemoryConversationStore();
    await expect(store.addMessage("nonexistent", "request", [])).rejects.toThrow(
      "Conversation not found",
    );
  });

  it("should get all messages for a conversation", async () => {
    const store = new InMemoryConversationStore();
    const conv = await store.createConversation("Agent", "model");

    await store.addMessage(conv.id, "request", [{ type: "text", content: "msg1" }]);
    await store.addMessage(conv.id, "response", [{ type: "text", content: "msg2" }]);

    const msgs = await store.getMessages(conv.id);
    expect(msgs).toHaveLength(2);
    expect(msgs[0]!.kind).toBe("request");
    expect(msgs[1]!.kind).toBe("response");
  });

  it("should get messages with limit (returns last N)", async () => {
    const store = new InMemoryConversationStore();
    const conv = await store.createConversation("Agent", "model");

    await store.addMessage(conv.id, "request", [{ type: "text", content: "first" }]);
    await store.addMessage(conv.id, "response", [{ type: "text", content: "second" }]);
    await store.addMessage(conv.id, "request", [{ type: "text", content: "third" }]);

    const msgs = await store.getMessages(conv.id, 2);
    expect(msgs).toHaveLength(2);
    expect(msgs[0]!.parts[0]!.content).toBe("second");
    expect(msgs[1]!.parts[0]!.content).toBe("third");
  });

  it("should return empty array for unknown conversation messages", async () => {
    const store = new InMemoryConversationStore();
    const msgs = await store.getMessages("nonexistent");
    expect(msgs).toEqual([]);
  });

  it("should get message parts", async () => {
    const store = new InMemoryConversationStore();
    const conv = await store.createConversation("Agent", "model");

    const msg = await store.addMessage(conv.id, "request", [
      { type: "user_prompt", content: "Hello" },
      { type: "context", content: "extra", metadata: { source: "test" } },
    ]);

    const parts = await store.getMessageParts(msg.id);
    expect(parts).toHaveLength(2);
    expect(parts[0]!.type).toBe("user_prompt");
    expect(parts[1]!.type).toBe("context");
    expect(parts[1]!.metadata).toEqual({ source: "test" });
  });

  it("should return empty array for unknown message parts", async () => {
    const store = new InMemoryConversationStore();
    const parts = await store.getMessageParts("nonexistent");
    expect(parts).toEqual([]);
  });

  it("should support full CRUD flow", async () => {
    const store = new InMemoryConversationStore();

    // Create
    const conv = await store.createConversation("CRUDAgent", "gpt-4");
    expect(conv.agentName).toBe("CRUDAgent");

    // Update
    await store.updateConversation(conv.id, { topic: "crud-test" });
    const updated = await store.getConversation(conv.id);
    expect(updated!.metadata).toEqual({ topic: "crud-test" });

    // Add messages
    const reqMsg = await store.addMessage(conv.id, "request", [
      { type: "user_prompt", content: "What is 2+2?" },
    ]);
    const resMsg = await store.addMessage(conv.id, "response", [{ type: "text", content: "4" }], {
      inputTokens: 10,
      outputTokens: 5,
    });

    // Read messages
    const msgs = await store.getMessages(conv.id);
    expect(msgs).toHaveLength(2);

    // Read parts
    const reqParts = await store.getMessageParts(reqMsg.id);
    expect(reqParts).toHaveLength(1);
    expect(reqParts[0]!.content).toBe("What is 2+2?");

    const resParts = await store.getMessageParts(resMsg.id);
    expect(resParts).toHaveLength(1);
    expect(resParts[0]!.content).toBe("4");
  });
});

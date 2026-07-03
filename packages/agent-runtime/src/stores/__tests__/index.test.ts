import { describe, expect, it } from "vitest";
import { EventStore, InMemoryConversationStore } from "../index.js";
import type { ConversationStore, ScratchpadStore } from "../index.js";

describe("stores barrel", () => {
  it("exports InMemoryConversationStore and round-trips a conversation + message", async () => {
    const store = new InMemoryConversationStore();
    const conv = await store.createConversation("TestAgent", "gpt-4");
    await store.addMessage(conv.id, "request", [{ type: "user_prompt", content: "hi" }]);

    const messages = await store.getMessages(conv.id);
    expect(messages).toHaveLength(1);
  });

  it("exports EventStore as a constructor", () => {
    expect(typeof EventStore).toBe("function");
  });

  it("type-checks InMemoryConversationStore against the ConversationStore barrel type", () => {
    const store: ConversationStore = new InMemoryConversationStore();
    expect(store).toBeInstanceOf(InMemoryConversationStore);
  });

  it("re-exports ScratchpadStore as a usable type alias", () => {
    // Compile-time check only — no runtime instance exists here.
    const assertType = (_value: ScratchpadStore): void => {};
    expect(typeof assertType).toBe("function");
  });
});

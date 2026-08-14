/**
 * Conversation identity (#480) — the live conversation and its durable row
 * share ONE id.
 *
 * Before this, every store minted its own uuid inside `createConversation`,
 * so `Conversation.id` (the only id a caller could send a message to) and
 * `StoredConversation.id` (the only id a caller could read back) were
 * structurally guaranteed to differ, and nothing that had been persisted
 * could ever be continued.
 */

import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { SQLiteConversationStore } from "../../storage/conversation-store.js";
import { Conversation } from "../conversation.js";
import { InMemoryConversationStore } from "../store.js";
import type { ConversationStore, CreateConversationOptions } from "../store.js";

const agent = {
  getModel: () => "test-model",
  getTools: () => [],
  renderInitialPrompt: () => "",
  role: { name: "Identity" },
};

function makeRunner() {
  return {
    async run() {
      return { response: "ok", inputTokens: 1, outputTokens: 1 };
    },
  };
}

describe("createConversation honors a supplied id", () => {
  it("InMemoryConversationStore stores under the supplied id", async () => {
    const store = new InMemoryConversationStore();
    const conv = await store.createConversation("A", "m", { id: "chosen-id" });

    expect(conv.id).toBe("chosen-id");
    expect((await store.getConversation("chosen-id"))?.id).toBe("chosen-id");
  });

  it("SQLiteConversationStore stores under the supplied id", async () => {
    const store = new SQLiteConversationStore({ path: ":memory:", Database });
    try {
      const conv = await store.createConversation("A", "m", { id: "chosen-id" });

      expect(conv.id).toBe("chosen-id");
      expect((await store.getConversation("chosen-id"))?.id).toBe("chosen-id");
    } finally {
      store.close();
    }
  });

  it("persists initial metadata (the binding stamp resume reads)", async () => {
    const inMemory = new InMemoryConversationStore();
    const sqlite = new SQLiteConversationStore({ path: ":memory:", Database });
    try {
      const metadata = { binding: { agentId: "my-agent", scopeSupplied: true } };
      for (const store of [inMemory, sqlite] as ConversationStore[]) {
        await store.createConversation("A", "m", { id: "c1", metadata });
        expect((await store.getConversation("c1"))?.metadata).toEqual(metadata);
      }
    } finally {
      sqlite.close();
    }
  });

  it("still mints an id when none is supplied (pre-#480 behavior)", async () => {
    const store = new InMemoryConversationStore();
    const conv = await store.createConversation("A", "m");
    expect(conv.id).toBeTruthy();
  });

  it("rejects a duplicate id rather than silently forking a second row", async () => {
    const store = new InMemoryConversationStore();
    await store.createConversation("A", "m", { id: "dupe" });
    await expect(store.createConversation("A", "m", { id: "dupe" })).rejects.toThrow(
      /already exists/,
    );
  });
});

describe("Conversation persists under its own id", () => {
  it("the durable row id equals Conversation.id", async () => {
    const store = new InMemoryConversationStore();
    const conversation = new Conversation(agent as never, makeRunner() as never, { store });

    await conversation.send("hello");

    expect(conversation.persistedId).toBe(conversation.id);
    // The id the caller holds is the id the store answers to — the whole fix.
    expect(await store.getConversation(conversation.id)).not.toBeNull();
    expect(await store.getMessages(conversation.id)).toHaveLength(2);
  });

  it("adopts a pre-created row instead of creating a second one", async () => {
    const store = new InMemoryConversationStore();
    // The server creates the row eagerly at POST /conversations, before any
    // message exists.
    const row = await store.createConversation("Identity", "test-model", { id: "pre-made" });
    const conversation = new Conversation(agent as never, makeRunner() as never, {
      id: "pre-made",
      store,
    });

    await conversation.send("hello");

    expect(conversation.persistedId).toBe("pre-made");
    expect(await store.listConversations()).toHaveLength(1);
    // Metadata written at creation survives — the exchange did not clobber it.
    expect((await store.getConversation("pre-made"))?.createdAt).toEqual(row.createdAt);
  });

  it("accretes turns into ONE row rather than a row per turn", async () => {
    const store = new InMemoryConversationStore();
    const conversation = new Conversation(agent as never, makeRunner() as never, { store });

    await conversation.send("one");
    await conversation.send("two");
    await conversation.send("three");

    expect(await store.listConversations()).toHaveLength(1);
    expect(await store.getMessages(conversation.id)).toHaveLength(6);
  });

  it("warns but stays coherent against a store that ignores the supplied id", async () => {
    // A third-party ConversationStore written before the `options.id`
    // parameter existed: it mints its own id. Messages must still persist
    // coherently under whatever it returned, and the mismatch must be said
    // out loud — a silent fallback is how #480 stayed invisible.
    const inner = new InMemoryConversationStore();
    const legacyStore: ConversationStore = {
      ...inner,
      createConversation: (name: string, model: string, _options?: CreateConversationOptions) =>
        inner.createConversation(name, model),
      getConversation: (id: string) => inner.getConversation(id),
      updateConversation: (id: string, u: Record<string, unknown>) =>
        inner.updateConversation(id, u),
      addMessage: (...args: Parameters<ConversationStore["addMessage"]>) =>
        inner.addMessage(...args),
      getMessages: (id: string, limit?: number) => inner.getMessages(id, limit),
      getMessageParts: (id: string) => inner.getMessageParts(id),
      listConversations: (limit?: number) => inner.listConversations(limit),
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const conversation = new Conversation(agent as never, makeRunner() as never, {
        store: legacyStore,
      });
      await conversation.send("hello");
      await conversation.send("again");

      expect(warn).toHaveBeenCalledOnce();
      expect(warn.mock.calls[0]?.[0]).toMatch(/ignored the supplied conversation id/);
      // Degraded, not broken: both turns still land in one coherent row.
      expect(conversation.persistedId).not.toBe(conversation.id);
      expect(await inner.getMessages(conversation.persistedId as string)).toHaveLength(4);
    } finally {
      warn.mockRestore();
    }
  });
});

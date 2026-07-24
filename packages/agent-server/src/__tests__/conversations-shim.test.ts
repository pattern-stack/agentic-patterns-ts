/**
 * #351 — chat-patterns history compat shim: bare `GET /conversations` +
 * additive `GET /conversations/:id` snake_case aliases / inline `messages[]`.
 *
 * Fixture contract (spec `.ai-docs/stacks/harness-cockpit/specs/351.md` §3):
 * this suite byte-locks both response bodies against the checked-in golden
 * fixtures under `__fixtures__/chat-patterns-shim/` (biome-ignored — the
 * contract bytes can never be reformatted). #354 (Go chat-patterns) vendors
 * the same bytes + `MANIFEST.sha256` as its decode fixtures — cross-repo
 * drift becomes a one-file diff there.
 *
 * Determinism: `vi.useFakeTimers()` + a counter-based `crypto.randomUUID`
 * stub make the seed (and therefore every id/timestamp in the wire bodies)
 * reproducible run to run. Regeneration: `UPDATE_SHIM_FIXTURES=1 bun run
 * test conversations-shim` rewrites both fixture files + `MANIFEST.sha256`
 * from whatever this suite currently produces, instead of asserting.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { AgentEventBus, InMemoryConversationStore } from "@agentic-patterns/runtime";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ConversationEntry, conversationRoutes } from "../routes/conversations.js";

// ---------------------------------------------------------------------------
// Fixture paths + regen switch
// ---------------------------------------------------------------------------

const FIXTURES_DIR = fileURLToPath(new URL("./__fixtures__/chat-patterns-shim/", import.meta.url));
const LIST_FIXTURE = `${FIXTURES_DIR}conversations-list.json`;
const DETAIL_FIXTURE = `${FIXTURES_DIR}conversation-detail.json`;
const MANIFEST_FIXTURE = `${FIXTURES_DIR}MANIFEST.sha256`;

const UPDATE = process.env.UPDATE_SHIM_FIXTURES === "1";

function sha256(bytes: string): string {
  return createHash("sha256").update(bytes, "utf8").digest("hex");
}

/**
 * Byte-locks `actual` against the committed fixture at `path` — or, under
 * `UPDATE_SHIM_FIXTURES=1`, (re)writes it instead of asserting (explicit,
 * dependency-free snapshot-update idiom).
 */
function assertOrWriteFixture(path: string, actual: string): void {
  if (UPDATE) {
    mkdirSync(FIXTURES_DIR, { recursive: true });
    writeFileSync(path, actual);
    return;
  }
  expect(actual).toBe(readFileSync(path, "utf8"));
}

// ---------------------------------------------------------------------------
// App + deterministic seed
// ---------------------------------------------------------------------------

function mkApp(store?: InMemoryConversationStore): Hono {
  const app = new Hono();
  app.route(
    "/",
    conversationRoutes([], new Map<string, ConversationEntry>(), new AgentEventBus(), store),
  );
  return app;
}

const BASE_TIME = Date.UTC(2026, 6, 24, 12, 0, 0, 0); // 2026-07-24T12:00:00.000Z

function tick(offsetSeconds: number): void {
  vi.setSystemTime(new Date(BASE_TIME + offsetSeconds * 1000));
}

/**
 * Seeds conv A then conv B, each 2 request/response exchanges, per the
 * spec's pinned seed table (§3) — mirrors production `_persistExchange`
 * faithfully (request messages carry `runId` only; response messages carry
 * `runId` + token split; a content-less `state_delta` part precedes the
 * terminal `text` part on A's first response).
 */
async function seed(
  store: InMemoryConversationStore,
): Promise<{ convA: { id: string }; convB: { id: string } }> {
  tick(0);
  const convA = await store.createConversation("alpha-agent", "test-model-a");

  tick(1);
  await store.addMessage(convA.id, "request", [{ type: "user_prompt", content: "hello alpha" }], {
    runId: "run-a-1",
  });

  tick(2);
  await store.addMessage(
    convA.id,
    "response",
    [
      { type: "state_delta", metadata: { event: "backpack.drop" } },
      { type: "text", content: "hi from alpha" },
    ],
    { runId: "run-a-1", inputTokens: 11, outputTokens: 7 },
  );

  tick(3);
  await store.addMessage(convA.id, "request", [{ type: "user_prompt", content: "again" }], {
    runId: "run-a-2",
  });

  tick(4);
  await store.addMessage(convA.id, "response", [{ type: "text", content: "alpha again" }], {
    runId: "run-a-2",
    inputTokens: 13,
    outputTokens: 9,
  });

  tick(5);
  const convB = await store.createConversation("beta-agent", "test-model-b");

  tick(6);
  await store.addMessage(convB.id, "request", [{ type: "user_prompt", content: "hello beta" }], {
    runId: "run-b-1",
  });

  tick(7);
  await store.addMessage(convB.id, "response", [{ type: "text", content: "hi from beta" }], {
    runId: "run-b-1",
    inputTokens: 17,
    outputTokens: 5,
  });

  tick(8);
  await store.addMessage(convB.id, "request", [{ type: "user_prompt", content: "again beta" }], {
    runId: "run-b-2",
  });

  tick(9);
  await store.addMessage(convB.id, "response", [{ type: "text", content: "beta again" }], {
    runId: "run-b-2",
    inputTokens: 19,
    outputTokens: 8,
  });

  return { convA, convB };
}

let uuidCounter = 0;

beforeEach(() => {
  uuidCounter = 0;
  vi.useFakeTimers();
  vi.setSystemTime(new Date(BASE_TIME));
  vi.stubGlobal("crypto", {
    ...globalThis.crypto,
    randomUUID: () => `00000000-0000-4000-8000-${(++uuidCounter).toString().padStart(12, "0")}`,
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GET /conversations (bare shim list)", () => {
  it("503s with a hint when no store is configured", async () => {
    const app = mkApp();
    const res = await app.request("/conversations");
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string; hint: string };
    expect(body.error).toBe("persistence not configured");
    expect(body.hint).toContain("ap playground");
  });

  it("returns a bare newest-first snake_case array with seeded per-kind aggregates — byte-locked", async () => {
    const store = new InMemoryConversationStore();
    const { convA, convB } = await seed(store);
    const app = mkApp(store);

    const res = await app.request("/conversations");
    expect(res.status).toBe(200);
    const text = await res.text();
    const body = JSON.parse(text) as Array<{
      id: string;
      agent_name: string;
      model: string;
      state: string;
      exchange_count: number;
      total_input_tokens: number;
      total_output_tokens: number;
      created_at: string;
      updated_at: string;
    }>;

    // Bare array — no wrapper key.
    expect(Array.isArray(body)).toBe(true);
    // Newest-first: B before A.
    expect(body.map((r) => r.id)).toEqual([convB.id, convA.id]);

    const rowA = body.find((r) => r.id === convA.id);
    const rowB = body.find((r) => r.id === convB.id);
    expect(rowA?.agent_name).toBe("alpha-agent");
    expect(rowA?.model).toBe("test-model-a");
    expect(rowA?.exchange_count).toBe(2);
    // NOT the combined tokenCount (24+16=40) — the per-kind split.
    expect(rowA?.total_input_tokens).toBe(24);
    expect(rowA?.total_output_tokens).toBe(16);
    expect(rowB?.agent_name).toBe("beta-agent");
    expect(rowB?.exchange_count).toBe(2);
    expect(rowB?.total_input_tokens).toBe(36);
    expect(rowB?.total_output_tokens).toBe(13);

    for (const row of body) {
      expect(row).not.toHaveProperty("branched_from_id");
      expect(row).not.toHaveProperty("branched_at_sequence");
    }

    assertOrWriteFixture(LIST_FIXTURE, `${text}\n`);
  });

  it("filters by exact ?agent_name= match; an unknown name returns [] 200 (never 404)", async () => {
    const store = new InMemoryConversationStore();
    const { convA } = await seed(store);
    const app = mkApp(store);

    const matched = await app.request("/conversations?agent_name=alpha-agent");
    expect(matched.status).toBe(200);
    const matchedBody = (await matched.json()) as Array<{ id: string }>;
    expect(matchedBody.map((r) => r.id)).toEqual([convA.id]);

    const unknown = await app.request("/conversations?agent_name=nobody");
    expect(unknown.status).toBe(200);
    expect(await unknown.json()).toEqual([]);
  });

  it("zeroes an empty conversation's aggregates", async () => {
    const store = new InMemoryConversationStore();
    const conv = await store.createConversation("empty-agent", "empty-model");
    const app = mkApp(store);

    const res = await app.request("/conversations");
    const body = (await res.json()) as Array<{
      id: string;
      exchange_count: number;
      total_input_tokens: number;
      total_output_tokens: number;
      created_at: string;
      updated_at: string;
    }>;
    const row = body.find((r) => r.id === conv.id);
    expect(row?.exchange_count).toBe(0);
    expect(row?.total_input_tokens).toBe(0);
    expect(row?.total_output_tokens).toBe(0);
    expect(row?.updated_at).toBe(row?.created_at);
  });
});

describe("GET /conversations/:id (additive snake_case + inline messages[])", () => {
  it("keeps every camelCase key byte-identical and appends the exact snake_case + messages[] superset — byte-locked", async () => {
    const store = new InMemoryConversationStore();
    const { convA } = await seed(store);
    const app = mkApp(store);

    const res = await app.request(`/conversations/${convA.id}`);
    expect(res.status).toBe(200);
    const text = await res.text();
    const body = JSON.parse(text) as Record<string, unknown>;

    // Regression guard both directions — the exact union of the 12
    // pre-existing camelCase keys + the 8 additions, nothing more/less.
    expect(Object.keys(body).sort()).toEqual(
      [
        "id",
        "agentConfigId",
        "status",
        "agentName",
        "model",
        "tokenCount",
        "messageCount",
        "startedAt",
        "completedAt",
        "error",
        "createdAt",
        "updatedAt",
        "agent_name",
        "state",
        "exchange_count",
        "total_input_tokens",
        "total_output_tokens",
        "created_at",
        "updated_at",
        "messages",
      ].sort(),
    );

    // DELTA-1 — detail also carries the token split (Go's
    // ConversationDetailResponse declares both; #354's non-zero decode lock
    // needs them).
    expect(body.total_input_tokens).toBe(24);
    expect(body.total_output_tokens).toBe(16);

    const messages = body.messages as Array<{
      id: string;
      kind: string;
      sequence: number;
      parts: Array<{ type: string; content: string | null; metadata: Record<string, unknown> }>;
    }>;
    expect(messages).toHaveLength(4);
    expect(messages.map((m) => m.sequence)).toEqual([0, 1, 2, 3]);
    // `kind` verbatim request|response — no user/assistant translation (A-2).
    expect(messages.map((m) => m.kind)).toEqual(["request", "response", "request", "response"]);

    const resp1Parts = messages[1]?.parts ?? [];
    expect(resp1Parts).toHaveLength(2);
    // The content-less state_delta serializes content:null with its
    // metadata intact.
    expect(resp1Parts[0]?.type).toBe("state_delta");
    expect(resp1Parts[0]?.content).toBeNull();
    expect(resp1Parts[0]?.metadata).toEqual({ event: "backpack.drop" });
    expect(resp1Parts[1]?.type).toBe("text");
    expect(resp1Parts[1]?.content).toBe("hi from alpha");

    assertOrWriteFixture(DETAIL_FIXTURE, `${text}\n`);
  });

  it("zeroes an empty conversation's detail aggregates and messages[]", async () => {
    const store = new InMemoryConversationStore();
    const conv = await store.createConversation("empty-agent", "empty-model");
    const app = mkApp(store);

    const res = await app.request(`/conversations/${conv.id}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      exchange_count: number;
      total_input_tokens: number;
      total_output_tokens: number;
      messages: unknown[];
    };
    expect(body.exchange_count).toBe(0);
    expect(body.total_input_tokens).toBe(0);
    expect(body.total_output_tokens).toBe(0);
    expect(body.messages).toEqual([]);
  });
});

describe("fixture manifest lockstep (enforcement layer 2, in-repo half)", () => {
  it("MANIFEST.sha256 matches the committed fixture bytes", () => {
    const listBytes = readFileSync(LIST_FIXTURE, "utf8");
    const detailBytes = readFileSync(DETAIL_FIXTURE, "utf8");
    const expected =
      `${sha256(listBytes)}  conversations-list.json\n` +
      `${sha256(detailBytes)}  conversation-detail.json\n`;

    if (UPDATE) {
      writeFileSync(MANIFEST_FIXTURE, expected);
      return;
    }
    expect(readFileSync(MANIFEST_FIXTURE, "utf8")).toBe(expected);
  });
});

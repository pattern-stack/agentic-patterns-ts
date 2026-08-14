/**
 * sdk-bridge — envelope-shape test for the SDK seam (#266 D1).
 *
 * `buildCapabilityServer`'s per-play handler (`sdk-bridge.ts:79-84`) has no
 * try/catch. This test drives a violating `definePlay` play through the real
 * SDK machinery (an in-memory MCP client/server pair, not a mock) and pins
 * `Playbook.execute`'s envelope reaching the client intact.
 *
 * Note: MCP SDK 1.29.0's `CallTool` handler wraps tool invocation in its own
 * try/catch and converts ANY throw into `{ isError: true, content: [{ text:
 * err.message }] }` (`@modelcontextprotocol/sdk/dist/esm/server/mcp.js:135-161`).
 * That means `isError === true` alone does NOT discriminate the envelope
 * path from a thrown error reaching the SDK — both produce `isError: true`.
 * The thing that does discriminate: `Playbook.execute`'s envelope path
 * serializes a JSON OBJECT (`{ error: "..." }`) into `content[0].text`,
 * while an uncaught throw's `text` is a bare message string, which is not
 * valid JSON. So the assertion below parses `content[0].text` and checks it
 * is the `{ error }` object — this fails (JSON.parse throws) if
 * `Playbook.execute` ever regresses to throwing instead of enveloping.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Capability, definePlay, playbook, toolbox } from "@pattern-stack/agentic-core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { buildCapabilityServer } from "../sdk-bridge.js";

function violatingCapability(): Capability {
  const emptyToolbox = toolbox("empty", "No tools", {});
  const plays = playbook("violating-plays", "Plays for the never-throw seam test", {
    bad_play: definePlay({
      description: "Always returns output that violates its own returns schema",
      parameters: z.object({}),
      returns: z.object({ ok: z.string() }),
      // deliberately wrong shape — `ok` should be a string
      execute: async () => ({ ok: 42 }) as unknown as { ok: string },
    }),
  });
  return new Capability("violating-cap", "test capability", emptyToolbox, undefined, plays);
}

describe("sdk-bridge — envelope shape across the SDK seam", () => {
  it("delivers Playbook.execute's { error } envelope, not a bare thrown message", async () => {
    const { serverConfig } = buildCapabilityServer(violatingCapability());

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });

    await Promise.all([
      client.connect(clientTransport),
      serverConfig.instance.connect(serverTransport),
    ]);

    const result = await client.callTool({ name: "bad_play", arguments: {} });

    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    const text = content[0]?.text ?? "";

    // Discriminating assertion: `JSON.parse` throws (failing the test) if
    // `text` is a bare thrown-error message rather than the serialized
    // `{ error }` envelope object — see the file header for why `isError`
    // alone can't tell the two apart.
    const parsed: unknown = JSON.parse(text);
    expect(parsed).toEqual({
      error: expect.stringContaining("play 'bad_play' output violated its returns schema"),
    });

    await client.close();
  });
});

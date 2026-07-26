/**
 * sdk-bridge — never-throw-across-the-SDK-seam test (#266 D1).
 *
 * `buildCapabilityServer`'s per-play handler (`sdk-bridge.ts:79-84`) has no
 * try/catch: the argument for D1's "envelope, not throw" decision is that a
 * throwing `Playbook.execute` would REJECT inside the MCP tool handler
 * instead of resolving with an `isError` result. Nothing exercised that path
 * before #266 — this test drives a violating `definePlay` play through the
 * real SDK machinery (an in-memory MCP client/server pair, not a mock) and
 * asserts the call RESOLVES with `isError: true`.
 */

import { Capability, definePlay, playbook, toolbox } from "@agentic-patterns/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
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

describe("sdk-bridge — never-throw across the SDK seam", () => {
  it("resolves isError: true for a violating definePlay play instead of rejecting", async () => {
    const { serverConfig } = buildCapabilityServer(violatingCapability());

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });

    await Promise.all([
      client.connect(clientTransport),
      serverConfig.instance.connect(serverTransport),
    ]);

    // The call must RESOLVE, not reject — that is D1's actual claim.
    const result = await client.callTool({ name: "bad_play", arguments: {} });

    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0]?.text).toContain("bad_play");
    expect(content[0]?.text).toContain("output violated its returns schema");

    await client.close();
  });
});

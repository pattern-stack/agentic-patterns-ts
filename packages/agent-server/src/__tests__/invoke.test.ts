/**
 * Direct tool invoke route tests (playground-upgrades S3,
 * port-map.md §2.2 — `POST /capabilities/:id/tools/:toolName/invoke`).
 *
 * Builds a real core Agent/Role/Capability/Toolbox (same fixture philosophy
 * as composition.test.ts) so the route is exercised against the actual
 * Zod-validating `Toolbox.execute`, not a stub.
 */

import {
  Agent,
  Capability,
  Mission,
  Persona,
  Role,
  type ToolDefinition,
  Toolbox,
} from "@agentic-patterns/core";
import { type AgentEvent, AgentEventBus } from "@agentic-patterns/runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createServer } from "../app.js";
import type { AgentRegistration, ServerConfig } from "../config.js";

/* ------------------------------------------------------------------------ */
/* Fixtures                                                                  */
/* ------------------------------------------------------------------------ */

class DemoToolbox extends Toolbox {
  readonly name = "demo-tools";
  readonly description = "Demo tools for invoke route tests";
  readonly tools: Record<string, ToolDefinition> = {
    echo: {
      description: "Echo the given text back",
      parameters: z.object({ text: z.string() }),
      execute: async (args) => ({ text: args.text }),
    },
    add: {
      description: "Add two numbers",
      parameters: z.object({ a: z.number(), b: z.number() }),
      execute: async (args) => ({ sum: (args.a as number) + (args.b as number) }),
    },
    boom: {
      description: "Always throws",
      parameters: z.object({}),
      execute: async () => {
        throw new Error("kaboom");
      },
    },
  };
}

const demoToolbox = new DemoToolbox();
const demoCapability = new Capability(
  "Demo Tools",
  "A demo capability for invoke route tests",
  demoToolbox,
);
// Capability id: slugId("Demo Tools demo-tools") — see routes/composition.ts buildCapabilityEntries.
const CAP_ID = "demo-tools-demo-tools";

function makeRole(): Role {
  return new Role({
    name: "Demo",
    persona: new Persona({ identity: "a demo agent", tone: "plain" }),
    capabilities: [demoCapability],
  });
}

const demoAgent = new Agent({
  role: makeRole(),
  mission: new Mission({ objective: "Demonstrate tool invoke" }),
});

const mockRunner = {
  async run() {
    return {
      response: "ok",
      inputTokens: 0,
      outputTokens: 0,
      toolCallsCount: 0,
      iterations: 1,
      finishReason: "stop",
    };
  },
};

function register(id: string, name: string, agent: Agent): AgentRegistration {
  return { id, name, agent, runner: mockRunner };
}

const registrations = [register("demo", "Demo", demoAgent)];

const mockAdminService = {
  async getDashboardStats() {
    return {
      agents: [],
      activeAgentCount: 0,
      totalTokensUsed: 0,
      totalToolCalls: 0,
      totalErrors: 0,
      activeConversationCount: 0,
      uptimeMs: 0,
    };
  },
  async getAgentStats() {
    return undefined;
  },
  async getAllAgentStats() {
    return [];
  },
  async getRecentEvents() {
    return [];
  },
  async getTraceSummaries() {
    return [];
  },
  async getConversations() {
    return [];
  },
  async getToolAnalytics() {
    return [];
  },
  async getTokenUsage() {
    return [];
  },
};

function makeApp(eventBus: AgentEventBus) {
  const config: ServerConfig = {
    agents: registrations,
    adminService: mockAdminService,
    eventBus,
    sseExporter: { connect: () => new ReadableStream(), disconnect: () => {} },
  };
  return createServer(config);
}

/* ------------------------------------------------------------------------ */
/* POST /capabilities/:id/tools/:toolName/invoke                            */
/* ------------------------------------------------------------------------ */

describe("POST /capabilities/:id/tools/:toolName/invoke", () => {
  it("invokes a tool successfully and publishes a tool.start/tool.end pair", async () => {
    const bus = new AgentEventBus();
    const seen: AgentEvent[] = [];
    bus.subscribeAll((e) => {
      seen.push(e as AgentEvent);
    });

    const res = await makeApp(bus).request(`/capabilities/${CAP_ID}/tools/echo/invoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ args: { text: "hi" } }),
    });

    expect(res.status).toBe(200);
    // biome-ignore lint/suspicious/noExplicitAny: test payload assertion
    const body = (await res.json()) as any;
    expect(body).toEqual({ ok: true, result: { text: "hi" }, ms: expect.any(Number) });
    expect(body.ms).toBeGreaterThanOrEqual(0);

    // Locked decision: agent.tool.start/end publish onto the event bus with a
    // synthetic workbench runId, so invokes surface on /live.
    const types = seen.map((e) => e.type);
    expect(types).toEqual(["agent.tool.start", "agent.tool.end"]);
    const start = seen[0];
    const end = seen[1];
    if (start?.type === "agent.tool.start" && end?.type === "agent.tool.end") {
      expect(start.toolName).toBe("echo");
      expect(start.arguments).toEqual({ text: "hi" });
      expect(start.runId).toMatch(/^workbench:/);
      expect(end.toolName).toBe("echo");
      expect(end.result).toEqual({ text: "hi" });
      expect(end.error).toBeUndefined();
      expect(end.runId).toBe(start.runId);
      expect(end.spanId).toBe(start.spanId);
    } else {
      throw new Error("expected agent.tool.start then agent.tool.end");
    }
  });

  it("returns ok:false with a flattened Zod error for a wrong-typed argument", async () => {
    const bus = new AgentEventBus();
    const res = await makeApp(bus).request(`/capabilities/${CAP_ID}/tools/add/invoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ args: { a: "not-a-number", b: 2 } }),
    });

    expect(res.status).toBe(200);
    // biome-ignore lint/suspicious/noExplicitAny: test payload assertion
    const body = (await res.json()) as any;
    expect(body.ok).toBe(false);
    expect(body.result).toBeUndefined();
    expect(typeof body.error).toBe("string");
    expect(body.error).toContain("a:");
    expect(typeof body.ms).toBe("number");
  });

  it("returns 404 for an unknown tool on a known capability", async () => {
    const bus = new AgentEventBus();
    const res = await makeApp(bus).request(`/capabilities/${CAP_ID}/tools/nope/invoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ args: {} }),
    });
    expect(res.status).toBe(404);
    // biome-ignore lint/suspicious/noExplicitAny: test payload assertion
    const body = (await res.json()) as any;
    expect(body.error).toContain("nope");
  });

  it("returns 404 for an unknown capability", async () => {
    const bus = new AgentEventBus();
    const res = await makeApp(bus).request("/capabilities/does-not-exist/tools/echo/invoke", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ args: {} }),
    });
    expect(res.status).toBe(404);
    // biome-ignore lint/suspicious/noExplicitAny: test payload assertion
    const body = (await res.json()) as any;
    expect(body.error).toContain("does-not-exist");
  });

  it("returns ok:false with the thrown message when the tool itself throws", async () => {
    const bus = new AgentEventBus();
    const seen: AgentEvent[] = [];
    bus.subscribeAll((e) => {
      seen.push(e as AgentEvent);
    });

    const res = await makeApp(bus).request(`/capabilities/${CAP_ID}/tools/boom/invoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ args: {} }),
    });

    expect(res.status).toBe(200);
    // biome-ignore lint/suspicious/noExplicitAny: test payload assertion
    const body = (await res.json()) as any;
    expect(body).toEqual({ ok: false, error: "kaboom", ms: expect.any(Number) });

    const end = seen.find((e) => e.type === "agent.tool.end");
    if (end?.type === "agent.tool.end") {
      expect(end.error).toBe("kaboom");
    } else {
      throw new Error("expected an agent.tool.end event even on tool failure");
    }
  });
});

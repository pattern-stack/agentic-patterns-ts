import { AgentEventBus, type AgentEvent } from "@pattern-stack/agent-runtime";
import { describe, expect, it } from "vitest";
import { hookRoutes } from "../routes/hooks.js";

describe("POST /hooks/:eventType", () => {
  it("publishes a claude_code.hook event and a derived agent.tool.start for PreToolUse", async () => {
    const bus = new AgentEventBus();
    const seen: AgentEvent[] = [];
    bus.subscribe("claude_code.hook", (e) => {
      seen.push(e as AgentEvent);
    });
    bus.subscribe("agent.tool.start", (e) => {
      seen.push(e as AgentEvent);
    });

    const app = hookRoutes(bus);

    const res = await app.request("/hooks/PreToolUse", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: "sess-abc",
        cwd: "/tmp/proj",
        tool_name: "Bash",
        tool_input: { command: "ls" },
        tool_use_id: "call-1",
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body).toEqual({ ok: true });

    const types = seen.map((e) => e.type);
    expect(types).toContain("claude_code.hook");
    expect(types).toContain("agent.tool.start");

    const start = seen.find((e) => e.type === "agent.tool.start");
    if (start && start.type === "agent.tool.start") {
      expect(start.toolName).toBe("Bash");
      expect(start.toolCallId).toBe("call-1");
      expect(start.arguments).toEqual({ command: "ls" });
      expect(start.traceId).toBe("sess-abc");
    }

    const hook = seen.find((e) => e.type === "claude_code.hook");
    if (hook && hook.type === "claude_code.hook") {
      expect(hook.sessionId).toBe("sess-abc");
      expect(hook.cwd).toBe("/tmp/proj");
      expect(hook.payload).toMatchObject({ session_id: "sess-abc", tool_name: "Bash" });
    }
  });

  it("skips derived events but stamps runnerCorrelationId when header is present", async () => {
    const bus = new AgentEventBus();
    const seen: AgentEvent[] = [];
    bus.subscribe("claude_code.hook", (e) => {
      seen.push(e as AgentEvent);
    });
    bus.subscribe("agent.tool.start", (e) => {
      seen.push(e as AgentEvent);
    });
    bus.subscribe("agent.tool.end", (e) => {
      seen.push(e as AgentEvent);
    });

    const app = hookRoutes(bus);

    const res = await app.request("/hooks/PreToolUse", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-ap-runner-correlation-id": "corr-xyz-123",
      },
      body: JSON.stringify({
        session_id: "sess-rid",
        cwd: "/tmp/proj",
        tool_name: "Bash",
        tool_input: { command: "ls" },
        tool_use_id: "call-2",
      }),
    });

    expect(res.status).toBe(200);

    const types = seen.map((e) => e.type);
    expect(types).toContain("claude_code.hook");
    // Derived events MUST be suppressed when runner correlation header is set.
    expect(types).not.toContain("agent.tool.start");
    expect(types).not.toContain("agent.tool.end");

    const hook = seen.find((e) => e.type === "claude_code.hook");
    expect(hook).toBeDefined();
    if (hook && hook.type === "claude_code.hook") {
      expect(hook.runnerCorrelationId).toBe("corr-xyz-123");
      expect(hook.sessionId).toBe("sess-rid");
    }
  });

  it("returns 400 for an unknown hook event name", async () => {
    const bus = new AgentEventBus();
    const app = hookRoutes(bus);

    const res = await app.request("/hooks/NotARealHook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("NotARealHook");
  });
});

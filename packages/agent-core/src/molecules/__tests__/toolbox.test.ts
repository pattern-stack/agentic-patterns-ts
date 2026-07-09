import { describe, expect, it } from "vitest";
import { z } from "zod";
import { type ToolDefinition, type ToolExecutionContext, Toolbox } from "../toolbox.js";

/** Concrete test toolbox with 2 tools. */
class MathToolbox extends Toolbox {
  readonly name = "Math";
  readonly description = "Basic math operations";
  readonly tools: Record<string, ToolDefinition> = {
    add: {
      description: "Add two numbers",
      parameters: z.object({ a: z.number(), b: z.number() }),
      execute: async (args) => {
        const { a, b } = args as { a: number; b: number };
        return a + b;
      },
    },
    multiply: {
      description: "Multiply two numbers",
      parameters: z.object({ a: z.number(), b: z.number() }),
      returns: z.object({ product: z.number() }),
      execute: async (args) => {
        const { a, b } = args as { a: number; b: number };
        return { product: a * b };
      },
    },
  };
}

/** Toolbox with tools exercising `ToolExecutionContext` forwarding. */
class ProbeToolbox extends Toolbox {
  readonly name = "Probe";
  readonly description = "Tools that observe their execution context";
  receivedCtx: ToolExecutionContext | undefined;
  ctxWasReceived = false;
  readonly tools: Record<string, ToolDefinition> = {
    // Records whatever ctx it receives (including undefined) and, if `emit`
    // is present, calls it — proving pass-through + a live sink.
    probe: {
      description: "Records the ctx it receives",
      parameters: z.object({ a: z.number() }),
      execute: async (args, ctx) => {
        this.receivedCtx = ctx;
        this.ctxWasReceived = true;
        ctx?.emit?.({ type: "progress", data: { statusText: "probing" } });
        return args;
      },
    },
    // Legacy 1-arg signature — ignores ctx entirely.
    legacy: {
      description: "Ignores any ctx it's given",
      parameters: z.object({ a: z.number() }),
      execute: async (args) => args,
    },
  };
}

describe("Toolbox", () => {
  const toolbox = new MathToolbox();

  describe("getToolSchemas", () => {
    it("returns ToolSchema for each tool", () => {
      const schemas = toolbox.getToolSchemas();
      expect(schemas).toHaveLength(2);
      expect(schemas[0]!.name).toBe("add");
      expect(schemas[0]!.description).toBe("Add two numbers");
      expect(schemas[1]!.name).toBe("multiply");
    });

    it("carries a tool's declared returns schema through, and omits it otherwise", () => {
      const schemas = toolbox.getToolSchemas();
      // `add` declares no returns; `multiply` declares one.
      expect(schemas[0]!.returns).toBeUndefined();
      expect(schemas[1]!.returns).toHaveProperty("type", "object");
    });

    it("carries a tool's terminal flag through, and omits it otherwise", () => {
      class FinishToolbox extends Toolbox {
        readonly name = "Finish";
        readonly description = "Has a terminal tool";
        readonly tools: Record<string, ToolDefinition> = {
          search: {
            description: "Ordinary tool",
            parameters: z.object({ q: z.string() }),
            execute: async (args) => args,
          },
          finish: {
            description: "Ends the loop",
            parameters: z.object({ summary: z.string() }),
            terminal: true,
            execute: async (args) => (args as { summary: string }).summary,
          },
        };
      }
      const schemas = new FinishToolbox().getToolSchemas();
      expect(schemas.find((s) => s.name === "search")!.terminal).toBeUndefined();
      expect(schemas.find((s) => s.name === "finish")!.terminal).toBe(true);
    });
  });

  describe("getToolNames", () => {
    it("returns names of all tools", () => {
      expect(toolbox.getToolNames()).toEqual(["add", "multiply"]);
    });
  });

  describe("execute", () => {
    it("dispatches to correct tool and validates args", async () => {
      const result = await toolbox.execute("add", { a: 3, b: 4 });
      expect(result).toBe(7);
    });

    it("validates args via Zod (rejects invalid)", async () => {
      await expect(toolbox.execute("add", { a: "not a number", b: 4 })).rejects.toThrow();
    });

    it("throws on unknown tool", async () => {
      await expect(toolbox.execute("unknown", {})).rejects.toThrow("Unknown tool: unknown");
    });
  });

  describe("ToolExecutionContext", () => {
    it("forwards the context verbatim, including a live emit sink", async () => {
      const probeToolbox = new ProbeToolbox();
      const emitted: Array<{ type: string; data?: Record<string, unknown> }> = [];
      const ctx: ToolExecutionContext = {
        runId: "run-1",
        traceId: "trace-1",
        parentToolCallId: "call-1",
        emit: (event) => emitted.push(event),
      };

      await probeToolbox.execute("probe", { a: 1 }, ctx);

      expect(probeToolbox.receivedCtx).toBe(ctx);
      expect(probeToolbox.receivedCtx?.runId).toBe("run-1");
      expect(probeToolbox.receivedCtx?.traceId).toBe("trace-1");
      expect(probeToolbox.receivedCtx?.parentToolCallId).toBe("call-1");
      expect(emitted).toEqual([{ type: "progress", data: { statusText: "probing" } }]);
    });

    it("passes undefined when ctx is omitted", async () => {
      const probeToolbox = new ProbeToolbox();

      await probeToolbox.execute("probe", { a: 1 });

      expect(probeToolbox.ctxWasReceived).toBe(true);
      expect(probeToolbox.receivedCtx).toBeUndefined();
    });

    it("still succeeds when a legacy (1-arg) tool is invoked with a context", async () => {
      const probeToolbox = new ProbeToolbox();
      const ctx: ToolExecutionContext = { runId: "run-2" };

      const result = await probeToolbox.execute("legacy", { a: 5 }, ctx);

      expect(result).toEqual({ a: 5 });
    });

    it("gates args via Zod before execute/emit run, even with a context supplied", async () => {
      const probeToolbox = new ProbeToolbox();
      const emitted: unknown[] = [];
      const ctx: ToolExecutionContext = { emit: (event) => emitted.push(event) };

      await expect(probeToolbox.execute("probe", { a: "not a number" }, ctx)).rejects.toThrow();

      expect(probeToolbox.ctxWasReceived).toBe(false);
      expect(emitted).toHaveLength(0);
    });

    it("type-level: legacy and context-aware execute signatures both assign to ToolDefinition", () => {
      const legacyDef: ToolDefinition = {
        description: "legacy",
        parameters: z.object({}),
        execute: async (args) => args,
      };
      const ctxAwareDef: ToolDefinition = {
        description: "ctx-aware",
        parameters: z.object({}),
        execute: async (args, ctx) => {
          ctx?.emit?.({ type: "noop" });
          return args;
        },
      };

      expect(legacyDef.description).toBe("legacy");
      expect(ctxAwareDef.description).toBe("ctx-aware");
    });
  });
});

import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import { Capability, capability } from "../capability.js";
import { TextManual } from "../manual.js";
import { type PlayDefinition, Playbook } from "../playbook.js";
import {
  type ToolDefinition,
  type ToolExecutionContext,
  Toolbox,
  defineTool,
  toolbox,
} from "../toolbox.js";

describe("defineTool", () => {
  it("infers parsed parameter output in execute", async () => {
    const def = defineTool({
      description: "Search with defaulted limit",
      parameters: z.object({ q: z.string(), limit: z.number().default(10) }),
      returns: z.object({ hits: z.array(z.string()) }),
      execute: async (args) => {
        // Post-parse types: the default has been applied by Toolbox.execute.
        expectTypeOf(args.q).toEqualTypeOf<string>();
        expectTypeOf(args.limit).toEqualTypeOf<number>();
        return { hits: [args.q, String(args.limit)] };
      },
    });

    const result = await toolbox("search", "Search tools", { search: def }).execute("search", {
      q: "x",
    });

    expect(result).toEqual({ hits: ["x", "10"] });
  });

  it("returns a plain ToolDefinition", () => {
    const def = defineTool({
      description: "Plain surface",
      parameters: z.object({}),
      returns: z.string(),
      execute: async () => "ok",
    });

    expectTypeOf(def).toEqualTypeOf<ToolDefinition>();
    expect(Object.keys(def).sort()).toEqual(["description", "execute", "parameters", "returns"]);
  });

  it("compile-rejects output outside z.input of the returns schema", () => {
    defineTool({
      description: "Declares string, returns number",
      parameters: z.object({}),
      returns: z.string(),
      // @ts-expect-error — number is not assignable to the declared returns input (string)
      execute: async () => 42,
    });

    defineTool({
      description: "Declares object, returns empty object",
      parameters: z.object({}),
      returns: z.object({ id: z.string() }),
      // @ts-expect-error — result is missing the required `id` property
      execute: async () => ({}),
    });

    expect(true).toBe(true);
  });

  it("validates returns by default and names the tool at the toolbox boundary", async () => {
    const tb = toolbox("meetings", "Meeting tools", {
      list_meetings: defineTool({
        description: "Lists meetings",
        parameters: z.object({}),
        returns: z.object({ meetings: z.array(z.string()) }),
        execute: async () => ({ meetings: [123 as unknown as string] }),
      }),
    });

    const err: unknown = await tb.execute("list_meetings", {}).then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(
      /^tool 'list_meetings' output violated its returns schema:/,
    );
    expect((err as Error).cause).toBeInstanceOf(z.ZodError);
  });

  it("returns the parsed output (transforms, defaults, unknown-key stripping)", async () => {
    const def = defineTool({
      description: "Normalizes its result",
      parameters: z.object({}),
      returns: z.object({
        kept: z.string().transform((s) => s.toUpperCase()),
        stamped: z.string().default("yes"),
      }),
      execute: async () => {
        const out = { kept: "k", extra: "x" };
        return out;
      },
    });

    const result = await toolbox("n", "Normalizing", { norm: def }).execute("norm", {});

    expect(result).toEqual({ kept: "K", stamped: "yes" });
  });

  it("validateReturns false returns the verbatim value", async () => {
    const out = { kept: "k", extra: "x" };
    const def = defineTool({
      description: "Emits verbatim",
      parameters: z.object({}),
      returns: z.object({
        kept: z.string().transform((s) => s.toUpperCase()),
        stamped: z.string().default("yes"),
      }),
      validateReturns: false,
      execute: async () => out,
    });
    const tb = toolbox("v", "Verbatim", { raw: def });

    const result = await tb.execute("raw", {});

    expect(result).toBe(out);
    expect(result).toEqual({ kept: "k", extra: "x" });
    expect(tb.getToolSchemas()[0]!.returns).toHaveProperty("type", "object");
  });

  it("does not reparse parameters", async () => {
    let parseCount = 0;
    const def = defineTool({
      description: "Counts parameter transforms",
      parameters: z.object({
        v: z.string().transform((s) => {
          parseCount += 1;
          return s;
        }),
      }),
      returns: z.string(),
      execute: async ({ v }) => v,
    });

    await toolbox("c", "Counting", { count: def }).execute("count", { v: "hello" });

    expect(parseCount).toBe(1);
  });

  it("forwards ToolExecutionContext by identity", async () => {
    let seen: ToolExecutionContext | undefined;
    const def = defineTool({
      description: "Observes its context",
      parameters: z.object({}),
      returns: z.string(),
      execute: async (_args, ctx) => {
        seen = ctx;
        return "ok";
      },
    });
    const ctx: ToolExecutionContext = { runId: "run-1" };

    await toolbox("p", "Probing", { probe: def }).execute("probe", {}, ctx);

    expect(seen).toBe(ctx);
  });

  it("passes terminal through and preserves omission", () => {
    const term = defineTool({
      description: "Ends the loop",
      parameters: z.object({ summary: z.string() }),
      returns: z.string(),
      terminal: true,
      execute: async ({ summary }) => summary,
    });
    const plain = defineTool({
      description: "Ordinary tool",
      parameters: z.object({}),
      returns: z.string(),
      execute: async () => "ok",
    });

    expect(term.terminal).toBe(true);
    expect("terminal" in plain).toBe(false);

    const schemas = toolbox("t", "Terminal", { term, plain }).getToolSchemas();
    expect(schemas.find((s) => s.name === "term")!.terminal).toBe(true);
    expect(schemas.find((s) => s.name === "plain")!.terminal).toBeUndefined();
  });

  it("passes displayType through and preserves omission", () => {
    const diff = defineTool({
      description: "Edits a file",
      parameters: z.object({ path: z.string() }),
      returns: z.string(),
      displayType: "diff",
      execute: async ({ path }) => path,
    });
    const plain = defineTool({
      description: "Ordinary tool",
      parameters: z.object({}),
      returns: z.string(),
      execute: async () => "ok",
    });

    expect(diff.displayType).toBe("diff");
    expect("displayType" in plain).toBe(false);

    const schemas = toolbox("t", "Render", { diff, plain }).getToolSchemas();
    expect(schemas.find((s) => s.name === "diff")!.displayType).toBe("diff");
    expect(schemas.find((s) => s.name === "plain")!.displayType).toBeUndefined();
  });

  it("does not rewrap ordinary execution errors", async () => {
    const sentinel = new Error("boom");
    const def = defineTool({
      description: "Always throws",
      parameters: z.object({}),
      returns: z.string(),
      execute: async () => {
        throw sentinel;
      },
    });

    const caught: unknown = await toolbox("e", "Erroring", { boom: def })
      .execute("boom", {})
      .then(
        () => null,
        (e: unknown) => e,
      );

    expect(caught).toBe(sentinel);
  });

  it("legacy ToolDefinitions remain unvalidated", async () => {
    const legacy: ToolDefinition = {
      description: "Mismatched returns is metadata only",
      parameters: z.object({}),
      returns: z.object({ n: z.number() }),
      execute: async () => "not an object",
    };

    const result = await toolbox("l", "Legacy", { legacy }).execute("legacy", {});

    expect(result).toBe("not an object");
  });

  it("supports async return refinements", async () => {
    const def = defineTool({
      description: "Async-refined returns",
      parameters: z.object({}),
      returns: z.string().refine(async (s) => s.length > 0),
      execute: async () => "ok",
    });

    // A sync .parse() would throw on the async refinement; parseAsync must not.
    await expect(def.execute({})).resolves.toBe("ok");
  });
});

describe("toolbox()", () => {
  const TOOLS: Record<string, ToolDefinition> = {
    add: defineTool({
      description: "Add two numbers",
      parameters: z.object({ a: z.number(), b: z.number() }),
      returns: z.number(),
      execute: async ({ a, b }) => a + b,
    }),
  };

  class SubclassFixture extends Toolbox {
    readonly name = "fixture";
    readonly description = "Fixture toolbox";
    readonly tools = TOOLS;
  }

  it("creates a Toolbox instance with inherited behavior", async () => {
    const literal = toolbox("fixture", "Fixture toolbox", TOOLS);
    const sub = new SubclassFixture();

    expect(literal).toBeInstanceOf(Toolbox);
    expect(literal.name).toBe("fixture");
    expect(literal.description).toBe("Fixture toolbox");
    expect(literal.tools).toBe(TOOLS);
    expect(literal.getToolNames()).toEqual(sub.getToolNames());
    expect(literal.getToolSchemas().map((s) => s.name)).toEqual(
      sub.getToolSchemas().map((s) => s.name),
    );
    expect(await literal.execute("add", { a: 1, b: 2 })).toEqual(
      await sub.execute("add", { a: 1, b: 2 }),
    );
  });

  it("preserves returns, terminal, and context behavior", async () => {
    let seen: ToolExecutionContext | undefined;
    const literal = toolbox("probe", "Probing toolbox", {
      finish: defineTool({
        description: "Terminal probe",
        parameters: z.object({}),
        returns: z.string(),
        terminal: true,
        execute: async (_args, ctx) => {
          seen = ctx;
          return "done";
        },
      }),
    });
    const ctx: ToolExecutionContext = { runId: "run-2" };

    await literal.execute("finish", {}, ctx);

    expect(seen).toBe(ctx);
    const schema = literal.getToolSchemas()[0]!;
    expect(schema.terminal).toBe(true);
    expect(schema.returns).toBeDefined();
  });
});

describe("capability()", () => {
  class MiniPlaybook extends Playbook {
    readonly name = "mini";
    readonly description = "Mini plays";
    readonly plays: Record<string, PlayDefinition> = {
      summarize: {
        description: "Summarize text",
        parameters: z.object({ text: z.string() }),
        execute: async (args) => ({ summary: String(args.text) }),
      },
    };
  }

  const docsToolbox = toolbox("docs", "Documentation tools", {
    search_docs: defineTool({
      description: "Search documentation",
      parameters: z.object({ query: z.string() }),
      returns: z.array(z.string()),
      execute: async ({ query }) => [query],
    }),
  });

  it("creates a frozen Capability instance with reference identity", () => {
    const manual = new TextManual("docs-manual", "Use search_docs to find documentation.");
    const playbook = new MiniPlaybook();

    const cap = capability({
      name: "documentation",
      description: "Docs capability",
      toolbox: docsToolbox,
      manual,
      playbook,
    });

    expect(cap).toBeInstanceOf(Capability);
    expect(Object.isFrozen(cap)).toBe(true);
    expect(cap.toolbox).toBe(docsToolbox);
    expect(cap.manual).toBe(manual);
    expect(cap.playbook).toBe(playbook);
  });

  it("preserves guidance and combines toolbox/playbook schemas", () => {
    const cap = capability({
      name: "documentation",
      description: "Docs capability",
      toolbox: docsToolbox,
      manual: new TextManual("docs-manual", "Use search_docs to find documentation."),
      playbook: new MiniPlaybook(),
    });

    expect(cap.getGuidance()).toContain("search_docs");
    expect(cap.getTools().map((t) => t.name)).toEqual(["search_docs", "summarize"]);
    expect(cap.toPrompt()).toContain("### documentation");
  });

  it("works without optional manual/playbook", () => {
    const cap = capability({
      name: "bare",
      description: "No guidance",
      toolbox: docsToolbox,
    });

    expect(cap.getGuidance()).toBe("");
    expect(cap.getTools().map((t) => t.name)).toEqual(["search_docs"]);
  });
});

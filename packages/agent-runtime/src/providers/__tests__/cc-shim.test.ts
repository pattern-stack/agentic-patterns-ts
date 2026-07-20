/**
 * Unit tests for the stdio MCP shim scaffolding (`cc-shim.ts`).
 *
 * These exercise the host-side materialization / parking logic — writing the
 * shim script + schema file, resolving the MCP SDK to absolute CJS paths,
 * parking a tool result, and tearing the store dir down. The child process is
 * NOT spawned here (that's covered live); we assert the artifacts the CLI would
 * read.
 */

import { existsSync, readFileSync } from "node:fs";

import type { LanguageModelV2FunctionTool } from "@ai-sdk/provider";
import { afterEach, describe, expect, it } from "vitest";

import {
  CC_SHIM_SOURCE,
  FRAMEWORK_SERVER,
  createShim,
  disposeShim,
  parkResult,
  resolveMcpSdkModules,
  writeShimSchemas,
} from "../cc-shim.js";

const created: string[] = [];
afterEach(() => {
  for (const dir of created) disposeShim(dir);
  created.length = 0;
});

const TOOLS: LanguageModelV2FunctionTool[] = [
  {
    type: "function",
    name: "add",
    description: "Add two numbers",
    inputSchema: {
      type: "object",
      properties: { a: { type: "number" }, b: { type: "number" } },
      required: ["a", "b"],
    },
  },
];

describe("resolveMcpSdkModules", () => {
  it("resolves the MCP SDK CJS entry points to existing absolute files", () => {
    const mods = resolveMcpSdkModules();
    expect(mods.serverModule.endsWith("server/index.js")).toBe(true);
    expect(existsSync(mods.serverModule)).toBe(true);
    expect(existsSync(mods.stdioModule)).toBe(true);
    expect(existsSync(mods.typesModule)).toBe(true);
  });
});

describe("createShim", () => {
  it("materializes the shim script + schema file and a valid stdio server config", () => {
    const shim = createShim(TOOLS, { PATH: process.env.PATH ?? "" });
    created.push(shim.storeDir);

    expect(existsSync(shim.storeDir)).toBe(true);
    expect(existsSync(shim.schemasFile)).toBe(true);

    const server = shim.mcpServers[FRAMEWORK_SERVER];
    expect(server?.type).toBe("stdio");
    expect(server?.command).toBe(process.execPath);
    // alwaysLoad is the poisoned-call guard — startup blocks on connect.
    expect(server?.alwaysLoad).toBe(true);
    // The shim script the child runs, plus its config, are wired via env.
    expect(server?.args?.[0]).toContain(shim.storeDir);
    const cfg = JSON.parse(server?.env?.AP_SHIM_CONFIG ?? "{}");
    expect(cfg.serverName).toBe(FRAMEWORK_SERVER);
    expect(cfg.resultFile).toBe(shim.resultFile);

    expect(shim.allowedTools).toEqual([`mcp__${FRAMEWORK_SERVER}__add`]);

    // The materialized script is the embedded source.
    expect(readFileSync(server?.args?.[0] ?? "", "utf8")).toBe(CC_SHIM_SOURCE);
  });

  it("writes the tools' names + JSON Schemas for the shim to advertise", () => {
    const shim = createShim(TOOLS, {});
    created.push(shim.storeDir);
    const schemas = JSON.parse(readFileSync(shim.schemasFile, "utf8"));
    expect(schemas).toHaveLength(1);
    expect(schemas[0].name).toBe("add");
    expect(schemas[0].inputSchema.required).toEqual(["a", "b"]);
  });
});

describe("writeShimSchemas", () => {
  it("defaults a missing inputSchema to an empty object schema", () => {
    const shim = createShim([], {});
    created.push(shim.storeDir);
    const tool: LanguageModelV2FunctionTool = {
      type: "function",
      name: "noargs",
      description: "",
      inputSchema: undefined as unknown as Record<string, unknown>,
    };
    writeShimSchemas(shim.schemasFile, [tool]);
    const schemas = JSON.parse(readFileSync(shim.schemasFile, "utf8"));
    expect(schemas[0]).toEqual({
      name: "noargs",
      description: "",
      inputSchema: { type: "object", properties: {} },
    });
  });
});

describe("parkResult", () => {
  it("parks a JSON tool result as `{ text }` (verbatim serialization)", () => {
    const shim = createShim(TOOLS, {});
    created.push(shim.storeDir);
    parkResult(shim.resultFile, { type: "json", value: { result: 45 } });
    const parked = JSON.parse(readFileSync(shim.resultFile, "utf8"));
    expect(parked.text).toBe(JSON.stringify({ result: 45 }));
  });

  it("parks a text tool result verbatim", () => {
    const shim = createShim(TOOLS, {});
    created.push(shim.storeDir);
    parkResult(shim.resultFile, { type: "text", value: "hello" });
    expect(JSON.parse(readFileSync(shim.resultFile, "utf8")).text).toBe("hello");
  });
});

describe("disposeShim", () => {
  it("removes the store dir and is idempotent", () => {
    const shim = createShim(TOOLS, {});
    disposeShim(shim.storeDir);
    expect(existsSync(shim.storeDir)).toBe(false);
    expect(() => disposeShim(shim.storeDir)).not.toThrow();
  });
});

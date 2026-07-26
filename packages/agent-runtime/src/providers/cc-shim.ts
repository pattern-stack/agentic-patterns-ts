/**
 * Stdio MCP shim for the Claude Code `deferred_tool_use` session path.
 *
 * The `deferred` session strategy (see `cc-session.ts`) keeps a Claude Code
 * session alive across AgentRunner tool-loop iterations via `options.resume`
 * instead of re-flattening history into a fresh subprocess each turn. That
 * requires the framework tools to be served by a tool surface the CLI can
 * *execute* when a deferred call is resumed — and F-3
 * (`.ai-docs/stacks/harness-runners/f3-deferred-tools.md`) proved that the
 * in-process SDK MCP server is **not** resumable on CLI 2.1.215: its eager
 * availability check races SDK-server registration, so resume yields
 * `tool_deferred_unavailable`. A host-controlled **stdio** MCP server, by
 * contrast, is up before the check runs (`alwaysLoad` blocks startup on
 * connect) and resume executes through it cleanly.
 *
 * So this module spawns one stdio MCP child process per session that:
 *   - advertises the agent's framework tool schemas (so the model forms valid
 *     calls), and
 *   - on `tools/call`, returns the **host-parked** result the provider wrote
 *     between the defer hand-back and the resume — the seam through which the
 *     framework's real tool result reaches the model.
 *
 * The shim never computes anything itself; it is a dumb relay for a result the
 * provider (which ran the framework's `toolExecutor`) already produced.
 *
 * ## Packaging
 *
 * The shim source is materialized to the session's store dir at runtime rather
 * than shipped as a build asset. That sidesteps every dev-vs-dist path problem
 * (vitest runs from `src/`, tsup bundles to `dist/index.js`) — the child is
 * always spawned from a freshly written file. It requires the MCP SDK by the
 * **absolute** CJS paths this module resolves in the parent process, so the
 * child needs no `node_modules` above its tmpdir.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";

import type {
  LanguageModelV4FunctionTool,
  LanguageModelV4ToolResultOutput,
} from "@ai-sdk/provider";
import type { McpStdioServerConfig } from "@anthropic-ai/claude-agent-sdk";

// `import.meta.url` is native under ESM and shimmed by esbuild for the CJS
// build, so this resolves the MCP SDK from the runtime package in both outputs.
const nodeRequire = createRequire(import.meta.url);

/** Name the framework-tool MCP server is registered under. */
export const FRAMEWORK_SERVER = "agent_runner_tools";

/**
 * The shim child-process source. Plain CommonJS, no template literals / `${}`
 * inside, so it embeds cleanly as a string. It reads its wiring from
 * `AP_SHIM_CONFIG` (JSON), requires the MCP SDK by absolute path, and serves
 * the framework schemas + the parked result.
 */
export const CC_SHIM_SOURCE = `"use strict";
const { readFileSync } = require("node:fs");
const cfg = JSON.parse(process.env.AP_SHIM_CONFIG || "{}");
const { Server } = require(cfg.serverModule);
const { StdioServerTransport } = require(cfg.stdioModule);
const { ListToolsRequestSchema, CallToolRequestSchema } = require(cfg.typesModule);

function loadSchemas() {
  try {
    return JSON.parse(readFileSync(cfg.schemasFile, "utf8"));
  } catch (e) {
    return [];
  }
}

function loadParkedResult(name) {
  try {
    const parked = JSON.parse(readFileSync(cfg.resultFile, "utf8"));
    return typeof parked.text === "string" ? parked.text : JSON.stringify(parked);
  } catch (e) {
    return "[ap-cc-shim] no host result parked for " + name;
  }
}

const server = new Server(
  { name: cfg.serverName, version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, function () {
  return Promise.resolve({
    tools: loadSchemas().map(function (t) {
      return {
        name: t.name,
        description: t.description || "",
        inputSchema: t.inputSchema || { type: "object", properties: {} },
      };
    }),
  });
});

server.setRequestHandler(CallToolRequestSchema, function (req) {
  return Promise.resolve({
    content: [{ type: "text", text: loadParkedResult(req.params.name) }],
  });
});

server.connect(new StdioServerTransport());
`;

/** Absolute CJS module paths the spawned shim requires. */
interface McpSdkModules {
  serverModule: string;
  stdioModule: string;
  typesModule: string;
}

/**
 * Resolve the MCP SDK's CJS entry points to absolute paths so the shim (which
 * lives in a tmpdir with no `node_modules` above it) can require them. Throws
 * if the SDK can't be located — the caller degrades to the flatten strategy.
 */
export function resolveMcpSdkModules(): McpSdkModules {
  const pkgJson = nodeRequire.resolve("@modelcontextprotocol/sdk/package.json");
  // The `.../package.json` resolution may land on the CJS sub-package
  // (`dist/cjs/package.json`) or the real root depending on the install's
  // exports. Normalize to the package root either way.
  let root = dirname(pkgJson);
  if (root.endsWith(`${sep}dist${sep}cjs`)) {
    root = dirname(dirname(root));
  }
  return {
    serverModule: join(root, "dist", "cjs", "server", "index.js"),
    stdioModule: join(root, "dist", "cjs", "server", "stdio.js"),
    typesModule: join(root, "dist", "cjs", "types.js"),
  };
}

/** Config the shim reads from `AP_SHIM_CONFIG`. */
interface ShimConfig extends McpSdkModules {
  serverName: string;
  schemasFile: string;
  resultFile: string;
}

/**
 * A materialized shim: its store dir (holding the shim script, the schema
 * file, and the result file the provider parks into) plus the SDK
 * `mcpServers` entry the provider hands to `query()`.
 */
export interface ShimHandle {
  /** Root tmpdir for this session's shim artifacts. */
  readonly storeDir: string;
  /** File the provider writes the parked tool result to before a resume. */
  readonly resultFile: string;
  /** File the framework tool schemas are written to (re-writable per turn). */
  readonly schemasFile: string;
  /** The `{ [FRAMEWORK_SERVER]: config }` map to merge into SDK options. */
  readonly mcpServers: Record<string, McpStdioServerConfig>;
  /** Fully-qualified tool names (`mcp__agent_runner_tools__*`) to allow. */
  readonly allowedTools: string[];
}

/**
 * Create the shim for a session: writes the shim script + schema file into a
 * fresh tmpdir and returns the stdio server config. `alwaysLoad: true` blocks
 * CLI startup until the shim connects (capped 5s) — the poisoned-call guard
 * from F-3: resume must never fire before the serving surface is up, or the
 * deferred state is consumed as `tool_deferred_unavailable`.
 */
export function createShim(
  tools: ReadonlyArray<LanguageModelV4FunctionTool>,
  env: Record<string, string>,
): ShimHandle {
  const modules = resolveMcpSdkModules();
  const storeDir = mkdtempSync(join(tmpdir(), "ap-cc-shim-"));
  const shimScript = join(storeDir, "shim.cjs");
  const schemasFile = join(storeDir, "schemas.json");
  const resultFile = join(storeDir, "result.json");

  writeFileSync(shimScript, CC_SHIM_SOURCE, "utf8");
  writeShimSchemas(schemasFile, tools);

  const config: ShimConfig = {
    ...modules,
    serverName: FRAMEWORK_SERVER,
    schemasFile,
    resultFile,
  };

  const server: McpStdioServerConfig = {
    type: "stdio",
    command: process.execPath,
    args: [shimScript],
    env: { ...env, AP_SHIM_CONFIG: JSON.stringify(config) },
    alwaysLoad: true,
  };

  const allowedTools = tools.map((t) => `mcp__${FRAMEWORK_SERVER}__${t.name}`);

  return {
    storeDir,
    resultFile,
    schemasFile,
    mcpServers: { [FRAMEWORK_SERVER]: server },
    allowedTools,
  };
}

/** Serialize the framework tools' name/description/JSON-Schema for the shim. */
export function writeShimSchemas(
  schemasFile: string,
  tools: ReadonlyArray<LanguageModelV4FunctionTool>,
): void {
  const schemas = tools.map((t) => ({
    name: t.name,
    description: t.description ?? "",
    inputSchema: t.inputSchema ?? { type: "object", properties: {} },
  }));
  writeFileSync(schemasFile, JSON.stringify(schemas), "utf8");
}

/**
 * Park a framework tool result where the shim will serve it on the next
 * resume. Written as `{ text }` so the shim returns it verbatim as the tool's
 * text content (matching the shape F-3 verified reaches the model).
 */
export function parkResult(resultFile: string, output: LanguageModelV4ToolResultOutput): void {
  writeFileSync(resultFile, JSON.stringify({ text: renderToolResultText(output) }), "utf8");
}

/** Flatten a V4 tool-result `output` union into the text the shim serves. */
function renderToolResultText(output: LanguageModelV4ToolResultOutput): string {
  switch (output.type) {
    case "text":
    case "error-text":
      return output.value;
    case "json":
    case "error-json":
      return safeStringify(output.value);
    case "execution-denied":
      return `[tool execution denied${output.reason ? `: ${output.reason}` : ""}]`;
    case "content":
      return output.value
        .map((c) => {
          if (c.type === "text") return c.text;
          if (c.type === "file") return `[file ${c.mediaType}]`;
          return "[custom content]";
        })
        .join("\n");
    default:
      return "";
  }
}

function safeStringify(v: unknown): string {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** Best-effort recursive removal of a shim store dir. Idempotent. */
export function disposeShim(storeDir: string): void {
  try {
    rmSync(storeDir, { recursive: true, force: true });
  } catch {
    // best-effort — the OS reclaims the tmpdir regardless
  }
}

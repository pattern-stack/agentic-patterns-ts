/**
 * SDK Bridge — converts framework capabilities to Claude Agent SDK MCP servers.
 *
 * Mirrors Python: agentic_patterns/core/systems/tools/sdk_bridge.py
 *
 * Each Capability becomes a named MCP server with tools derived from
 * the capability's Toolbox and optional Playbook. The runner wires these
 * servers into the SDK options so Claude Code can call them as
 * `mcp__{server}__{tool}`.
 */

import type { Capability, ToolSchema, Toolbox } from "@agentic-patterns/core";
import { createSdkMcpServer, tool as sdkTool } from "@anthropic-ai/claude-agent-sdk";
import type { ZodObject, ZodRawShape } from "zod";

// ---------------------------------------------------------------------------
// Zod shape extraction
// ---------------------------------------------------------------------------

/**
 * Extract the raw shape from a ZodTypeAny that is actually a ZodObject.
 * The SDK's tool() expects ZodRawShape (e.g. { query: z.string() }),
 * but our Toolbox stores ZodTypeAny. This safely extracts the shape.
 */
function extractShape(schema: unknown): ZodRawShape {
  const obj = schema as ZodObject<ZodRawShape>;
  if (obj && typeof obj === "object" && "shape" in obj) {
    return obj.shape as ZodRawShape;
  }
  // Fallback: empty shape (tool takes no arguments)
  return {};
}

// ---------------------------------------------------------------------------
// Toolbox → SDK MCP tools
// ---------------------------------------------------------------------------

function toolsFromToolbox(toolbox: Toolbox) {
  const sdkTools = [];
  for (const [name, def] of Object.entries(toolbox.tools)) {
    const shape = extractShape(def.parameters);
    sdkTools.push(
      sdkTool(name, def.description, shape, async (args: Record<string, unknown>) => {
        const result = await toolbox.execute(name, args);
        const text = typeof result === "string" ? result : JSON.stringify(result ?? "");
        const isError = typeof result === "object" && result !== null && "error" in result;
        return {
          content: [{ type: "text" as const, text }],
          ...(isError ? { isError: true } : {}),
        };
      }),
    );
  }
  return sdkTools;
}

// ---------------------------------------------------------------------------
// Capability → server
// ---------------------------------------------------------------------------

function toSnake(name: string): string {
  return name
    .replace(/[\s\-]+/g, "_")
    .replace(/^_|_$/g, "")
    .toLowerCase();
}

export function buildCapabilityServer(capability: Capability) {
  const serverName = toSnake(capability.name);
  const sdkTools = toolsFromToolbox(capability.toolbox);

  // Add playbook plays as SDK tools if present
  if (capability.playbook) {
    for (const [name, def] of Object.entries(capability.playbook.plays)) {
      const shape = extractShape(def.parameters);
      const playbook = capability.playbook;
      sdkTools.push(
        sdkTool(name, def.description, shape, async (args: Record<string, unknown>) => {
          const result = await playbook.execute(name, args);
          const text = typeof result === "string" ? result : JSON.stringify(result ?? "");
          const isError = typeof result === "object" && result !== null && "error" in result;
          return {
            content: [{ type: "text" as const, text }],
            ...(isError ? { isError: true } : {}),
          };
        }),
      );
    }
  }

  const serverConfig = createSdkMcpServer({
    name: serverName,
    tools: sdkTools,
  });

  const allowedTools = sdkTools.map((t: { name: string }) => `mcp__${serverName}__${t.name}`);
  return { serverName, serverConfig, allowedTools };
}

// ---------------------------------------------------------------------------
// Agent → all servers
// ---------------------------------------------------------------------------

export interface AgentLikeForBridge {
  readonly role: {
    readonly name: string;
    readonly capabilities: ReadonlyArray<Capability>;
  };
  getModel(): string;
  getTools(): ToolSchema[];
  renderInitialPrompt(): string;
}

export function buildAgentServers(agent: AgentLikeForBridge) {
  const mcpServers: Record<string, unknown> = {};
  const allowedTools: string[] = [];

  for (const cap of agent.role.capabilities) {
    const { serverName, serverConfig, allowedTools: tools } = buildCapabilityServer(cap);
    mcpServers[serverName] = serverConfig;
    allowedTools.push(...tools);
  }

  return { mcpServers, allowedTools };
}

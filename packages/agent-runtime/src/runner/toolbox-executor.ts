/**
 * ToolboxExecutor — adapts an agent's Capability toolboxes into the
 * ToolExecutor interface that AgentRunner needs to actually execute
 * tool calls.
 *
 * Without this, AgentRunner can FORMAT tool schemas for the LLM but
 * can't EXECUTE them — tool calls silently return
 * "No tool executor configured".
 */

import type { ToolExecutor } from "./types.js";

/** Minimal shape — matches what Agent.role.capabilities[].toolbox exposes. */
interface ToolboxLike {
  readonly name: string;
  execute(name: string, args: unknown): Promise<unknown>;
  readonly tools: Record<string, { execute: (args: Record<string, unknown>) => Promise<unknown> }>;
}

/** Minimal shape — matches what Agent.role.capabilities[] exposes. */
interface CapabilityLike {
  readonly toolbox: ToolboxLike;
}

/** Minimal shape — matches what Agent.role exposes. */
interface AgentWithCapabilities {
  readonly role: {
    readonly name: string;
    readonly capabilities?: readonly CapabilityLike[];
  };
}

/**
 * Build a `ToolExecutor` from an agent's capability toolboxes.
 *
 * Iterates the agent's capabilities, indexes every tool by name, and
 * dispatches `execute(name, args)` to the owning toolbox. Handles the
 * `mcp__<toolbox>__<tool>` naming convention that MCP-bridged tools use.
 */
export function createToolboxExecutor(agent: AgentWithCapabilities): ToolExecutor {
  // Build a lookup: toolName → toolbox.execute
  const lookup = new Map<string, ToolboxLike>();
  const capabilities = agent.role.capabilities ?? [];

  for (const cap of capabilities) {
    const tb = cap.toolbox;
    for (const toolName of Object.keys(tb.tools)) {
      // Register under plain name
      lookup.set(toolName, tb);
      // Also register under MCP-prefixed name (mcp__<toolbox>__<tool>)
      lookup.set(`mcp__${tb.name}__${toolName}`, tb);
    }
  }

  return {
    async execute(name: string, args: Record<string, unknown>): Promise<unknown> {
      // Try exact match first
      const tb = lookup.get(name);
      if (tb) {
        // Strip MCP prefix to get the actual tool name the toolbox expects
        const actualName = name.includes("__")
          ? name.split("__").pop()!
          : name;
        return tb.execute(actualName, args);
      }
      throw new Error(
        `Tool "${name}" not found. Available: ${[...lookup.keys()].join(", ")}`,
      );
    },
  };
}

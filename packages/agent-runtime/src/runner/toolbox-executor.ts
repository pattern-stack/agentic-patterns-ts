/**
 * ToolboxExecutor — adapts an agent's Capability toolboxes and playbooks into
 * the ToolExecutor interface that AgentRunner needs to actually execute
 * tool calls.
 *
 * Without this, AgentRunner can FORMAT tool schemas for the LLM but
 * can't EXECUTE them — tool calls silently return
 * "No tool executor configured".
 *
 * Both Toolbox tools and Playbook plays are advertised to the model via
 * `Capability.getTools()`, so the executor must be able to dispatch both:
 *   - tool calls  → `toolbox.execute(name, args)` (may throw)
 *   - play calls   → `playbook.execute(name, args)` (returns an `{ error }`
 *                    envelope rather than throwing — see `playbook.ts`)
 *
 * Routing plays through `playbook.execute` is the point: it keeps a
 * malformed/failing play call from aborting the runner loop (ADR 0002 D3).
 * This mirrors the play-routing the SDK-bridge path already does in
 * `sdk-bridge.ts` `buildCapabilityServer`.
 *
 * Collision rule: if a play and a tool share a name within the same agent,
 * the **toolbox tool wins** — `execute()` checks `toolLookup` before
 * `playLookup`, so the play is shadowed. This keeps the existing toolbox
 * path provably unchanged and is deterministic regardless of capability
 * order. (Cross-capability collisions — two capabilities each exposing a
 * same-named tool, or each a same-named play — inherit the existing flat-map
 * last-writer-wins semantics; only intra-agent tool-vs-play precedence is
 * newly defined here.)
 */

import type { ToolExecutor } from "./types.js";

/** Minimal shape — matches what Agent.role.capabilities[].toolbox exposes. */
interface ToolboxLike {
  readonly name: string;
  execute(name: string, args: unknown): Promise<unknown>;
  readonly tools: Record<string, { execute: (args: Record<string, unknown>) => Promise<unknown> }>;
}

/** Minimal shape — matches what Capability.playbook exposes. */
interface PlaybookLike {
  readonly name: string;
  readonly plays: Record<string, unknown>; // keys are play names
  execute(name: string, args: unknown): Promise<unknown>; // returns result | { error }
}

/** Minimal shape — matches what Agent.role.capabilities[] exposes. */
interface CapabilityLike {
  readonly name: string;
  readonly toolbox: ToolboxLike;
  readonly playbook?: PlaybookLike;
}

/** Minimal shape — matches what Agent.role exposes. */
interface AgentWithCapabilities {
  readonly role: {
    readonly name: string;
    readonly capabilities?: readonly CapabilityLike[];
  };
}

/**
 * Derive the MCP server name a capability is registered under.
 * Mirrors `sdk-bridge.ts`'s `toSnake` (not exported there; three lines, so
 * duplicated rather than widening the runner's public surface for this fix).
 */
function toSnake(name: string): string {
  return name
    .replace(/[\s\-]+/g, "_")
    .replace(/^_|_$/g, "")
    .toLowerCase();
}

/** Strip an `mcp__<server>__<name>` prefix down to the bare name. */
function stripPrefix(name: string): string {
  return name.includes("__") ? name.split("__").pop()! : name;
}

/**
 * Build a `ToolExecutor` from an agent's capability toolboxes and playbooks.
 *
 * Iterates the agent's capabilities and builds two parallel lookups:
 *   - `toolLookup`  — every toolbox tool, keyed by its plain name and by
 *                     `mcp__<toolbox>__<tool>` (the toolbox object's name).
 *   - `playLookup`  — every playbook play, keyed by its plain name and by
 *                     `mcp__<toSnake(capability.name)>__<play>` (the
 *                     capability-derived server name the SDK path advertises).
 *
 * In `execute()`, the prefix is stripped and the call is delegated to the
 * owning toolbox or playbook. Toolbox tools win on name collision.
 */
export function createToolboxExecutor(agent: AgentWithCapabilities): ToolExecutor {
  const toolLookup = new Map<string, ToolboxLike>();
  const playLookup = new Map<string, PlaybookLike>();
  const capabilities = agent.role.capabilities ?? [];

  for (const cap of capabilities) {
    const tb = cap.toolbox;
    for (const toolName of Object.keys(tb.tools)) {
      // Register under plain name
      toolLookup.set(toolName, tb);
      // Also register under MCP-prefixed name (mcp__<toolbox>__<tool>)
      toolLookup.set(`mcp__${tb.name}__${toolName}`, tb);
    }

    const pb = cap.playbook;
    if (pb) {
      const serverName = toSnake(cap.name);
      for (const playName of Object.keys(pb.plays)) {
        // Register under plain name
        playLookup.set(playName, pb);
        // Also under the capability-derived MCP name the SDK path advertises
        playLookup.set(`mcp__${serverName}__${playName}`, pb);
      }
    }
  }

  return {
    async execute(name: string, args: Record<string, unknown>): Promise<unknown> {
      // Toolbox tools win on name collision — check toolLookup first.
      const tb = toolLookup.get(name);
      if (tb) {
        return tb.execute(stripPrefix(name), args);
      }
      // Plays route through playbook.execute, which returns an { error }
      // envelope rather than throwing.
      const pb = playLookup.get(name);
      if (pb) {
        return pb.execute(stripPrefix(name), args);
      }
      const available = [...toolLookup.keys(), ...playLookup.keys()].join(", ");
      throw new Error(`Tool "${name}" not found. Available: ${available}`);
    },
  };
}

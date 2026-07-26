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
 * malformed/failing play call from aborting the runner loop (see
 * `.ai-docs/specs/playbook-authoring-parity.md` D1 — the never-throw
 * guarantee this depends on has no ADR of its own).
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

import type { ToolExecutionContext } from "@agentic-patterns/core";
import type { AgentLike, ToolExecutor } from "./types.js";

/** Minimal shape — matches what Agent.role.capabilities[].toolbox exposes. */
interface ToolboxLike {
  readonly name: string;
  execute(name: string, args: unknown, ctx?: ToolExecutionContext): Promise<unknown>;
  readonly tools: Record<
    string,
    { execute: (args: Record<string, unknown>, ctx?: ToolExecutionContext) => Promise<unknown> }
  >;
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
    async execute(
      name: string,
      args: Record<string, unknown>,
      ctx?: ToolExecutionContext,
    ): Promise<unknown> {
      // Toolbox tools win on name collision — check toolLookup first.
      const tb = toolLookup.get(name);
      if (tb) {
        return tb.execute(stripPrefix(name), args, ctx);
      }
      // Plays route through playbook.execute, which returns an { error }
      // envelope rather than throwing. Plays are NOT threaded a ctx — #99
      // scoped Playbook.execute OUT (see file docstring).
      const pb = playLookup.get(name);
      if (pb) {
        return pb.execute(stripPrefix(name), args);
      }
      const available = [...toolLookup.keys(), ...playLookup.keys()].join(", ");
      throw new Error(`Tool "${name}" not found. Available: ${available}`);
    },
  };
}

/**
 * Structural capabilities probe — `true` iff `agent.role.capabilities` is a
 * non-empty array. Deliberately STRUCTURAL, never `instanceof Agent`: this repo
 * runs a known dual-core where two copies of the `Agent` class can coexist
 * across the package boundary, so an `instanceof` check would spuriously fail.
 * Any `AgentLike` whose role carries capabilities qualifies.
 */
function agentHasCapabilities(agent: AgentLike): boolean {
  const caps = (agent as AgentWithCapabilities).role?.capabilities;
  return Array.isArray(caps) && caps.length > 0;
}

/**
 * Derive a {@link ToolExecutor} for an agent's OWN capabilities, or `undefined`
 * when it has none.
 *
 * This is the "an agent's tools are its own capabilities" rule (the same one
 * `CoordinatorStep` applies by hand). A node running an agent needs an executor
 * for THAT agent's tools — and that executor is a pure function of the agent,
 * NOT ambient run state to forward. Unlike scratchpad / deps / trace (which the
 * agent-as-tool seam must FORWARD parent→child because they can't be
 * reconstructed — see `node-tool.ts`, #99/#102/#124), a subagent's executor
 * must be DERIVED per-agent: forwarding the parent's would wrongly expose the
 * parent's tools instead of the subagent's own. That is precisely why
 * `nodeTool` does not forward `toolExecutor`; the leaf derives it instead.
 *
 * Returning `undefined` for a capability-less agent keeps the no-tools path
 * byte-identical: the caller leaves `RunOptions.toolExecutor` unset, exactly as
 * before (a tool-less agent can never emit a tool call anyway).
 */
export function deriveToolboxExecutor(agent: AgentLike): ToolExecutor | undefined {
  return agentHasCapabilities(agent)
    ? createToolboxExecutor(agent as AgentWithCapabilities)
    : undefined;
}

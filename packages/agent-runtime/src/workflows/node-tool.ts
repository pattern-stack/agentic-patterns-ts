/**
 * Agent-as-a-tool — expose a typed workflow `Node` as a callable tool so a
 * coordinator agent can invoke a whole sub-workflow (or a single agent wrapped
 * as an `AgentStep`) and get its typed output back INLINE. This is ADK's
 * `AgentTool` / "hierarchical decomposition" pattern on our primitives.
 *
 * Call-and-return semantics: the coordinator CALLS the node, receives its
 * result, and stays in control of the conversation. This is deliberately NOT a
 * conversational handoff/transfer (where the sub-agent takes over the turn) —
 * that is a separate, heavier Conversation-level construct.
 */
import { type ToolDefinition, Toolbox } from "@agentic-patterns/core";
import { type ZodType, type ZodTypeAny, z } from "zod";
import type { AgentLike } from "../runner/agent-runner.js";
import type { RunnerProtocol } from "../runner/types.js";
import { AgentStep } from "./agent-step.js";
import type { DepReader } from "./deps.js";
import type { Node } from "./node.js";
import { type Scratchpad, createScratchpad } from "./slot.js";

/** One `Node` exposed as a tool. `parameters` IS the node's input schema (TIn). */
export interface NodeToolSpec<TIn> {
  readonly description: string;
  readonly parameters: ZodType<TIn>;
  readonly node: Node<TIn, unknown>;
  /** Optional output schema — for introspection / a tool workbench `Returns` block. */
  readonly returns?: ZodTypeAny;
}

/**
 * Build a single node-backed `ToolDefinition` you can mix into any `Toolbox`.
 * On success returns the node's typed `output`; on a failed node it returns
 * `{ error }` (rather than throwing) so the calling LLM can react instead of
 * silently losing the call — consistent with leaf-never-throws.
 */
export function nodeTool<TIn>(
  spec: NodeToolSpec<TIn>,
  runner: RunnerProtocol,
  scratchpad?: Scratchpad,
  /**
   * Explicit dependency injection for the wrapped node. `nodeTool` re-roots
   * the context (it's a root builder, not a spread site), so parent deps do
   * NOT automatically flow across this tool-execution boundary — pass them
   * here if the wrapped node needs them. Automatic parent→child propagation
   * across the agent-as-tool seam is scoped to #99/#102.
   */
  deps?: DepReader,
): ToolDefinition {
  return {
    description: spec.description,
    parameters: spec.parameters,
    returns: spec.returns,
    execute: async (args: Record<string, unknown>) => {
      const input = spec.parameters.parse(args);
      const result = await spec.node.run(input, {
        runner,
        scratchpad: scratchpad ?? createScratchpad(),
        deps,
      });
      if (!result.succeeded) {
        return { error: result.error?.message ?? "sub-workflow failed" };
      }
      return result.output;
    },
  };
}

/**
 * A `Toolbox` that exposes one or more workflow `Node`s as callable tools — the
 * "agent-as-a-tool" surface for a coordinator. Give it to a coordinator agent
 * as a Capability; when the coordinator's LLM calls a tool, the wrapped node
 * runs to completion and its output is returned inline as the tool result.
 *
 * Typically constructed with the SAME runner that runs the coordinator, so the
 * sub-workflows execute on the same model/gate/event plumbing.
 */
export class NodeToolbox extends Toolbox {
  readonly name: string;
  readonly description: string;
  readonly tools: Record<string, ToolDefinition>;

  constructor(opts: {
    name: string;
    description: string;
    runner: RunnerProtocol;
    /** Shared slot store across calls; a fresh one is minted per call when omitted. */
    scratchpad?: Scratchpad;
    /** Explicit dependency injection forwarded to every wrapped node's `nodeTool()` call. */
    deps?: DepReader;
    // biome-ignore lint/suspicious/noExplicitAny: heterogeneous tool registry (per-tool typed at the spec)
    tools: Record<string, NodeToolSpec<any>>;
  }) {
    super();
    this.name = opts.name;
    this.description = opts.description;
    this.tools = Object.fromEntries(
      Object.entries(opts.tools).map(([toolName, spec]) => [
        toolName,
        nodeTool(spec, opts.runner, opts.scratchpad, opts.deps),
      ]),
    );
  }
}

// ---------------------------------------------------------------------------
// delegateTo — the "just pass subagents" sugar (ADK sub_agents=[...] ergonomic)
// ---------------------------------------------------------------------------

/** One subagent to hand a coordinator. */
export interface SubagentSpec {
  readonly agent: AgentLike;
  /**
   * Routing signal for the coordinator's LLM. ADK's rule: a subagent's
   * description IS its API documentation for the router — be specific.
   */
  readonly description: string;
  /** Tool name the coordinator calls (defaults to the agent's role name). */
  readonly name?: string;
  /** Optional structured output schema; omit for a free-text answer. */
  readonly output?: ZodType<unknown>;
}

/**
 * "Just pass subagents" — the ADK `sub_agents=[...]` ergonomic on our
 * primitives. Wraps each subagent as a call-and-return tool (one tool per
 * agent: name = agent name, description = routing signal, input = `{ task }`,
 * output = the agent's answer) and returns a {@link NodeToolbox} the
 * coordinator carries as a Capability. The coordinator's LLM routes by CALLING
 * the right subagent and gets its answer back — it stays in control (Mode A,
 * call-and-return; NOT a conversational handoff).
 *
 * For a subagent that is a typed WORKFLOW rather than a single agent, use
 * {@link NodeToolbox} directly with the workflow's own input schema.
 */
export function delegateTo(
  runner: RunnerProtocol,
  subagents: ReadonlyArray<SubagentSpec>,
  opts?: { name?: string; description?: string; scratchpad?: Scratchpad; deps?: DepReader },
): NodeToolbox {
  const tools: Record<string, NodeToolSpec<{ task: string }>> = {};
  for (const sub of subagents) {
    const toolName = sub.name ?? sub.agent.role.name;
    tools[toolName] = {
      description: sub.description,
      parameters: z.object({
        task: z.string().describe("the task or question to hand to this specialist"),
      }),
      node: new AgentStep<{ task: string }, unknown>({
        name: toolName,
        agent: sub.agent,
        output: sub.output,
        prompt: (input) => input.task,
      }),
    };
  }
  return new NodeToolbox({
    name: opts?.name ?? "team",
    description: opts?.description ?? "Delegate a task to the right specialist subagent.",
    runner,
    scratchpad: opts?.scratchpad,
    deps: opts?.deps,
    tools,
  });
}

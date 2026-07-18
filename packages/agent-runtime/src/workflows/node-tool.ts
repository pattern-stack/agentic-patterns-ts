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
import { type ToolDefinition, type ToolExecutionContext, Toolbox } from "@agentic-patterns/core";
import { type ZodType, type ZodTypeAny, z } from "zod";
import type { AgentEventBus } from "../events/agent-event-bus.js";
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
   * Explicit dependency injection for the wrapped node. Fallback when the
   * live caller context carries no `host.deps` (e.g. no `host` at all, or a
   * host that only threads scratchpad) — see the `host` narrowing below.
   */
  deps?: DepReader,
): ToolDefinition {
  return {
    description: spec.description,
    parameters: spec.parameters,
    returns: spec.returns,
    execute: async (args: Record<string, unknown>, ctx?: ToolExecutionContext) => {
      const input = spec.parameters.parse(args);
      // #124: prefer the LIVE caller context (delivered via the host passthrough)
      // over the construction-time closure. FORK, don't alias: run-scoped slots
      // share through the fork; branch-scoped slots stay isolated per (possibly
      // parallel) tool call. join()/merge-back is OFF for v1.
      const host = ctx?.host as
        | {
            scratchpad?: Scratchpad;
            deps?: DepReader;
            eventBus?: AgentEventBus;
            scope?: Record<string, unknown>;
          }
        | undefined;
      const result = await spec.node.run(input, {
        runner,
        scratchpad: host?.scratchpad ? host.scratchpad.fork() : (scratchpad ?? createScratchpad()),
        deps: host?.deps ?? deps,
        // The run's event bus crosses the seam too — without it, a sub-run on a
        // construction-time runner publishes agent.* events to that runner's
        // constructor-bound (or global-default) bus, invisible to the session.
        eventBus: host?.eventBus,
        // Scope crosses the seam too (#308 D1) — without this, a nested
        // AgentStep/agent-as-tool sub-run loses the parent's session scope.
        scope: host?.scope,
        // #102: join the parent trace and nest under the invoking call's span
        // so this sub-workflow's tool activity is attributable, not orphaned.
        traceId: ctx?.traceId,
        parentSpanId: ctx?.parentToolCallId,
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
  /**
   * Per-subagent execution budget/binding forwarded into the wrapped
   * {@link AgentStep} — the seam that makes a coordinator host's per-step
   * budget table (model + iteration caps) bind to delegated subagents.
   * Without it these are silently the runner defaults. Fields map 1:1 onto
   * {@link AgentStepSpec}: `model` (per-step model override via
   * `applyStepModel`), `maxIterations` (forwarded into `RunOptions`), and
   * `runner` (per-node runner override, `spec.runner ?? ctx.runner`).
   * (Per-subagent timeout is NOT forwardable today — no `RunOptions.timeout`
   * plumbing exists; see the PR follow-up note.)
   */
  readonly runOptions?: {
    readonly model?: string;
    readonly maxIterations?: number;
    readonly runner?: RunnerProtocol;
  };
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
        // Per-subagent budget/binding: bind the coordinator host's per-step
        // budget table onto the wrapped AgentStep. Left undefined when the
        // spec carries no runOptions → runner defaults, unchanged behavior.
        model: sub.runOptions?.model,
        maxIterations: sub.runOptions?.maxIterations,
        runner: sub.runOptions?.runner,
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

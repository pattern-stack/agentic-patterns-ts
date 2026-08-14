/**
 * `CoordinatorStep<TIn, TOut>` — a model-driven coordinator as a `Node` leaf.
 *
 * A Coordinator is THE agent the user works with (e.g. "CanvasAuthor"); its
 * subagents are how that one agent decomposes its own responsibility, sealed
 * behind a single identity. So a coordinator is a *leaf* in the Node algebra —
 * a black box `TIn -> TOut` — even though it routes among children internally.
 * The engine never iterates those children; the LLM does, dynamically, via
 * tool calls. This is the unification: "ADK unifies on Agent; we unify on Node."
 * Because a `CoordinatorStep` is a `Node`, it nests anywhere — a stage of a
 * `Sequential`, a branch of a `FanOut`, or a sub-tool of ANOTHER coordinator.
 *
 * It owns exactly one thing `AgentStep` doesn't: wiring a {@link NodeToolbox}
 * team into the coordinator agent so the team is BOTH advertised to the model
 * (via `getTools()` / the rendered Capabilities section) AND executable (via the
 * derived `ToolExecutor`). Everything else — the `runStructured` typed path,
 * leaf-never-throws, trace threading — is delegated to {@link AgentStep}, so
 * there is a single structured-output code path.
 */

import { Agent, Capability, Role } from "@pattern-stack/agentic-core";
import type { ZodType } from "zod";
import { createToolboxExecutor } from "../runner/toolbox-executor.js";
import type { RunnerProtocol } from "../runner/types.js";
import { AgentStep } from "./agent-step.js";
import type { NodeToolbox } from "./node-tool.js";
import type { Node, NodeResult, NodeRunContext } from "./node.js";
import type { ScratchpadReader } from "./slot.js";

// ---------------------------------------------------------------------------
// withTeamCapability
// ---------------------------------------------------------------------------

/**
 * Return a NEW {@link Agent} that carries `team` as an additional
 * {@link Capability}. Rebuilding through core (rather than decorating the
 * minimal `AgentLike`) keeps all three channels consistent: the model SEES the
 * team in its rendered Capabilities section, `getTools()` ADVERTISES the team's
 * tool schemas, and `createToolboxExecutor` can DISPATCH them — from one source
 * of truth. Any capabilities the coordinator already had are preserved, so a
 * coordinator may hold its own direct tools alongside its team.
 *
 * Requires a core `Agent` (not the minimal `AgentLike`): a coordinator is the
 * full agent the user works with, and the rebuild needs its real `Role`.
 */
export function withTeamCapability(agent: Agent, team: NodeToolbox): Agent {
  const teamCap = new Capability(team.name, team.description, team);
  const role = agent.role;
  const newRole = new Role({
    name: role.name,
    persona: role.persona,
    judgments: [...role.judgments],
    capabilities: [...role.capabilities, teamCap],
    responsibilities: [...role.responsibilities],
    defaultModel: role.defaultModel,
  });
  return new Agent({
    role: newRole,
    background: agent.background,
    awareness: agent.awareness,
    mission: agent.mission,
    model: agent.getModel(),
  });
}

// ---------------------------------------------------------------------------
// Spec
// ---------------------------------------------------------------------------

export interface CoordinatorStepSpec<TIn, TOut> {
  readonly name?: string;

  /**
   * The router persona — the user-facing agent identity. A full core `Agent`
   * (e.g. built from `coordinatorRole()`), because the team is wired into its
   * `Role`. May already carry its own capabilities; they are preserved.
   */
  readonly agent: Agent;

  /**
   * The hidden team this coordinator decomposes into — sub-nodes exposed as
   * call-and-return tools (build with {@link delegateTo} or {@link NodeToolbox}
   * directly for typed sub-workflows). The model routes by CALLING these.
   */
  readonly team: NodeToolbox;

  /**
   * Output schema → `runner.runStructured`. A coordinator ALWAYS returns a typed
   * result (that is its contract to whatever called it); `z.string()` is allowed
   * for a free-text coordinator but the typed object is the norm.
   */
  readonly output: ZodType<TOut>;

  /** Typed prompt builder — receives the input and a read-only scratchpad view. */
  readonly prompt: (input: TIn, scratchpad: ScratchpadReader) => string;

  /** Per-step model override. Defaults to the agent's model. */
  readonly model?: string;

  /** Per-node runner override (#116). Forwarded into the internal `AgentStep` leaf. */
  readonly runner?: RunnerProtocol;

  /** Tool-loop budget for the routing turns. */
  readonly maxIterations?: number;
}

// ---------------------------------------------------------------------------
// CoordinatorStep
// ---------------------------------------------------------------------------

export class CoordinatorStep<TIn, TOut> implements Node<TIn, TOut> {
  readonly name?: string;

  constructor(private readonly spec: CoordinatorStepSpec<TIn, TOut>) {
    this.name = spec.name;
  }

  async run(input: TIn, ctx: NodeRunContext): Promise<NodeResult<TOut>> {
    // Wire the team into the coordinator agent (advertise) and derive the
    // matching executor (dispatch). The derived executor covers ALL of the
    // rebuilt agent's capabilities — the team plus any direct tools it already
    // had — so it REPLACES the ambient ctx.toolExecutor, which is the right
    // mental model: a coordinator's tools are its own capabilities.
    const agent = withTeamCapability(this.spec.agent, this.spec.team);
    const toolExecutor = createToolboxExecutor(agent);

    // Delegate to AgentStep's structured path — one runStructured code path,
    // leaf-never-throws, and trace threading all inherited.
    const leaf = new AgentStep<TIn, TOut>({
      name: this.spec.name,
      agent,
      output: this.spec.output,
      prompt: this.spec.prompt,
      model: this.spec.model,
      runner: this.spec.runner,
      maxIterations: this.spec.maxIterations,
    });
    return leaf.run(input, { ...ctx, toolExecutor });
  }
}

/**
 * `sequentialAgents()` — AGENTS in sequence over an implicitly shared Scratchpad
 * (DESIGN §6.2 companion; the ADK `SequentialAgent` parity primitive).
 *
 * `Sequential` chains NODES with typed output→input seams — which means every
 * agent must be hand-seated in an `AgentStep` (prompt builder in, wiring out).
 * That seat ceremony is exactly what consumers kept re-writing per phase. This
 * primitive is the marriage of the two existing halves:
 *
 *   agents (AgentLike)  ×  Scratchpad (the shared state)  →  a pipeline Node
 *
 * SEMANTICS
 *  - The Scratchpad IS the implicitly passed context layer: each stage's
 *    emission lands in a slot (auto-created per stage, or a caller-provided
 *    one), and every LATER stage's prompt is rendered from the pipeline input
 *    plus ALL prior emissions — no hand-threading, ADK-style "the next agent
 *    sees what happened". A stage may override `prompt` to render a WINDOWED
 *    view instead (large payloads should live in slots its `tail` writes).
 *  - Because slots are run-scoped, the same sharing holds across `Loop`
 *    iterations for free: `Loop({ body: sequentialAgents([...]) })` re-enters
 *    with the pad intact. (Subagent teams — `delegateTo` — do NOT see the pad
 *    yet; opt-in sharing there is a declared follow-up.)
 *  - `output` (zod) per stage is OPTIONAL: structured stages emit through
 *    `runStructured`, bare stages take the raw-text path. Per-agent
 *    InputShape/OutputShape mapping across the sequence is a declared
 *    fast-follow (open: a shape may not exist on every INSTANCE of an agent).
 *  - `stop` turns an emission into a short-circuit: later stages are skipped
 *    and the result carries `{ stage, reason }` — the control plane. `tail`
 *    (the fused deterministic follow-through of a stage's decision) may also
 *    stop by RETURNING a reason string.
 *  - Tool-using stages just work: the executor is created per stage from the
 *    agent's own capabilities (`createToolboxExecutor`) — the classic
 *    forgotten-executor failure cannot happen inside a sequence.
 *  - Declared `reads`/`writes` get a build-time write-before-read assert, so
 *    re-ordering stages is a construction error, not a silent empty run.
 *
 * The built object implements {@link Node}, so it nests anywhere a node is
 * accepted (a Sequential stage, a Loop body, a FanOut branch, a sub-tool).
 */

import type { ZodType } from "zod";
import type { AgentLike } from "../runner/agent-runner.js";
import { createToolboxExecutor } from "../runner/toolbox-executor.js";
import { AgentStep } from "./agent-step.js";
import type { Node, NodeResult, NodeRunContext } from "./node.js";
import {
  createScratchpad,
  slot,
  type ScratchpadAccess,
  type ScratchpadReader,
  type Slot,
} from "./slot.js";

// ---------------------------------------------------------------------------
// Spec
// ---------------------------------------------------------------------------

/** One seated stage. A bare `AgentLike` is accepted wherever a spec is (all defaults). */
export interface AgentStageSpec<TOut = unknown> {
  readonly agent: AgentLike;
  /** Stage name = the emission's slot key + the progress label. Default: the agent's role name. */
  readonly name?: string;
  /** Structured emission schema → `runStructured`. Omit for the raw-text path. */
  readonly output?: ZodType<TOut>;
  /**
   * Override the implicit state render for THIS stage's user message. Default:
   * the pipeline input + every prior stage's emission (see `renderSharedState`).
   */
  readonly prompt?: (state: ScratchpadReader, input: unknown) => string;
  /** Where the emission lands. Default: an auto slot keyed `agents.<name>`. */
  readonly slot?: Slot<TOut | null>;
  /**
   * The stage's fused deterministic tail — code that REALIZES the agent's
   * decision (writes derived slots, executes the read, enforces floors). May
   * return a string to STOP the sequence with that reason.
   */
  readonly tail?: (
    output: TOut,
    pad: ScratchpadAccess,
    ctx: NodeRunContext,
  ) => void | string | Promise<void | string>;
  /** Emission-level stop rule (clarify/refuse lanes): a string stops the sequence. */
  readonly stop?: (output: TOut, state: ScratchpadReader) => string | null;
  /** Tool/2-tier loop cap for this stage (AgentStep semantics). */
  readonly maxIterations?: number;
  /** Optional slot-dependency declarations → build-time write-before-read assert. */
  readonly reads?: ReadonlyArray<{ readonly key: string }>;
  /** Extra slots this stage's tail writes (the emission slot is declared automatically). */
  readonly writes?: ReadonlyArray<{ readonly key: string }>;
}

export type AgentStage = AgentLike | AgentStageSpec;

export interface SequentialAgentsOpts {
  readonly name?: string;
  /**
   * The implicit state render used for stages without a custom `prompt`.
   * Default: {@link renderSharedState}.
   */
  readonly render?: (input: unknown, completed: ReadonlyArray<CompletedStage>) => string;
}

/** One completed stage's contribution to the shared context render. */
export interface CompletedStage {
  readonly name: string;
  readonly output: unknown;
}

export interface SequentialAgentsResult {
  /** Every completed stage's emission, by stage name. */
  readonly outputs: Record<string, unknown>;
  /** Set when a stage's `stop`/`tail` short-circuited the sequence. */
  readonly stopped: { readonly stage: string; readonly reason: string } | null;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/** The default implicit render: the task + every prior emission, ADK-session style. */
export function renderSharedState(
  input: unknown,
  completed: ReadonlyArray<CompletedStage>,
): string {
  const task = typeof input === "string" ? input : JSON.stringify(input, null, 1);
  if (completed.length === 0) return task;
  const sections = completed.map(
    (c) =>
      `## ${c.name}\n${typeof c.output === "string" ? c.output : JSON.stringify(c.output, null, 1)}`,
  );
  return `${task}\n\nWHAT PRIOR STAGES ESTABLISHED:\n\n${sections.join("\n\n")}`;
}

function isSpec(stage: AgentStage): stage is AgentStageSpec {
  return (stage as AgentStageSpec).agent !== undefined;
}

function stageName(stage: AgentStageSpec, index: number): string {
  return (
    stage.name ?? (stage.agent as { role?: { name?: string } }).role?.name ?? `stage-${index + 1}`
  );
}

// ---------------------------------------------------------------------------
// The primitive
// ---------------------------------------------------------------------------

/**
 * Seat `stages` in order over one shared Scratchpad and return the pipeline as
 * a {@link Node}. See the module doc for semantics.
 */
export function sequentialAgents(
  stages: ReadonlyArray<AgentStage>,
  opts: SequentialAgentsOpts = {},
): Node<unknown, SequentialAgentsResult> {
  if (stages.length === 0) throw new Error("sequentialAgents: at least one stage is required");
  const specs = stages.map((s) => (isSpec(s) ? s : { agent: s }));
  const names = specs.map((s, i) => stageName(s, i));
  const dupe = names.find((n, i) => names.indexOf(n) !== i);
  if (dupe != null) {
    throw new Error(
      `sequentialAgents: duplicate stage name '${dupe}' — set an explicit \`name\` per stage`,
    );
  }

  // Emission slots: auto per stage unless the caller provided one.
  const emissionSlots = specs.map(
    (s, i) =>
      s.slot ?? slot<unknown>({ key: `agents.${names[i]}`, scope: "run", init: () => null }),
  );

  // Build-time write-before-read assert over DECLARED dependencies (a stage with
  // no declarations opts out — the implicit render never reads a missing slot).
  const written = new Set<string>(emissionSlots.map((s) => s.key));
  const declaredSoFar = new Set<string>();
  for (let i = 0; i < specs.length; i += 1) {
    for (const r of specs[i]?.reads ?? []) {
      if (!declaredSoFar.has(r.key) && !written.has(r.key)) {
        throw new Error(
          `sequentialAgents: stage '${names[i]}' reads '${r.key}' but no earlier stage declares writing it`,
        );
      }
    }
    declaredSoFar.add(emissionSlots[i]?.key ?? "");
    for (const w of specs[i]?.writes ?? []) declaredSoFar.add(w.key);
  }

  return {
    name: opts.name ?? "sequential-agents",
    async run(input: unknown, ctx: NodeRunContext): Promise<NodeResult<SequentialAgentsResult>> {
      const scratchpad = ctx.scratchpad ?? createScratchpad();
      const render = opts.render ?? renderSharedState;
      const completed: CompletedStage[] = [];
      const outputs: Record<string, unknown> = {};
      let tokensIn = 0;
      let tokensOut = 0;

      for (let i = 0; i < specs.length; i += 1) {
        const spec = specs[i]!;
        const name = names[i]!;
        const emissionSlot = emissionSlots[i]!;

        const step = new AgentStep<unknown, unknown>({
          name,
          agent: spec.agent,
          ...(spec.output != null ? { output: spec.output as ZodType<unknown> } : {}),
          ...(spec.maxIterations != null ? { maxIterations: spec.maxIterations } : {}),
          prompt: (_input, state) =>
            spec.prompt != null ? spec.prompt(state, input) : render(input, completed),
        });

        // Per-stage executor from the agent's OWN capabilities — a tool-using stage
        // can never hit the forgotten-executor failure inside a sequence. Tool-less
        // stages keep whatever executor the caller threaded (usually none).
        const hasCapabilities =
          ((spec.agent as { role?: { capabilities?: ReadonlyArray<unknown> } }).role?.capabilities
            ?.length ?? 0) > 0;
        const stageCtx: NodeRunContext = {
          ...ctx,
          scratchpad,
          ...(hasCapabilities ? { toolExecutor: createToolboxExecutor(spec.agent as never) } : {}),
        };

        const res = await step.run(input, stageCtx);
        tokensIn += res.totalInputTokens;
        tokensOut += res.totalOutputTokens;
        if (!res.succeeded) {
          return {
            output: undefined as never,
            succeeded: false,
            error:
              res.error ?? new Error(`sequentialAgents: stage '${name}' failed without an error`),
            totalInputTokens: tokensIn,
            totalOutputTokens: tokensOut,
          };
        }

        scratchpad.set(emissionSlot, res.output);
        outputs[name] = res.output;
        completed.push({ name, output: res.output });

        const done = (
          stopped: SequentialAgentsResult["stopped"],
        ): NodeResult<SequentialAgentsResult> => ({
          output: { outputs, stopped },
          succeeded: true,
          totalInputTokens: tokensIn,
          totalOutputTokens: tokensOut,
        });

        const stopReason = spec.stop?.(res.output, scratchpad.reader()) ?? null;
        if (stopReason != null) return done({ stage: name, reason: stopReason });

        if (spec.tail != null) {
          try {
            const tailStop = await spec.tail(res.output, scratchpad, { ...ctx, scratchpad });
            if (typeof tailStop === "string") return done({ stage: name, reason: tailStop });
          } catch (error) {
            return {
              output: undefined as never,
              succeeded: false,
              error: error as Error,
              totalInputTokens: tokensIn,
              totalOutputTokens: tokensOut,
            };
          }
        }
      }

      return {
        output: { outputs, stopped: null },
        succeeded: true,
        totalInputTokens: tokensIn,
        totalOutputTokens: tokensOut,
      };
    },
  };
}

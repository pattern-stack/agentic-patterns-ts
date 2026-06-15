/**
 * WorkflowConfig — declarative, serializable workflow (pipeline) definition.
 *
 * The tier above {@link AgentConfig}: a workflow composes *named* agents as
 * ordered steps, each optionally overriding the agent's config for this
 * workflow's use. `buildWorkflowFromConfig` (agent-runtime) hydrates it into a
 * runnable pattern (Sequential / Parallel).
 *
 * Distinct from `Agency` (a team of agents that message each other): a
 * WorkflowConfig is a pipeline — ordered steps with data threaded between them.
 *
 * The model belongs to the agent: a step's `model` (or `configOverride.model`)
 * sets which model that step's agent runs on; one resolver-backed runner
 * dispatches each. There is no per-step runner.
 *
 * v1 scope: flat steps only (no nested sub-workflow steps); the two modes are
 * `sequential` and `parallel`. `outputKey` + `{{key}}` interpolation thread data
 * between *sequential* steps — in `parallel` mode steps share the input context
 * and `outputKey` is inert (no result is threaded out). Sequential
 * `continueOnError`, and Parallel `consolidator` / `maxConcurrency`, are not
 * config-exposed yet — use the code-built `Sequential`/`Parallel` for those.
 */

import { z } from "zod";

import { AgentConfigOverrideSchema } from "./agent-config.js";

/** One step in a workflow: a named agent + its message, with optional per-step overrides. */
export const WorkflowStepConfigSchema = z
  .object({
    /** Name of the agent to run, resolved to an AgentConfig via an AgentResolver. */
    agent: z.string().min(1),
    /**
     * The message sent to the agent. Supports `{{key}}` placeholders interpolated
     * against the pattern context at run time (e.g. a prior step's `outputKey`).
     */
    messageTemplate: z.string(),
    /** Step name (defaults to `step_<index>`). */
    name: z.string().optional(),
    /** Context key to write this step's text output under, for later steps to read. */
    outputKey: z.string().optional(),
    /** Per-step model — shorthand that wins over `configOverride.model`. */
    model: z.string().optional(),
    /** Per-step tool-loop cap (falls back to the runner's default). */
    maxIterations: z.number().int().positive().optional(),
    /** Patch the named agent's config for this step (model / judgments / mission / …). */
    configOverride: AgentConfigOverrideSchema.optional(),
  })
  .strict();

export type WorkflowStepConfig = z.infer<typeof WorkflowStepConfigSchema>;

/** A complete, serializable workflow definition. */
export const WorkflowConfigSchema = z
  .object({
    name: z.string().min(1),
    mode: z.enum(["sequential", "parallel"]),
    steps: z.array(WorkflowStepConfigSchema).min(1),
  })
  .strict();

export type WorkflowConfig = z.infer<typeof WorkflowConfigSchema>;
/** Plain-object input form (pre-validation / defaults). */
export type WorkflowConfigInput = z.input<typeof WorkflowConfigSchema>;

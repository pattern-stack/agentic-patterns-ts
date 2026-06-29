/**
 * buildWorkflowFromConfig — hydrate a runnable workflow from a declarative
 * WorkflowConfig. The tier above `buildAgentFromConfig`: it resolves each step's
 * named agent, applies any per-step `configOverride`, builds the agent, and
 * assembles a typed `Sequential` / `Parallel` pinned to `Node<PatternContext,
 * string>` (DESIGN §10 — the declarative path's intended string-only ceiling).
 *
 * Threading: the serialized config has no typed channel, so it threads the
 * untyped `PatternContext` bag node→node (each step writes its `outputKey` into
 * the bag) and interpolates `{{key}}` placeholders from it. A trailing extractor
 * collapses the bag to the last step's raw output — pinning the public `TOut`
 * to `string`.
 *
 * The model belongs to the agent: a step's `model` (or `configOverride.model`)
 * is baked into that step's agent via `buildAgentFromConfig`'s `modelOverride`,
 * so one resolver-backed runner — supplied at `run()` — dispatches each step's
 * model. There is no per-step runner.
 */

import {
  AgentConfig,
  type AgentResolutionContext,
  type AgentResolver,
  type CapabilityResolver,
  type WorkflowConfig,
  type WorkflowConfigInput,
  WorkflowConfigSchema,
  buildAgentFromConfig,
  mergeAgentConfig,
} from "@agentic-patterns/core";

import { AgentStep } from "./agent-step.js";
import type { AgentLike, PatternContext, PatternProtocol } from "./base.js";
import { FunctionStep } from "./function-step.js";
import type { Node, NodeResult, NodeRunContext } from "./node.js";
import { Parallel, type ParallelBranch } from "./parallel.js";
import { SequentialBuilder } from "./sequential.js";

/** Options for {@link buildWorkflowFromConfig}. */
export interface BuildWorkflowOptions {
  /** Resolves a step's agent name to its AgentConfig. Required. */
  agentResolver: AgentResolver;
  /** Resolves capability names when building agents. Required if any resolved agent declares capabilities. */
  capabilityResolver?: CapabilityResolver;
  /** Opaque, app-defined resolution context, threaded to both resolvers and the agent build. */
  ctx?: AgentResolutionContext;
}

/** Compiled message template: a static string or an interpolating function. */
type CompiledTemplate = string | ((context: PatternContext) => string);

/** Bag key holding the most recent step's raw output (the threaded "last"). */
const LAST_OUTPUT_KEY = "__lastOutput__";

/**
 * Compile a `messageTemplate` string into a {@link CompiledTemplate}. A template
 * with `{{key}}` placeholders becomes a function that interpolates against the
 * pattern context at run time; a static string is returned as-is. Missing/null
 * keys render as an empty string.
 */
export function compileMessageTemplate(template: string): CompiledTemplate {
  if (!template.includes("{{")) return template;
  return (context: PatternContext): string =>
    template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_match, key: string) => {
      // Own-property only — an inherited key (toString, constructor, …) must
      // render empty like any other missing key, not leak its prototype value.
      const value = Object.hasOwn(context, key) ? context[key] : undefined;
      return value === undefined || value === null ? "" : String(value);
    });
}

/** Render a compiled template against the bag. */
function renderTemplate(template: CompiledTemplate, context: PatternContext): string {
  return typeof template === "function" ? template(context) : template;
}

/** A single resolved config step: a built agent + its compiled template + threading metadata. */
interface ResolvedStep {
  readonly agent: AgentLike;
  readonly template: CompiledTemplate;
  readonly name?: string;
  readonly outputKey?: string;
  readonly maxIterations?: number;
}

/**
 * A config step as a `Node<PatternContext, PatternContext>`. Wraps an
 * {@link AgentStep} (raw-text path) and merges its output back into the threaded
 * bag under `outputKey` (and the internal last-output key), so subsequent steps
 * can interpolate it via `{{key}}`.
 */
class ConfigStep implements Node<PatternContext, PatternContext> {
  readonly name?: string;
  private readonly agentStep: AgentStep<PatternContext, string>;
  private readonly outputKey?: string;

  constructor(step: ResolvedStep) {
    this.name = step.name;
    this.outputKey = step.outputKey;
    this.agentStep = new AgentStep<PatternContext, string>({
      name: step.name,
      agent: step.agent,
      maxIterations: step.maxIterations,
      // No `output` schema → AgentStep takes the legacy raw-text path.
      prompt: (input) => renderTemplate(step.template, input),
    });
  }

  async run(input: PatternContext, ctx: NodeRunContext): Promise<NodeResult<PatternContext>> {
    const res = await this.agentStep.run(input, ctx);
    const merged: PatternContext = { ...input, [LAST_OUTPUT_KEY]: res.output };
    if (this.outputKey) merged[this.outputKey] = res.output;
    return {
      output: merged,
      succeeded: res.succeeded,
      error: res.error,
      totalInputTokens: res.totalInputTokens,
      totalOutputTokens: res.totalOutputTokens,
    };
  }
}

/** Resolve + build each config step's agent. */
function resolveSteps(cfg: WorkflowConfig, options: BuildWorkflowOptions): ResolvedStep[] {
  const { agentResolver, capabilityResolver, ctx } = options;
  return cfg.steps.map((sc) => {
    const resolved = agentResolver.resolve(sc.agent, ctx);
    const baseConfig = resolved instanceof AgentConfig ? resolved : new AgentConfig(resolved);
    const mergedData = sc.configOverride
      ? mergeAgentConfig(baseConfig.data, sc.configOverride)
      : baseConfig.data;

    const agent = buildAgentFromConfig(mergedData, {
      resolver: capabilityResolver,
      ctx,
      // `model` shorthand wins over `configOverride.model`; both bake into the
      // built agent so a resolver-backed runner dispatches it.
      modelOverride: sc.model,
    });

    return {
      agent,
      template: compileMessageTemplate(sc.messageTemplate),
      name: sc.name,
      outputKey: sc.outputKey,
      maxIterations: sc.maxIterations,
    };
  });
}

/** An empty workflow node (no steps) — returns `""`. */
function emptyWorkflow(name: string): PatternProtocol {
  return {
    name,
    async run(): Promise<NodeResult<string>> {
      return { output: "", succeeded: true, totalInputTokens: 0, totalOutputTokens: 0 };
    },
  };
}

/**
 * Build a runnable workflow (a {@link PatternProtocol} = `Node<PatternContext,
 * string>`) from a declarative {@link WorkflowConfig}.
 *
 * @param config - a WorkflowConfig or its plain-object form (validated on the way in)
 * @param options - the agent resolver (required) + optional capability resolver + ctx
 * @throws if the config is invalid, or (from a resolver) if an agent/capability name is unknown
 */
export function buildWorkflowFromConfig(
  config: WorkflowConfig | WorkflowConfigInput,
  options: BuildWorkflowOptions,
): PatternProtocol {
  const cfg = WorkflowConfigSchema.parse(config);
  const steps = resolveSteps(cfg, options);

  if (steps.length === 0) return emptyWorkflow("Workflow");

  if (cfg.mode === "parallel") {
    // Each branch reads the same bag and produces raw text; consolidate to a
    // single string so the public `TOut` stays `string`.
    const branches: Array<ParallelBranch<PatternContext, string>> = steps.map((step, i) => ({
      name: step.name ?? `step_${i}`,
      node: new AgentStep<PatternContext, string>({
        name: step.name,
        agent: step.agent,
        maxIterations: step.maxIterations,
        prompt: (input) => renderTemplate(step.template, input),
      }),
    }));
    return new Parallel<PatternContext, string, string>(branches, {
      name: "Workflow",
      consolidate: (outputs) => outputs.join("\n\n"),
    });
  }

  // Sequential: thread the bag through ConfigStep adapters, then extract the
  // last step's raw output to pin `TOut = string`.
  const [first, ...rest] = steps;
  let builder = SequentialBuilder.start<PatternContext, PatternContext>(new ConfigStep(first!));
  for (const step of rest) {
    builder = builder.then(new ConfigStep(step));
  }
  const extractor = new FunctionStep<PatternContext, string>({
    name: "extract",
    fn: (bag) => {
      const last = bag[LAST_OUTPUT_KEY];
      return last === undefined || last === null ? "" : String(last);
    },
  });
  return builder.then(extractor).build("Workflow");
}

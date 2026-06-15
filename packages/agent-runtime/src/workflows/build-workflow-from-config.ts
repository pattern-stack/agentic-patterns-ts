/**
 * buildWorkflowFromConfig — hydrate a runnable workflow from a declarative
 * WorkflowConfig. The tier above `buildAgentFromConfig`: it resolves each step's
 * named agent, applies any per-step `configOverride`, builds the agent, and
 * assembles a Sequential / Parallel pattern.
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

import type { MessageTemplate, PatternContext, PatternProtocol, Step } from "./base.js";
import { Parallel } from "./parallel.js";
import { Sequential } from "./sequential.js";

/** Options for {@link buildWorkflowFromConfig}. */
export interface BuildWorkflowOptions {
  /** Resolves a step's agent name to its AgentConfig. Required. */
  agentResolver: AgentResolver;
  /** Resolves capability names when building agents. Required if any resolved agent declares capabilities. */
  capabilityResolver?: CapabilityResolver;
  /** Opaque, app-defined resolution context, threaded to both resolvers and the agent build. */
  ctx?: AgentResolutionContext;
}

/**
 * Compile a `messageTemplate` string into a {@link MessageTemplate}. A template
 * with `{{key}}` placeholders becomes a function that interpolates against the
 * pattern context at run time; a static string is returned as-is (so plain
 * messages stay plain). Missing/null keys render as an empty string.
 */
export function compileMessageTemplate(template: string): MessageTemplate {
  if (!template.includes("{{")) return template;
  return (context: PatternContext): string =>
    template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_match, key: string) => {
      // Own-property only — an inherited key (toString, constructor, …) must
      // render empty like any other missing key, not leak its prototype value.
      const value = Object.hasOwn(context, key) ? context[key] : undefined;
      return value === undefined || value === null ? "" : String(value);
    });
}

/**
 * Build a runnable workflow (a {@link PatternProtocol}) from a declarative
 * {@link WorkflowConfig}.
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
  const { agentResolver, capabilityResolver, ctx } = options;

  const steps: Step[] = cfg.steps.map((sc) => {
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
      messageTemplate: compileMessageTemplate(sc.messageTemplate),
      name: sc.name,
      outputKey: sc.outputKey,
      maxIterations: sc.maxIterations,
    };
  });

  return cfg.mode === "parallel" ? new Parallel(steps) : new Sequential(steps);
}

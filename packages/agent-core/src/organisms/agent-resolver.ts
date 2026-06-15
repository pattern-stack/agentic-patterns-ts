/**
 * AgentResolver — resolves agent *names* to their declarative AgentConfig.
 *
 * `WorkflowStepConfig.agent` carries a name (e.g. "DealSummaryAgent"), not an
 * embedded config, so a workflow stays a thin reference over agents defined once
 * elsewhere. This is the seam: the framework defines it; the hosting app
 * implements it (typically a registry of AgentConfigs). `buildWorkflowFromConfig`
 * calls it per step, then applies any per-step `configOverride`.
 *
 * Sibling to {@link CapabilityResolver}: that resolves capability names to live
 * Capabilities; this resolves agent names to AgentConfigs.
 */

import type { AgentConfig } from "../atoms/agent-config.js";
import type { AgentConfigInput } from "./build-agent-from-config.js";

/** Application-defined resolution context (e.g. tenant id, auth scope), passed through opaquely. */
export type AgentResolutionContext = Record<string, unknown>;

/** Resolves an agent name to its AgentConfig (instance or plain-object form). */
export interface AgentResolver {
  /**
   * Resolve a single agent name to an AgentConfig.
   *
   * @param name - agent name as it appears in `WorkflowStepConfig.agent`
   * @param ctx - optional, app-defined resolution context
   * @throws if the name is unknown — `buildWorkflowFromConfig` surfaces this as a build error
   */
  resolve(name: string, ctx?: AgentResolutionContext): AgentConfig | AgentConfigInput;
}

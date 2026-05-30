/**
 * CapabilityResolver — resolves capability *names* to live Capability instances.
 *
 * `AgentConfig.capabilities` carries names (e.g. "task-management"), not embedded
 * Capabilities, because a live Capability wraps a Toolbox holding vendor clients
 * and secrets — the hosting application's concern, not the library's.
 *
 * This port is the seam: the framework defines it; the application implements it
 * (typically a registry of pre-wired toolboxes). `buildAgentFromConfig` calls the
 * resolver so it can produce a fully tooled Agent without the library ever touching
 * credentials. The optional `ctx` lets the app thread tenant/auth scope through
 * opaquely.
 */

import type { Capability } from "../molecules/capability.js";

/**
 * Application-defined resolution context (e.g. tenant id, auth scope).
 *
 * Passed through opaquely from `buildAgentFromConfig` to the resolver; the library
 * never inspects it.
 */
export type CapabilityResolutionContext = Record<string, unknown>;

/**
 * Resolves capability names from an AgentConfig to live Capability instances.
 */
export interface CapabilityResolver {
  /**
   * Resolve a single capability name to a live Capability.
   *
   * @param name - capability name as it appears in `AgentConfig.capabilities`
   * @param ctx - optional, app-defined resolution context (tenant/auth scope)
   * @throws if the name is unknown — `buildAgentFromConfig` surfaces this as a build error
   */
  resolve(name: string, ctx?: CapabilityResolutionContext): Capability;
}

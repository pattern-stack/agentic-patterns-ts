// Organisms — barrel export

export { Role, RoleBuilder, RoleSchema, type RoleData } from "./role.js";
export {
  Agent,
  AgentBuilder,
  AgentSchema,
  type AgentData,
  type AgentPromptSectionData,
} from "./agent.js";
export type {
  CapabilityResolver,
  CapabilityResolutionContext,
} from "./capability-resolver.js";
export type { AgentResolver, AgentResolutionContext } from "./agent-resolver.js";
export {
  buildAgentFromConfig,
  mergeAgentConfig,
  type BuildAgentOptions,
  type AgentConfigInput,
} from "./build-agent-from-config.js";

/**
 * Orchestrator role preset - conversational routing agent.
 *
 * Ported from Python: library/orchestration/archetypes.py
 */

import { type Capability, Persona, type Role, RoleBuilder } from "@pattern-stack/agentic-core";
import { INTENT_CLASSIFICATION } from "./judgments.js";
import { INTENT_ROUTING, RESPONSE_SYNTHESIS } from "./responsibilities.js";

/**
 * Role that understands user intent and routes to agencies/agents.
 *
 * An orchestrator is the chat-facing agent that interprets what
 * users want, routes to the right specialist team, and synthesizes
 * responses. It maintains conversational context across turns.
 *
 * NO MODEL (#179/#222): this declaration pins no `defaultModel`. Set the model
 * where you compose the agent (`AgentBuilder.withModel(id)`, or
 * `role.withDefaultModel(id)` on your own role), or let the runner resolve it
 * from the environment (tier / `AGENT_MODEL` / gateway / profiles). The
 * framework never silently pins a vendor's model onto a consumer's agent.
 */
export function orchestratorRole(options?: {
  capability?: Capability;
}): Role {
  const builder = new RoleBuilder("Orchestrator")
    .withPersona(
      new Persona({
        identity:
          "a conversational agent who understands what users need and connects them to the right specialist team",
        tone: "Warm but efficient. Acknowledge the request, route it, synthesize the response.",
        priorities: [
          "Understand the user's intent before routing",
          "Route to the most relevant extension or agency",
          "Synthesize specialist responses into coherent user-facing answers",
          "Maintain conversational context across turns",
        ],
        principles: [
          "Ask for clarification rather than guessing incorrectly",
          "The orchestrator facilitates but does not do the specialist work",
          "When multiple agencies could handle a request, explain the options",
        ],
      }),
    )
    .withJudgment(INTENT_CLASSIFICATION)
    .withResponsibility(INTENT_ROUTING)
    .withResponsibility(RESPONSE_SYNTHESIS);

  if (options?.capability) {
    builder.withCapability(options.capability);
  }

  return builder.build();
}

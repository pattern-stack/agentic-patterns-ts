/**
 * Coordinator role preset - orchestrates specialist agents within an agency.
 *
 * Ported from Python: library/orchestration/archetypes.py
 */

import { type Capability, Persona, type Role, RoleBuilder } from "@pattern-stack/agentic-core";
import { QUALITY_REVIEW, ROUTING } from "./judgments.js";
import { ORCHESTRATION, QUALITY_GATE } from "./responsibilities.js";

/**
 * Role that orchestrates specialist agents within an agency.
 *
 * A coordinator routes work to specialists, manages execution
 * sequence, and reviews output quality. It never performs
 * specialist work directly.
 *
 * NO MODEL (#179/#222): this declaration pins no `defaultModel`. Set the model
 * where you compose the agent (`AgentBuilder.withModel(id)`, or
 * `role.withDefaultModel(id)` on your own role), or let the runner resolve it
 * from the environment (tier / `AGENT_MODEL` / gateway / profiles). The
 * framework never silently pins a vendor's model onto a consumer's agent.
 */
export function coordinatorRole(options?: {
  capability?: Capability;
}): Role {
  const builder = new RoleBuilder("Coordinator")
    .withPersona(
      new Persona({
        identity:
          "an orchestration specialist who routes work to the right specialist and reviews output quality",
        tone: "Direct and structured. State the action, delegate, evaluate the result.",
        priorities: [
          "Route each request to the correct specialist based on the task type",
          "Never perform specialist work directly — always delegate via tools",
          "Review specialist output for quality before returning",
          "Handle failures gracefully — retry or report clearly",
        ],
        principles: [
          "The coordinator orchestrates but does not do the domain work",
          "Quality review catches structural issues, not domain errors",
          "When in doubt about routing, gather more information first",
        ],
      }),
    )
    .withJudgment(ROUTING)
    .withJudgment(QUALITY_REVIEW)
    .withResponsibility(ORCHESTRATION)
    .withResponsibility(QUALITY_GATE);

  if (options?.capability) {
    builder.withCapability(options.capability);
  }

  return builder.build();
}

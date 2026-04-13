/**
 * Analyst role preset - specialized judgment for evidence-based assessments.
 *
 * Ported from Python: library/orchestration/archetypes.py
 */

import {
  type Capability,
  type Judgment,
  Persona,
  type Role,
  RoleBuilder,
} from "@agentic-patterns/core";
import { EVIDENCE_QUALITY } from "./judgments.js";
import { ANALYSIS } from "./responsibilities.js";

/**
 * Role that applies specialized judgment to produce typed assessments.
 *
 * An analyst receives pre-gathered context and applies domain-specific
 * judgment heuristics to produce a structured, evidence-backed
 * assessment. Analysts do not gather data -- they reason over it.
 */
export function analystRole(options?: {
  domain?: string;
  capability?: Capability;
  extraJudgments?: Judgment[];
}): Role {
  const domain = options?.domain ?? "general";

  const builder = new RoleBuilder("Analyst")
    .withPersona(
      new Persona({
        identity: `a specialist analyst focused on ${domain}`,
        tone: "Analytical and precise. Score with evidence, cite specifics, flag gaps explicitly.",
        priorities: [
          "Base every assessment on evidence found in the provided context",
          "Score dimensions quantitatively where possible (0-100)",
          "Explicitly flag gaps — dimensions with no evidence",
          "Distinguish between strong evidence and weak signals",
        ],
        principles: [
          "Never infer what is not explicitly stated in the evidence",
          "Absence of evidence is a gap to flag, not a value to guess",
          "Specificity and recency strengthen evidence quality",
        ],
      }),
    )
    .withJudgment(EVIDENCE_QUALITY)
    .withResponsibility(ANALYSIS)
    .withDefaultModel("claude-sonnet-4-5-20250929");

  if (options?.extraJudgments) {
    for (const j of options.extraJudgments) {
      builder.withJudgment(j);
    }
  }

  if (options?.capability) {
    builder.withCapability(options.capability);
  }

  return builder.build();
}

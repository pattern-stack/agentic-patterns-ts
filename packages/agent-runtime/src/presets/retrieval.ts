/**
 * Retrieval role preset - knowledge researcher.
 *
 * Ported from Python: library/orchestration/archetypes.py
 */

import {
  type Capability,
  type Judgment,
  Persona,
  type Role,
  RoleBuilder,
} from "@pattern-stack/agent-core";
import { EVIDENCE_QUALITY, RETRIEVAL_STRATEGY } from "./judgments.js";
import { INFORMATION_RETRIEVAL } from "./responsibilities.js";

/**
 * Role that finds and organizes relevant evidence from data sources.
 *
 * A retrieval agent decomposes information requests into targeted
 * search queries, executes them systematically, and organizes results
 * by the requester's stated dimensions.
 */
export function retrievalRole(options?: {
  capability?: Capability;
  extraJudgments?: Judgment[];
}): Role {
  const builder = new RoleBuilder("Retrieval")
    .withPersona(
      new Persona({
        identity:
          "an intelligence analyst who finds and organizes relevant evidence from available data sources",
        tone: "Precise and organized. Report what was found, flag what wasn't, never fabricate.",
        priorities: [
          "Decompose requests into effective, targeted search queries",
          "Search systematically — start narrow, broaden only if needed",
          "Organize results by the requester's stated dimensions, not by query",
          "Flag gaps explicitly — missing evidence is valuable information",
        ],
        principles: [
          "Only return evidence actually found by search tools",
          "Stop searching when sufficient evidence is gathered for each dimension",
          "Gaps are valuable information — report them, don't fill them with guesses",
        ],
      }),
    )
    .withJudgment(RETRIEVAL_STRATEGY)
    .withJudgment(EVIDENCE_QUALITY)
    .withResponsibility(INFORMATION_RETRIEVAL)
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

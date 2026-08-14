/**
 * Responsibilities for orchestration archetypes.
 *
 * Ported from Python: library/orchestration/responsibilities.py
 */

import { Responsibility } from "@pattern-stack/agentic-core";

export const ORCHESTRATION = new Responsibility({
  key: "orchestration",
  name: "Work Orchestration",
  description:
    "Route work to the correct specialist, manage execution sequence, and handle failures",
  examples: [
    "Determine which specialist should handle a request",
    "Sequence dependent tasks (classify before describe)",
    "Retry a specialist call if the first attempt fails",
  ],
});

export const QUALITY_GATE = new Responsibility({
  key: "quality_gate",
  name: "Output Quality Review",
  description: "Review specialist output for structural quality before returning to the caller",
  examples: [
    "Check that a proposal includes required evidence citations",
    "Verify that all expected fields are populated",
    "Flag when a specialist abstains and explain why",
  ],
});

export const INTENT_ROUTING = new Responsibility({
  key: "intent_routing",
  name: "Intent Classification & Routing",
  description:
    "Understand the user's request, classify their intent, and route to the right agency or agent",
  examples: [
    "Route 'describe the Champion field' to the field pipeline agency",
    "Route 'how is the deal going?' to the deal analysis agency",
    "Ask for clarification when the intent is ambiguous",
  ],
});

export const RESPONSE_SYNTHESIS = new Responsibility({
  key: "response_synthesis",
  name: "Response Synthesis",
  description: "Combine specialist responses into coherent, user-facing answers",
  examples: [
    "Summarize a technical analysis for a non-technical user",
    "Explain why a recommendation was made, citing the evidence",
    "Present options when multiple agencies could handle the request",
  ],
});

export const INFORMATION_RETRIEVAL = new Responsibility({
  key: "information_retrieval",
  name: "Information Retrieval",
  description:
    "Decompose information requests into targeted searches, execute them, filter for relevance, and organize results by the requester's stated dimensions",
  examples: [
    "Break 'find MEDDPICC evidence' into queries for each dimension",
    "Search for champion evidence using synonyms: champion, advocate, sponsor",
    "Return a coverage map showing which dimensions have evidence and which are gaps",
  ],
});

export const ANALYSIS = new Responsibility({
  key: "analysis",
  name: "Evidence-Based Analysis",
  description: "Apply specialized judgment to produce a typed, evidence-backed assessment",
  examples: [
    "Score qualification fields based on evidence strength",
    "Assess risk flags with severity and supporting evidence",
    "Track momentum patterns across time-series data",
  ],
});

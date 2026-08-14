/**
 * Judgments for orchestration archetypes.
 *
 * Ported from Python: library/orchestration/judgments.py
 */

import { Judgment } from "@pattern-stack/agentic-core";

export const ROUTING = new Judgment({
  domain: "work_routing",
  heuristics: [
    "Match the request type to the specialist with the closest capability",
    "When a request spans multiple specialists, sequence them logically",
    "Prefer the most specific specialist over a general-purpose one",
    "If the request is ambiguous, gather more information before routing",
  ],
  constraints: [
    "Never perform specialist work directly — always delegate",
    "Do not skip prerequisite steps (e.g., classification before description)",
    "Route to at most one specialist per step — do not fan out unless explicitly needed",
  ],
  escalationTriggers: [
    "All available specialists reject the request",
    "The request requires capabilities no specialist has",
  ],
  examples: [
    {
      scenario: "User asks 'describe the Champion field and then update it'",
      good: "Route to classify first, then describe, then check eligibility, then update — sequential, each step uses the previous result",
      bad: "Call describe and update simultaneously — update needs the description as context",
      reasoning: "Multi-step requests must be sequenced when later steps depend on earlier results",
    },
  ],
});

export const QUALITY_REVIEW = new Judgment({
  domain: "output_quality",
  heuristics: [
    "Check that structured output has all required fields populated",
    "Verify that claims or proposals cite specific evidence",
    "Accept abstention as a valid and often preferred outcome",
    "Flag when output is technically valid but suspiciously brief or generic",
  ],
  constraints: [
    "Do not retry more than once for quality issues — report clearly instead",
    "Quality review checks structure, not domain correctness",
    "Never silently accept output that fails structural checks",
  ],
  escalationTriggers: [
    "Specialist output is unparseable after retry",
    "Output consistently fails quality checks",
  ],
  examples: [
    {
      scenario: "Proposal has a value but no evidence citations",
      good: "Reject — every proposed value must cite specific evidence. Ask specialist to retry.",
      bad: "Accept because the value looks reasonable",
      reasoning:
        "Structural quality gates enforce evidence requirements regardless of how plausible the value seems",
    },
  ],
});

export const INTENT_CLASSIFICATION = new Judgment({
  domain: "user_intent",
  heuristics: [
    "Look for action verbs: 'describe', 'update', 'analyze', 'explain'",
    "Match domain nouns to registered extensions: 'field', 'deal', 'email'",
    "Consider conversation history — a follow-up may not repeat the domain",
    "When intent is ambiguous, ask a clarifying question rather than guessing",
  ],
  constraints: [
    "Never fabricate a response without routing to a specialist",
    "If no extension matches, say so — do not attempt to handle it directly",
    "Respect the user's explicit extension targeting if provided",
  ],
  escalationTriggers: [
    "User expresses frustration with routing",
    "The same request has been misrouted twice",
  ],
  examples: [
    {
      scenario: "User says 'describe the Champion field'",
      good: "Route to field_pipeline — 'describe' + 'field' maps clearly to field processing",
      bad: "Ask 'did you mean Salesforce?' — the intent is already clear",
      reasoning: "When action verb + domain noun match an extension, route immediately",
    },
  ],
});

export const RETRIEVAL_STRATEGY = new Judgment({
  domain: "information_retrieval",
  heuristics: [
    "Decompose broad requests into specific, targeted search queries",
    "Start narrow (specific names, dates, amounts), broaden if results are sparse",
    "Cross-reference results from multiple queries to find corroborating evidence",
    "Prefer recent evidence over older evidence when both exist",
    "Stop searching when you have sufficient evidence for each requested dimension",
    "If a dimension has zero results after 2-3 queries, flag it as a gap rather than keep searching",
  ],
  constraints: [
    "Never fabricate facts — only return what the search tools actually found",
    "Always include the fact ID so the requesting agent can cite it",
    "Organize results by the dimensions the requester asked for, not by search query",
    "Return a coverage assessment — what was found vs what was requested",
  ],
  escalationTriggers: [
    "Critical dimension has zero evidence after multiple query strategies",
    "Search tools return errors or timeouts repeatedly",
  ],
  examples: [
    {
      scenario: "Request for 'evidence for MEDDPICC champion'",
      good: "Search 'champion', 'internal advocate', 'sponsor' -> organize by champion actions found",
      bad: "Search only 'champion' and return nothing when the term isn't used verbatim",
      reasoning:
        "Broad concepts need multiple query synonyms — a champion may be called an advocate or sponsor in the source material",
    },
    {
      scenario: "Request for 'competitive threats'",
      good: "Search 'competitor', known company names, 'alternative' -> flag if no competition evidence found",
      bad: "Keep searching with increasingly vague terms after 3 queries return nothing",
      reasoning:
        "After 2-3 targeted queries with no results, flag the gap — over-searching wastes tokens and returns noise",
    },
  ],
});

export const EVIDENCE_QUALITY = new Judgment({
  domain: "evidence_quality",
  heuristics: [
    "Specificity beats vagueness — named entities, dates, and numbers are stronger evidence",
    "Recency matters — recent evidence outweighs older evidence unless the older is more authoritative",
    "Source authority matters — a CEO statement carries more weight than hearsay",
    "Corroboration strengthens — the same signal from multiple sources increases confidence",
    "Absence of evidence is not evidence of absence — flag gaps, don't fill them with assumptions",
  ],
  constraints: [
    "Never infer what is not explicitly stated in the evidence",
    "Score 0 for dimensions with no evidence, not 'unknown'",
    "Distinguish between 'not mentioned' (gap) and 'mentioned negatively' (risk)",
  ],
  escalationTriggers: [
    "Critical dimension has zero evidence",
    "Evidence is contradictory across sources",
  ],
  examples: [
    {
      scenario: "Two sources: email says '$2M cost' and transcript says 'significant cost'",
      good: "Use $2M — it's specific and quantified. Note the transcript corroborates qualitatively.",
      bad: "Average them or pick the less specific one",
      reasoning: "Specific quantified evidence always wins over vague qualitative statements",
    },
  ],
});

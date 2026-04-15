import { Judgment, Role } from "@pattern-stack/agent-core";
import { describe, expect, it } from "vitest";
import { analystRole } from "../analyst.js";
import { coordinatorRole } from "../coordinator.js";
import {
  EVIDENCE_QUALITY,
  INTENT_CLASSIFICATION,
  QUALITY_REVIEW,
  RETRIEVAL_STRATEGY,
  ROUTING,
} from "../judgments.js";
import { orchestratorRole } from "../orchestrator.js";
import {
  ANALYSIS,
  INFORMATION_RETRIEVAL,
  INTENT_ROUTING,
  ORCHESTRATION,
  QUALITY_GATE,
  RESPONSE_SYNTHESIS,
} from "../responsibilities.js";
import { retrievalRole } from "../retrieval.js";

// ---------------------------------------------------------------------------
// Judgment constant tests
// ---------------------------------------------------------------------------

describe("Judgments", () => {
  it("should have ROUTING judgment with work_routing domain", () => {
    expect(ROUTING.data.domain).toBe("work_routing");
    expect(ROUTING.data.heuristics.length).toBeGreaterThan(0);
    expect(ROUTING.data.constraints.length).toBeGreaterThan(0);
    expect(ROUTING.data.escalation_triggers.length).toBeGreaterThan(0);
    expect(ROUTING.data.examples.length).toBeGreaterThan(0);
  });

  it("should have QUALITY_REVIEW judgment", () => {
    expect(QUALITY_REVIEW.data.domain).toBe("output_quality");
  });

  it("should have INTENT_CLASSIFICATION judgment", () => {
    expect(INTENT_CLASSIFICATION.data.domain).toBe("user_intent");
  });

  it("should have RETRIEVAL_STRATEGY judgment", () => {
    expect(RETRIEVAL_STRATEGY.data.domain).toBe("information_retrieval");
    expect(RETRIEVAL_STRATEGY.data.examples.length).toBe(2);
  });

  it("should have EVIDENCE_QUALITY judgment", () => {
    expect(EVIDENCE_QUALITY.data.domain).toBe("evidence_quality");
  });
});

// ---------------------------------------------------------------------------
// Responsibility constant tests
// ---------------------------------------------------------------------------

describe("Responsibilities", () => {
  it("should have ORCHESTRATION responsibility", () => {
    expect(ORCHESTRATION.data.key).toBe("orchestration");
    expect(ORCHESTRATION.data.name).toBe("Work Orchestration");
    expect(ORCHESTRATION.data.examples.length).toBeGreaterThan(0);
  });

  it("should have QUALITY_GATE responsibility", () => {
    expect(QUALITY_GATE.data.key).toBe("quality_gate");
  });

  it("should have INTENT_ROUTING responsibility", () => {
    expect(INTENT_ROUTING.data.key).toBe("intent_routing");
  });

  it("should have RESPONSE_SYNTHESIS responsibility", () => {
    expect(RESPONSE_SYNTHESIS.data.key).toBe("response_synthesis");
  });

  it("should have INFORMATION_RETRIEVAL responsibility", () => {
    expect(INFORMATION_RETRIEVAL.data.key).toBe("information_retrieval");
  });

  it("should have ANALYSIS responsibility", () => {
    expect(ANALYSIS.data.key).toBe("analysis");
  });
});

// ---------------------------------------------------------------------------
// Role factory tests
// ---------------------------------------------------------------------------

describe("coordinatorRole", () => {
  it("should return a valid Role", () => {
    const role = coordinatorRole();
    expect(role).toBeInstanceOf(Role);
    expect(role.name).toBe("Coordinator");
  });

  it("should have delegation-focused persona", () => {
    const role = coordinatorRole();
    const prompt = role.persona.toPrompt();
    expect(prompt).toContain("orchestration specialist");
    expect(prompt).toContain("routes work");
  });

  it("should have routing and quality review judgments", () => {
    const role = coordinatorRole();
    expect(role.judgments).toHaveLength(2);
    expect(role.judgments[0]!.data.domain).toBe("work_routing");
    expect(role.judgments[1]!.data.domain).toBe("output_quality");
  });

  it("should have orchestration and quality gate responsibilities", () => {
    const role = coordinatorRole();
    expect(role.responsibilities).toHaveLength(2);
    expect(role.responsibilities[0]!.data.key).toBe("orchestration");
    expect(role.responsibilities[1]!.data.key).toBe("quality_gate");
  });
});

describe("orchestratorRole", () => {
  it("should return a valid Role", () => {
    const role = orchestratorRole();
    expect(role).toBeInstanceOf(Role);
    expect(role.name).toBe("Orchestrator");
  });

  it("should have conversational routing persona", () => {
    const role = orchestratorRole();
    const prompt = role.persona.toPrompt();
    expect(prompt).toContain("conversational agent");
  });

  it("should have intent classification judgment", () => {
    const role = orchestratorRole();
    expect(role.judgments).toHaveLength(1);
    expect(role.judgments[0]!.data.domain).toBe("user_intent");
  });

  it("should have intent routing and response synthesis responsibilities", () => {
    const role = orchestratorRole();
    expect(role.responsibilities).toHaveLength(2);
    expect(role.responsibilities[0]!.data.key).toBe("intent_routing");
    expect(role.responsibilities[1]!.data.key).toBe("response_synthesis");
  });
});

describe("analystRole", () => {
  it("should return a valid Role with default domain", () => {
    const role = analystRole();
    expect(role).toBeInstanceOf(Role);
    expect(role.name).toBe("Analyst");
    const prompt = role.persona.toPrompt();
    expect(prompt).toContain("general");
  });

  it("should customize domain in persona", () => {
    const role = analystRole({ domain: "MEDDPICC qualification" });
    const prompt = role.persona.toPrompt();
    expect(prompt).toContain("MEDDPICC qualification");
  });

  it("should have evidence quality judgment", () => {
    const role = analystRole();
    expect(role.judgments).toHaveLength(1);
    expect(role.judgments[0]!.data.domain).toBe("evidence_quality");
  });

  it("should include extra judgments when provided", () => {
    const extra = new Judgment({
      domain: "custom",
      heuristics: ["custom heuristic"],
    });
    const role = analystRole({ extraJudgments: [extra] });
    expect(role.judgments).toHaveLength(2);
    expect(role.judgments[1]!.data.domain).toBe("custom");
  });
});

describe("retrievalRole", () => {
  it("should return a valid Role", () => {
    const role = retrievalRole();
    expect(role).toBeInstanceOf(Role);
    expect(role.name).toBe("Retrieval");
  });

  it("should have retrieval and evidence quality judgments", () => {
    const role = retrievalRole();
    expect(role.judgments).toHaveLength(2);
    expect(role.judgments[0]!.data.domain).toBe("information_retrieval");
    expect(role.judgments[1]!.data.domain).toBe("evidence_quality");
  });

  it("should have information retrieval responsibility", () => {
    const role = retrievalRole();
    expect(role.responsibilities).toHaveLength(1);
    expect(role.responsibilities[0]!.data.key).toBe("information_retrieval");
  });

  it("should have retrieval-focused persona", () => {
    const role = retrievalRole();
    const prompt = role.persona.toPrompt();
    expect(prompt).toContain("intelligence analyst");
    expect(prompt).toContain("evidence");
  });
});

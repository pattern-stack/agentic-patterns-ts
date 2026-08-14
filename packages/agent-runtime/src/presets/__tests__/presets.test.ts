import { AgentBuilder, Judgment, Mission, Role } from "@pattern-stack/agentic-core";
import { describe, expect, it } from "vitest";
import { buildCalculatorAgent } from "../agents/calculator.js";
import { buildTodoAgent } from "../agents/todo-manager.js";
import { buildWritingCoachAgent } from "../agents/writing-coach.js";
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
    expect(ROUTING.data.escalationTriggers.length).toBeGreaterThan(0);
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

// ---------------------------------------------------------------------------
// Policy guard — no framework declaration pins a vendor model (#179/#222)
// ---------------------------------------------------------------------------
//
// A preset that carries a `defaultModel` silently pins a vendor's model onto
// every consumer who composes it — they inherit a model they never chose, it
// misleads introspection (the Roles page renders it as THE model), and it
// breaks anyone on another gateway/provider. An unset model must stay
// `undefined` so the runner resolves it (tier / AGENT_MODEL / gateway /
// profiles) or fails loud. Same policy `asAgent()` already enforces.

describe("no-silent-model-defaults policy (#179/#222)", () => {
  const roleFactories = [
    ["coordinatorRole", coordinatorRole],
    ["orchestratorRole", orchestratorRole],
    ["analystRole", analystRole],
    ["retrievalRole", retrievalRole],
  ] as const;

  for (const [name, factory] of roleFactories) {
    it(`${name}() declares no defaultModel`, () => {
      expect(factory().defaultModel).toBeUndefined();
    });
  }

  const agentBuilders = [
    ["buildCalculatorAgent", buildCalculatorAgent],
    ["buildTodoAgent", buildTodoAgent],
    ["buildWritingCoachAgent", buildWritingCoachAgent],
  ] as const;

  for (const [name, build] of agentBuilders) {
    it(`${name}() declares no model`, () => {
      const agent = build();
      expect(agent.getModel()).toBeUndefined();
      expect(agent.role.defaultModel).toBeUndefined();
    });
  }

  it("an agent composed from a preset role resolves model === undefined", () => {
    const agent = new AgentBuilder(coordinatorRole())
      .withMission(new Mission({ objective: "route work" }))
      .build();
    expect(agent.getModel()).toBeUndefined();
  });

  it("a consumer's own pin still wins — the presets are composable, not opinionated", () => {
    const agent = new AgentBuilder(coordinatorRole())
      .withMission(new Mission({ objective: "route work" }))
      .withModel("some-model-id")
      .build();
    expect(agent.getModel()).toBe("some-model-id");
  });
});

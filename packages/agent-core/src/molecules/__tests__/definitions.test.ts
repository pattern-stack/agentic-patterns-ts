import { describe, expect, it } from "vitest";
import {
  EscalationTriggerSchema,
  HealthSignalSchema,
  IssueTypeDefinitionSchema,
  PriorityDefinitionSchema,
  RuleDefinitionSchema,
  StateDefinitionSchema,
  TemplateDefinitionSchema,
  WorkflowStepDefinitionSchema,
} from "../definitions.js";

describe("Definition Schemas", () => {
  describe("WorkflowStepDefinitionSchema", () => {
    it("parses valid input", () => {
      const step = WorkflowStepDefinitionSchema.parse({
        key: "verify",
        name: "Verify Identity",
        description: "Check user identity",
      });
      expect(step.key).toBe("verify");
      expect(step.nextSteps).toEqual([]);
      expect(step.requires).toEqual([]);
    });

    it("rejects missing required fields", () => {
      expect(() => WorkflowStepDefinitionSchema.parse({ key: "x" })).toThrow();
    });
  });

  describe("RuleDefinitionSchema", () => {
    it("parses valid input", () => {
      const rule = RuleDefinitionSchema.parse({
        key: "no_pii",
        name: "No PII",
        condition: "When logging",
        action: "Redact PII",
        severity: "blocking",
      });
      expect(rule.severity).toBe("blocking");
    });

    it("rejects invalid severity", () => {
      expect(() =>
        RuleDefinitionSchema.parse({
          key: "x",
          name: "X",
          condition: "c",
          action: "a",
          severity: "invalid",
        }),
      ).toThrow();
    });
  });

  describe("TemplateDefinitionSchema", () => {
    it("parses valid input", () => {
      const tpl = TemplateDefinitionSchema.parse({
        key: "err",
        name: "Error Response",
        description: "Standard error",
        template: "Error: {{message}}",
        useWhen: "On error",
      });
      expect(tpl.template).toContain("{{message}}");
    });
  });

  describe("EscalationTriggerSchema", () => {
    it("parses valid input", () => {
      const trigger = EscalationTriggerSchema.parse({
        key: "legal",
        name: "Legal Threat",
        condition: "Legal language detected",
        escalateTo: "legal_team",
        urgency: "immediate",
      });
      expect(trigger.urgency).toBe("immediate");
    });

    it("rejects invalid urgency", () => {
      expect(() =>
        EscalationTriggerSchema.parse({
          key: "x",
          name: "X",
          condition: "c",
          escalateTo: "t",
          urgency: "invalid",
        }),
      ).toThrow();
    });
  });

  describe("StateDefinitionSchema", () => {
    it("parses with defaults", () => {
      const state = StateDefinitionSchema.parse({
        key: "backlog",
        name: "Backlog",
        description: "Items not yet started",
      });
      expect(state.isTerminal).toBe(false);
      expect(state.transitionsTo).toEqual([]);
    });
  });

  describe("PriorityDefinitionSchema", () => {
    it("parses valid input", () => {
      const priority = PriorityDefinitionSchema.parse({
        key: "p0",
        name: "Urgent",
        description: "Fix immediately",
        urgency: 0,
      });
      expect(priority.urgency).toBe(0);
    });
  });

  describe("IssueTypeDefinitionSchema", () => {
    it("parses with optional icon", () => {
      const issue = IssueTypeDefinitionSchema.parse({
        key: "bug",
        name: "Bug",
        description: "A defect",
      });
      expect(issue.icon).toBeUndefined();
    });

    it("parses with icon", () => {
      const issue = IssueTypeDefinitionSchema.parse({
        key: "bug",
        name: "Bug",
        description: "A defect",
        icon: "X",
      });
      expect(issue.icon).toBe("X");
    });
  });

  describe("HealthSignalSchema", () => {
    it("parses valid input", () => {
      const signal = HealthSignalSchema.parse({
        key: "stale",
        name: "Stale",
        condition: "No updates in 7 days",
        severity: "warning",
      });
      expect(signal.severity).toBe("warning");
    });

    it("rejects invalid severity", () => {
      expect(() =>
        HealthSignalSchema.parse({
          key: "x",
          name: "X",
          condition: "c",
          severity: "invalid",
        }),
      ).toThrow();
    });
  });
});

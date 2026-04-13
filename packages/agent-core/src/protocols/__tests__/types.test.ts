import { describe, expect, it } from "vitest";

import {
  DocType,
  DocTypeSchema,
  EnvironmentStatus,
  EnvironmentStatusSchema,
  IssueType,
  IssueTypeSchema,
  NetworkPolicy,
  NetworkPolicySchema,
  Priority,
  PrioritySchema,
  ProjectStatus,
  ProjectStatusSchema,
  RelationDirection,
  RelationDirectionSchema,
  RelationType,
  RelationTypeSchema,
  ResourceProfile,
  ResourceProfileSchema,
  SprintStatus,
  SprintStatusSchema,
  StatusCategory,
  StatusCategorySchema,
  TagGroup,
  TagGroupSchema,
  UserRole,
  UserRoleSchema,
  UserType,
  UserTypeSchema,
  WorkPhase,
  WorkPhaseSchema,
} from "../types.js";

describe("Shared enum types", () => {
  describe("StatusCategory", () => {
    it("has correct values matching Python", () => {
      expect(StatusCategory.TODO).toBe("todo");
      expect(StatusCategory.IN_PROGRESS).toBe("in_progress");
      expect(StatusCategory.IN_REVIEW).toBe("in_review");
      expect(StatusCategory.DONE).toBe("done");
      expect(StatusCategory.CANCELLED).toBe("cancelled");
    });

    it("validates with Zod schema", () => {
      expect(StatusCategorySchema.parse("todo")).toBe("todo");
      expect(StatusCategorySchema.parse("in_progress")).toBe("in_progress");
    });

    it("rejects invalid values", () => {
      expect(() => StatusCategorySchema.parse("invalid")).toThrow();
    });
  });

  describe("IssueType", () => {
    it("has correct values", () => {
      expect(IssueType.EPIC).toBe("epic");
      expect(IssueType.STORY).toBe("story");
      expect(IssueType.TASK).toBe("task");
      expect(IssueType.BUG).toBe("bug");
      expect(IssueType.SUBTASK).toBe("subtask");
    });

    it("validates with Zod schema", () => {
      expect(IssueTypeSchema.parse("epic")).toBe("epic");
    });

    it("rejects invalid values", () => {
      expect(() => IssueTypeSchema.parse("feature")).toThrow();
    });
  });

  describe("Priority", () => {
    it("has correct values", () => {
      expect(Priority.URGENT).toBe("urgent");
      expect(Priority.HIGH).toBe("high");
      expect(Priority.MEDIUM).toBe("medium");
      expect(Priority.LOW).toBe("low");
      expect(Priority.NONE).toBe("none");
    });

    it("validates with Zod schema", () => {
      expect(PrioritySchema.parse("urgent")).toBe("urgent");
    });
  });

  describe("RelationType", () => {
    it("has correct values", () => {
      expect(RelationType.PARENT_OF).toBe("parent_of");
      expect(RelationType.BLOCKS).toBe("blocks");
      expect(RelationType.RELATES_TO).toBe("relates_to");
      expect(RelationType.DUPLICATES).toBe("duplicates");
    });

    it("validates with Zod schema", () => {
      expect(RelationTypeSchema.parse("blocks")).toBe("blocks");
    });
  });

  describe("RelationDirection", () => {
    it("has correct values", () => {
      expect(RelationDirection.OUTGOING).toBe("outgoing");
      expect(RelationDirection.INCOMING).toBe("incoming");
      expect(RelationDirection.BOTH).toBe("both");
    });

    it("validates with Zod schema", () => {
      expect(RelationDirectionSchema.parse("both")).toBe("both");
    });
  });

  describe("WorkPhase", () => {
    it("has correct values", () => {
      expect(WorkPhase.PLANNING).toBe("planning");
      expect(WorkPhase.IMPLEMENTATION).toBe("implementation");
    });

    it("validates with Zod schema", () => {
      expect(WorkPhaseSchema.parse("planning")).toBe("planning");
    });
  });

  describe("ProjectStatus", () => {
    it("has correct values", () => {
      expect(ProjectStatus.BACKLOG).toBe("backlog");
      expect(ProjectStatus.PLANNING).toBe("planning");
      expect(ProjectStatus.ACTIVE).toBe("active");
      expect(ProjectStatus.ON_HOLD).toBe("on_hold");
      expect(ProjectStatus.COMPLETED).toBe("completed");
      expect(ProjectStatus.ARCHIVED).toBe("archived");
    });

    it("validates with Zod schema", () => {
      expect(ProjectStatusSchema.parse("active")).toBe("active");
    });
  });

  describe("SprintStatus", () => {
    it("has correct values", () => {
      expect(SprintStatus.PLANNED).toBe("planned");
      expect(SprintStatus.ACTIVE).toBe("active");
      expect(SprintStatus.COMPLETED).toBe("completed");
    });

    it("validates with Zod schema", () => {
      expect(SprintStatusSchema.parse("active")).toBe("active");
    });
  });

  describe("DocType", () => {
    it("has correct values", () => {
      expect(DocType.PRD).toBe("prd");
      expect(DocType.SPEC).toBe("spec");
      expect(DocType.RFC).toBe("rfc");
      expect(DocType.NOTE).toBe("note");
      expect(DocType.MEETING).toBe("meeting");
      expect(DocType.OTHER).toBe("other");
    });

    it("validates with Zod schema", () => {
      expect(DocTypeSchema.parse("prd")).toBe("prd");
    });
  });

  describe("TagGroup", () => {
    it("has correct values", () => {
      expect(TagGroup.ISSUE_TYPE).toBe("issue_type");
      expect(TagGroup.STACK).toBe("stack");
      expect(TagGroup.WORK_TYPE).toBe("work_type");
      expect(TagGroup.PHASE).toBe("phase");
      expect(TagGroup.PRIORITY).toBe("priority");
      expect(TagGroup.DOMAIN).toBe("domain");
      expect(TagGroup.STATE).toBe("state");
      expect(TagGroup.CUSTOM).toBe("custom");
    });

    it("validates with Zod schema", () => {
      expect(TagGroupSchema.parse("stack")).toBe("stack");
    });
  });

  describe("UserType", () => {
    it("has correct values", () => {
      expect(UserType.HUMAN).toBe("human");
      expect(UserType.BOT).toBe("bot");
      expect(UserType.AGENT).toBe("agent");
    });

    it("validates with Zod schema", () => {
      expect(UserTypeSchema.parse("agent")).toBe("agent");
    });
  });

  describe("UserRole", () => {
    it("has correct values", () => {
      expect(UserRole.ADMIN).toBe("admin");
      expect(UserRole.MEMBER).toBe("member");
      expect(UserRole.GUEST).toBe("guest");
    });

    it("validates with Zod schema", () => {
      expect(UserRoleSchema.parse("admin")).toBe("admin");
    });
  });

  describe("EnvironmentStatus", () => {
    it("has correct values", () => {
      expect(EnvironmentStatus.CREATED).toBe("created");
      expect(EnvironmentStatus.PROVISIONING).toBe("provisioning");
      expect(EnvironmentStatus.RUNNING).toBe("running");
      expect(EnvironmentStatus.STOPPED).toBe("stopped");
      expect(EnvironmentStatus.DESTROYED).toBe("destroyed");
    });

    it("validates with Zod schema", () => {
      expect(EnvironmentStatusSchema.parse("running")).toBe("running");
    });
  });

  describe("ResourceProfile", () => {
    it("has correct values", () => {
      expect(ResourceProfile.LIGHT).toBe("light");
      expect(ResourceProfile.STANDARD).toBe("standard");
      expect(ResourceProfile.HEAVY).toBe("heavy");
      expect(ResourceProfile.GPU).toBe("gpu");
    });

    it("validates with Zod schema", () => {
      expect(ResourceProfileSchema.parse("standard")).toBe("standard");
    });
  });

  describe("NetworkPolicy", () => {
    it("has correct values", () => {
      expect(NetworkPolicy.FULL).toBe("full");
      expect(NetworkPolicy.RESTRICTED).toBe("restricted");
      expect(NetworkPolicy.ISOLATED).toBe("isolated");
      expect(NetworkPolicy.AIRGAPPED).toBe("airgapped");
    });

    it("validates with Zod schema", () => {
      expect(NetworkPolicySchema.parse("full")).toBe("full");
    });
  });

  describe("type narrowing", () => {
    it("works in switch statements for exhaustiveness", () => {
      const check = (s: StatusCategory): string => {
        switch (s) {
          case StatusCategory.TODO:
            return "todo";
          case StatusCategory.IN_PROGRESS:
            return "in_progress";
          case StatusCategory.IN_REVIEW:
            return "in_review";
          case StatusCategory.DONE:
            return "done";
          case StatusCategory.CANCELLED:
            return "cancelled";
        }
      };
      expect(check("todo")).toBe("todo");
      expect(check("done")).toBe("done");
    });
  });
});

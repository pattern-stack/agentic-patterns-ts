import { describe, expect, it } from "vitest";

import { CommentSchema, ReactionSchema } from "../comment.js";
import {
  CreateDocumentInputSchema,
  DocumentFilterSchema,
  DocumentSchema,
  UpdateDocumentInputSchema,
} from "../document.js";
import {
  CreateEnvironmentInputSchema,
  EnvironmentFilterSchema,
  EnvironmentSchema,
  SandboxEnvironmentSchema,
  UpdateEnvironmentInputSchema,
} from "../environment.js";
import {
  CreateProjectInputSchema,
  ProjectFilterSchema,
  ProjectSchema,
  UpdateProjectInputSchema,
} from "../project.js";
import { CreateSprintInputSchema, SprintSchema, UpdateSprintInputSchema } from "../sprint.js";
import { CreateTagInputSchema, TagFilterSchema, TagSchema, UpdateTagInputSchema } from "../tag.js";
import {
  CreateTaskInputSchema,
  RelationSchema,
  TaskFilterSchema,
  TaskSchema,
  UpdateTaskInputSchema,
} from "../task.js";
import { TeamSchema, UserFilterSchema, UserSchema } from "../user.js";

const now = new Date();

describe("Task schemas", () => {
  it("validates a complete Task", () => {
    const result = TaskSchema.parse({
      id: "t-1",
      title: "Fix bug",
      description: "Something is broken",
      phase: "planning",
      statusCategory: "todo",
      issueType: "bug",
      priority: "high",
      status: "Open",
      assigneeId: "u-1",
      projectId: "p-1",
      tagIds: ["tag-1"],
      createdAt: now,
      updatedAt: now,
    });
    expect(result.id).toBe("t-1");
    expect(result.priority).toBe("high");
  });

  it("applies defaults for Task", () => {
    const result = TaskSchema.parse({
      id: "t-2",
      title: "New task",
      status: "Open",
      createdAt: now,
      updatedAt: now,
    });
    expect(result.phase).toBe("planning");
    expect(result.statusCategory).toBe("todo");
    expect(result.priority).toBe("none");
    expect(result.tagIds).toEqual([]);
  });

  it("rejects Task without required fields", () => {
    expect(() => TaskSchema.parse({ id: "t-1" })).toThrow();
  });

  it("validates Relation", () => {
    const result = RelationSchema.parse({
      sourceId: "t-1",
      targetId: "t-2",
      relationType: "blocks",
    });
    expect(result.relationType).toBe("blocks");
  });

  it("validates TaskFilter (all optional)", () => {
    const result = TaskFilterSchema.parse({});
    expect(result).toEqual({});
  });

  it("validates TaskFilter with fields", () => {
    const result = TaskFilterSchema.parse({
      phase: "planning",
      hasBlockers: true,
    });
    expect(result.phase).toBe("planning");
    expect(result.hasBlockers).toBe(true);
  });

  it("validates CreateTaskInput with defaults", () => {
    const result = CreateTaskInputSchema.parse({ title: "New" });
    expect(result.phase).toBe("planning");
    expect(result.statusCategory).toBe("todo");
    expect(result.priority).toBe("none");
    expect(result.tagIds).toEqual([]);
  });

  it("validates UpdateTaskInput (only id required)", () => {
    const result = UpdateTaskInputSchema.parse({ id: "t-1", title: "Updated" });
    expect(result.id).toBe("t-1");
    expect(result.title).toBe("Updated");
  });
});

describe("Project schemas", () => {
  it("validates a complete Project", () => {
    const result = ProjectSchema.parse({
      id: "p-1",
      name: "My Project",
      statusCategory: "active",
      teamIds: ["team-1"],
      createdAt: now,
      updatedAt: now,
    });
    expect(result.name).toBe("My Project");
    expect(result.statusCategory).toBe("active");
  });

  it("applies defaults for Project", () => {
    const result = ProjectSchema.parse({
      id: "p-1",
      name: "Proj",
      createdAt: now,
      updatedAt: now,
    });
    expect(result.statusCategory).toBe("backlog");
    expect(result.teamIds).toEqual([]);
  });

  it("validates ProjectFilter", () => {
    const result = ProjectFilterSchema.parse({ statusCategory: "active" });
    expect(result.statusCategory).toBe("active");
  });

  it("validates CreateProjectInput", () => {
    const result = CreateProjectInputSchema.parse({ name: "New" });
    expect(result.statusCategory).toBe("backlog");
    expect(result.teamIds).toEqual([]);
  });

  it("validates UpdateProjectInput", () => {
    const result = UpdateProjectInputSchema.parse({
      id: "p-1",
      name: "Renamed",
    });
    expect(result.id).toBe("p-1");
  });
});

describe("Tag schemas", () => {
  it("validates a complete Tag", () => {
    const result = TagSchema.parse({
      id: "tag-1",
      name: "Frontend",
      color: "#ff0000",
      group: "stack",
      isExclusive: true,
    });
    expect(result.group).toBe("stack");
    expect(result.isExclusive).toBe(true);
  });

  it("applies defaults for Tag", () => {
    const result = TagSchema.parse({ id: "tag-1", name: "Test" });
    expect(result.group).toBe("custom");
    expect(result.isExclusive).toBe(false);
  });

  it("validates TagFilter", () => {
    const result = TagFilterSchema.parse({ group: "domain" });
    expect(result.group).toBe("domain");
  });

  it("validates CreateTagInput", () => {
    const result = CreateTagInputSchema.parse({ name: "Backend" });
    expect(result.group).toBe("custom");
  });

  it("validates UpdateTagInput", () => {
    const result = UpdateTagInputSchema.parse({ id: "tag-1", name: "API" });
    expect(result.id).toBe("tag-1");
  });
});

describe("User schemas", () => {
  it("validates a complete User", () => {
    const result = UserSchema.parse({
      id: "u-1",
      name: "Alice",
      email: "alice@example.com",
      userType: "human",
      role: "admin",
      isActive: true,
    });
    expect(result.role).toBe("admin");
  });

  it("applies defaults for User", () => {
    const result = UserSchema.parse({ id: "u-1", name: "Bob" });
    expect(result.userType).toBe("human");
    expect(result.role).toBe("member");
    expect(result.isActive).toBe(true);
  });

  it("validates Team", () => {
    const result = TeamSchema.parse({
      id: "team-1",
      name: "Engineering",
      key: "ENG",
      memberIds: ["u-1", "u-2"],
    });
    expect(result.key).toBe("ENG");
    expect(result.memberIds).toEqual(["u-1", "u-2"]);
  });

  it("applies defaults for Team", () => {
    const result = TeamSchema.parse({ id: "team-1", name: "Design" });
    expect(result.memberIds).toEqual([]);
  });

  it("validates UserFilter", () => {
    const result = UserFilterSchema.parse({
      userType: "agent",
      isActive: true,
    });
    expect(result.userType).toBe("agent");
  });
});

describe("Sprint schemas", () => {
  it("validates a complete Sprint", () => {
    const result = SprintSchema.parse({
      id: "s-1",
      name: "Sprint 1",
      number: 1,
      startsAt: now,
      endsAt: now,
      status: "active",
      teamId: "team-1",
    });
    expect(result.status).toBe("active");
    expect(result.number).toBe(1);
  });

  it("validates CreateSprintInput", () => {
    const result = CreateSprintInputSchema.parse({
      startsAt: now,
      endsAt: now,
    });
    expect(result.name).toBeUndefined();
  });

  it("validates UpdateSprintInput", () => {
    const result = UpdateSprintInputSchema.parse({
      id: "s-1",
      name: "Sprint 2",
    });
    expect(result.id).toBe("s-1");
  });
});

describe("Comment schemas", () => {
  it("validates a complete Comment", () => {
    const result = CommentSchema.parse({
      id: "c-1",
      body: "Looks good!",
      issueId: "t-1",
      authorId: "u-1",
      createdAt: now,
      updatedAt: now,
    });
    expect(result.body).toBe("Looks good!");
  });

  it("validates Comment with optional fields", () => {
    const result = CommentSchema.parse({
      id: "c-2",
      body: "Reply",
      issueId: "t-1",
      authorId: "u-2",
      parentId: "c-1",
      createdAt: now,
      updatedAt: now,
      editedAt: now,
    });
    expect(result.parentId).toBe("c-1");
    expect(result.editedAt).toEqual(now);
  });

  it("validates Reaction", () => {
    const result = ReactionSchema.parse({
      id: "r-1",
      emoji: "thumbsup",
      userId: "u-1",
      commentId: "c-1",
    });
    expect(result.emoji).toBe("thumbsup");
  });
});

describe("Document schemas", () => {
  it("validates a complete Document", () => {
    const result = DocumentSchema.parse({
      id: "d-1",
      title: "Architecture",
      content: "# Architecture\n...",
      docType: "spec",
      createdBy: "u-1",
      createdAt: now,
      updatedAt: now,
    });
    expect(result.docType).toBe("spec");
  });

  it("applies defaults for Document", () => {
    const result = DocumentSchema.parse({
      id: "d-2",
      title: "Note",
      content: "Quick note",
      createdBy: "u-1",
      createdAt: now,
      updatedAt: now,
    });
    expect(result.docType).toBe("other");
  });

  it("validates DocumentFilter", () => {
    const result = DocumentFilterSchema.parse({ docType: "prd" });
    expect(result.docType).toBe("prd");
  });

  it("validates CreateDocumentInput", () => {
    const result = CreateDocumentInputSchema.parse({
      title: "RFC",
      content: "Proposal...",
    });
    expect(result.docType).toBe("other");
  });

  it("validates UpdateDocumentInput", () => {
    const result = UpdateDocumentInputSchema.parse({
      id: "d-1",
      title: "Updated",
    });
    expect(result.id).toBe("d-1");
  });
});

describe("Environment schemas", () => {
  it("validates SandboxEnvironment with defaults", () => {
    const result = SandboxEnvironmentSchema.parse({ name: "dev" });
    expect(result.baseImage).toBe("ubuntu-24.04-agent-base");
    expect(result.resourceProfile).toBe("standard");
    expect(result.enableGui).toBe(true);
    expect(result.agentRole).toBe("coder");
  });

  it("validates a complete Environment", () => {
    const result = EnvironmentSchema.parse({
      id: "env-1",
      name: "Dev Box",
      status: "running",
      spec: { name: "dev" },
      createdAt: now,
      updatedAt: now,
    });
    expect(result.status).toBe("running");
    expect(result.provider).toBe("proxmox");
    expect(result.spec.name).toBe("dev");
  });

  it("validates CreateEnvironmentInput", () => {
    const result = CreateEnvironmentInputSchema.parse({
      name: "Test Box",
      spec: { name: "test" },
    });
    expect(result.name).toBe("Test Box");
    expect(result.spec.resourceProfile).toBe("standard");
  });

  it("validates UpdateEnvironmentInput", () => {
    const result = UpdateEnvironmentInputSchema.parse({
      id: "env-1",
      status: "stopped",
    });
    expect(result.status).toBe("stopped");
  });

  it("validates EnvironmentFilter", () => {
    const result = EnvironmentFilterSchema.parse({
      status: "running",
      resourceProfile: "heavy",
    });
    expect(result.status).toBe("running");
    expect(result.resourceProfile).toBe("heavy");
  });
});

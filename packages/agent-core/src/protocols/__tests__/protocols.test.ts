import { describe, expect, it } from "vitest";

import type {
  Comment,
  CommentProtocol,
  Document,
  DocumentProtocol,
  Environment,
  EnvironmentProtocol,
  Project,
  ProjectProtocol,
  Reaction,
  Relation,
  Sprint,
  SprintProtocol,
  Tag,
  TagProtocol,
  Task,
  TaskProtocol,
  Team,
  User,
  UserProtocol,
} from "../index.js";

/**
 * These tests verify that each protocol interface is implementable.
 * We create mock implementations and verify they compile and return
 * the expected types.
 */

const now = new Date();

const mockTask: Task = {
  id: "t-1",
  title: "Test",
  phase: "planning",
  statusCategory: "todo",
  priority: "none",
  status: "Open",
  tagIds: [],
  createdAt: now,
  updatedAt: now,
};

const mockRelation: Relation = {
  sourceId: "t-1",
  targetId: "t-2",
  relationType: "blocks",
};

describe("TaskProtocol", () => {
  it("is implementable as a mock", async () => {
    const mock: TaskProtocol = {
      createTask: async () => mockTask,
      getTask: async () => mockTask,
      updateTask: async () => mockTask,
      listTasks: async () => [mockTask],
      deleteTask: async () => {},
      createTasks: async () => [mockTask],
      getTasks: async () => [mockTask],
      updateTasks: async () => [mockTask],
      deleteTasks: async () => {},
      advancePhase: async () => mockTask,
      addRelation: async () => {},
      removeRelation: async () => {},
      getRelations: async () => [mockRelation],
      addRelations: async () => {},
      removeRelations: async () => {},
    };

    const result = await mock.getTask("t-1");
    expect(result.id).toBe("t-1");

    const relations = await mock.getRelations("t-1");
    expect(relations).toHaveLength(1);
  });
});

const mockProject: Project = {
  id: "p-1",
  name: "Project",
  statusCategory: "active",
  teamIds: [],
  createdAt: now,
  updatedAt: now,
};

describe("ProjectProtocol", () => {
  it("is implementable as a mock", async () => {
    const mock: ProjectProtocol = {
      createProject: async () => mockProject,
      getProject: async () => mockProject,
      updateProject: async () => mockProject,
      listProjects: async () => [mockProject],
      deleteProject: async () => {},
      getProjects: async () => [mockProject],
      updateProjects: async () => [mockProject],
    };

    const result = await mock.listProjects();
    expect(result).toHaveLength(1);
  });
});

const mockTag: Tag = {
  id: "tag-1",
  name: "Frontend",
  group: "stack",
  isExclusive: false,
};

describe("TagProtocol", () => {
  it("is implementable as a mock", async () => {
    const mock: TagProtocol = {
      createTag: async () => mockTag,
      getTag: async () => mockTag,
      updateTag: async () => mockTag,
      listTags: async () => [mockTag],
      deleteTag: async () => {},
      createTags: async () => [mockTag],
      getTags: async () => [mockTag],
      deleteTags: async () => {},
      applyTag: async () => {},
      removeTag: async () => {},
      getEntityTags: async () => [mockTag],
      applyTags: async () => {},
      removeTags: async () => {},
      setEntityTags: async () => {},
      applyTagToEntities: async () => {},
      getEntitiesTags: async () => ({ "t-1": [mockTag] }),
    };

    const tags = await mock.getEntitiesTags(["t-1"]);
    expect(tags["t-1"]).toHaveLength(1);
  });
});

const mockUser: User = {
  id: "u-1",
  name: "Alice",
  userType: "human",
  role: "member",
  isActive: true,
};

const mockTeam: Team = {
  id: "team-1",
  name: "Engineering",
  memberIds: ["u-1"],
};

describe("UserProtocol", () => {
  it("is implementable as a mock (read-only)", async () => {
    const mock: UserProtocol = {
      getUser: async () => mockUser,
      getCurrentUser: async () => mockUser,
      listUsers: async () => [mockUser],
      getUsers: async () => [mockUser],
      getTeam: async () => mockTeam,
      listTeams: async () => [mockTeam],
      getTeamMembers: async () => [mockUser],
    };

    const user = await mock.getCurrentUser();
    expect(user.name).toBe("Alice");

    const team = await mock.getTeam("team-1");
    expect(team.memberIds).toContain("u-1");
  });
});

const mockSprint: Sprint = {
  id: "s-1",
  name: "Sprint 1",
  number: 1,
  startsAt: now,
  endsAt: now,
  status: "active",
  teamId: "team-1",
};

describe("SprintProtocol", () => {
  it("is implementable and returns Task[] from getSprintIssues", async () => {
    const mock: SprintProtocol = {
      getSprint: async () => mockSprint,
      getActiveSprint: async () => mockSprint,
      listSprints: async () => [mockSprint],
      getSprintIssues: async () => [mockTask],
      createSprint: async () => mockSprint,
      updateSprint: async () => mockSprint,
      addToSprint: async () => {},
      removeFromSprint: async () => {},
    };

    const issues = await mock.getSprintIssues("s-1");
    expect(issues[0]?.id).toBe("t-1");
  });
});

const mockComment: Comment = {
  id: "c-1",
  body: "Good work",
  issueId: "t-1",
  authorId: "u-1",
  createdAt: now,
  updatedAt: now,
};

const mockReaction: Reaction = {
  id: "r-1",
  emoji: "thumbsup",
  userId: "u-1",
  commentId: "c-1",
};

describe("CommentProtocol", () => {
  it("is implementable as a mock", async () => {
    const mock: CommentProtocol = {
      createComment: async () => mockComment,
      getComment: async () => mockComment,
      listComments: async () => [mockComment],
      updateComment: async () => mockComment,
      deleteComment: async () => {},
      addReaction: async () => mockReaction,
      removeReaction: async () => {},
      listReactions: async () => [mockReaction],
    };

    const reactions = await mock.listReactions("c-1");
    expect(reactions[0]?.emoji).toBe("thumbsup");
  });
});

const mockDocument: Document = {
  id: "d-1",
  title: "Spec",
  content: "# Spec",
  docType: "spec",
  createdBy: "u-1",
  createdAt: now,
  updatedAt: now,
};

describe("DocumentProtocol", () => {
  it("is implementable as a mock", async () => {
    const mock: DocumentProtocol = {
      createDocument: async () => mockDocument,
      getDocument: async () => mockDocument,
      listDocuments: async () => [mockDocument],
      updateDocument: async () => mockDocument,
      deleteDocument: async () => {},
      searchDocuments: async () => [mockDocument],
    };

    const results = await mock.searchDocuments("architecture");
    expect(results).toHaveLength(1);
  });
});

const mockEnvironment: Environment = {
  id: "env-1",
  name: "Dev",
  status: "running",
  spec: {
    name: "dev",
    baseImage: "ubuntu-24.04-agent-base",
    resourceProfile: "standard",
    resources: {
      cpuCores: 4,
      memoryMb: 8192,
      swapMb: 2048,
      diskGb: 50,
      gpuPassthrough: false,
    },
    toolchain: {
      pythonVersions: ["3.12"],
      pythonDefault: "3.12",
      nodeVersion: "20",
      installDocker: false,
      installPlaywright: false,
      installCodeServer: false,
      extraAptPackages: [],
      extraPipPackages: [],
      extraNpmPackages: [],
    },
    network: {
      policy: "full",
      portForwards: {},
      dnsAliases: [],
    },
    enableGui: true,
    enableBrowser: false,
    agentRole: "coder",
    envVars: {},
  },
  provider: "proxmox",
  createdAt: now,
  updatedAt: now,
};

describe("EnvironmentProtocol", () => {
  it("is implementable as a mock", async () => {
    const mock: EnvironmentProtocol = {
      createEnvironment: async () => mockEnvironment,
      getEnvironment: async () => mockEnvironment,
      listEnvironments: async () => [mockEnvironment],
      updateEnvironment: async () => mockEnvironment,
      destroyEnvironment: async () => {},
      startEnvironment: async () => mockEnvironment,
      stopEnvironment: async () => mockEnvironment,
    };

    const env = await mock.startEnvironment("env-1");
    expect(env.spec.resourceProfile).toBe("standard");
  });
});

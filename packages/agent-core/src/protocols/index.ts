/**
 * Protocol interfaces for external systems.
 *
 * Re-exports all protocols, data models, and enums.
 */

// Shared enums and base types
export {
  StatusCategory,
  StatusCategorySchema,
  IssueType,
  IssueTypeSchema,
  Priority,
  PrioritySchema,
  RelationType,
  RelationTypeSchema,
  RelationDirection,
  RelationDirectionSchema,
  WorkPhase,
  WorkPhaseSchema,
  ProjectStatus,
  ProjectStatusSchema,
  SprintStatus,
  SprintStatusSchema,
  DocType,
  DocTypeSchema,
  TagGroup,
  TagGroupSchema,
  UserType,
  UserTypeSchema,
  UserRole,
  UserRoleSchema,
  EnvironmentStatus,
  EnvironmentStatusSchema,
  ResourceProfile,
  ResourceProfileSchema,
  NetworkPolicy,
  NetworkPolicySchema,
} from "./types.js";

// Task protocol
export {
  TaskSchema,
  RelationSchema,
  TaskFilterSchema,
  CreateTaskInputSchema,
  UpdateTaskInputSchema,
} from "./task.js";
export type {
  Task,
  Relation,
  TaskFilter,
  CreateTaskInput,
  UpdateTaskInput,
  TaskProtocol,
} from "./task.js";

// Project protocol
export {
  ProjectSchema,
  ProjectFilterSchema,
  CreateProjectInputSchema,
  UpdateProjectInputSchema,
} from "./project.js";
export type {
  Project,
  ProjectFilter,
  CreateProjectInput,
  UpdateProjectInput,
  ProjectProtocol,
} from "./project.js";

// Tag protocol
export {
  TagSchema,
  TagFilterSchema,
  CreateTagInputSchema,
  UpdateTagInputSchema,
} from "./tag.js";
export type {
  Tag,
  TagFilter,
  CreateTagInput,
  UpdateTagInput,
  TagProtocol,
} from "./tag.js";

// User protocol
export { UserSchema, TeamSchema, UserFilterSchema } from "./user.js";
export type { User, Team, UserFilter, UserProtocol } from "./user.js";

// Sprint protocol
export {
  SprintSchema,
  CreateSprintInputSchema,
  UpdateSprintInputSchema,
} from "./sprint.js";
export type {
  Sprint,
  CreateSprintInput,
  UpdateSprintInput,
  SprintProtocol,
} from "./sprint.js";

// Comment protocol
export { CommentSchema, ReactionSchema } from "./comment.js";
export type { Comment, Reaction, CommentProtocol } from "./comment.js";

// Document protocol
export {
  DocumentSchema,
  DocumentFilterSchema,
  CreateDocumentInputSchema,
  UpdateDocumentInputSchema,
} from "./document.js";
export type {
  Document,
  DocumentFilter,
  CreateDocumentInput,
  UpdateDocumentInput,
  DocumentProtocol,
} from "./document.js";

// Environment protocol
export {
  SandboxToolchainSchema,
  SandboxResourcesSchema,
  SandboxNetworkSchema,
  SandboxEnvironmentSchema,
  EnvironmentSchema,
  CreateEnvironmentInputSchema,
  UpdateEnvironmentInputSchema,
  EnvironmentFilterSchema,
} from "./environment.js";
export type {
  SandboxToolchain,
  SandboxResources,
  SandboxNetwork,
  SandboxEnvironment,
  Environment,
  CreateEnvironmentInput,
  UpdateEnvironmentInput,
  EnvironmentFilter,
  EnvironmentProtocol,
} from "./environment.js";

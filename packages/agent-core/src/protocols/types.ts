/**
 * Shared enums and base types for protocol layer.
 *
 * Each enum is defined as a `const` object + inferred union type (idiomatic TS),
 * with a corresponding Zod schema for runtime validation.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// StatusCategory
// ---------------------------------------------------------------------------

export const StatusCategory = {
  TODO: "todo",
  IN_PROGRESS: "in_progress",
  IN_REVIEW: "in_review",
  DONE: "done",
  CANCELLED: "cancelled",
} as const;
export type StatusCategory = (typeof StatusCategory)[keyof typeof StatusCategory];
export const StatusCategorySchema = z.enum([
  "todo",
  "in_progress",
  "in_review",
  "done",
  "cancelled",
]);

// ---------------------------------------------------------------------------
// IssueType
// ---------------------------------------------------------------------------

export const IssueType = {
  EPIC: "epic",
  STORY: "story",
  TASK: "task",
  BUG: "bug",
  SUBTASK: "subtask",
} as const;
export type IssueType = (typeof IssueType)[keyof typeof IssueType];
export const IssueTypeSchema = z.enum(["epic", "story", "task", "bug", "subtask"]);

// ---------------------------------------------------------------------------
// Priority
// ---------------------------------------------------------------------------

export const Priority = {
  URGENT: "urgent",
  HIGH: "high",
  MEDIUM: "medium",
  LOW: "low",
  NONE: "none",
} as const;
export type Priority = (typeof Priority)[keyof typeof Priority];
export const PrioritySchema = z.enum(["urgent", "high", "medium", "low", "none"]);

// ---------------------------------------------------------------------------
// RelationType
// ---------------------------------------------------------------------------

export const RelationType = {
  PARENT_OF: "parent_of",
  BLOCKS: "blocks",
  RELATES_TO: "relates_to",
  DUPLICATES: "duplicates",
} as const;
export type RelationType = (typeof RelationType)[keyof typeof RelationType];
export const RelationTypeSchema = z.enum(["parent_of", "blocks", "relates_to", "duplicates"]);

// ---------------------------------------------------------------------------
// RelationDirection
// ---------------------------------------------------------------------------

export const RelationDirection = {
  OUTGOING: "outgoing",
  INCOMING: "incoming",
  BOTH: "both",
} as const;
export type RelationDirection = (typeof RelationDirection)[keyof typeof RelationDirection];
export const RelationDirectionSchema = z.enum(["outgoing", "incoming", "both"]);

// ---------------------------------------------------------------------------
// WorkPhase
// ---------------------------------------------------------------------------

export const WorkPhase = {
  PLANNING: "planning",
  IMPLEMENTATION: "implementation",
} as const;
export type WorkPhase = (typeof WorkPhase)[keyof typeof WorkPhase];
export const WorkPhaseSchema = z.enum(["planning", "implementation"]);

// ---------------------------------------------------------------------------
// ProjectStatus
// ---------------------------------------------------------------------------

export const ProjectStatus = {
  BACKLOG: "backlog",
  PLANNING: "planning",
  ACTIVE: "active",
  ON_HOLD: "on_hold",
  COMPLETED: "completed",
  ARCHIVED: "archived",
} as const;
export type ProjectStatus = (typeof ProjectStatus)[keyof typeof ProjectStatus];
export const ProjectStatusSchema = z.enum([
  "backlog",
  "planning",
  "active",
  "on_hold",
  "completed",
  "archived",
]);

// ---------------------------------------------------------------------------
// SprintStatus
// ---------------------------------------------------------------------------

export const SprintStatus = {
  PLANNED: "planned",
  ACTIVE: "active",
  COMPLETED: "completed",
} as const;
export type SprintStatus = (typeof SprintStatus)[keyof typeof SprintStatus];
export const SprintStatusSchema = z.enum(["planned", "active", "completed"]);

// ---------------------------------------------------------------------------
// DocType
// ---------------------------------------------------------------------------

export const DocType = {
  PRD: "prd",
  SPEC: "spec",
  RFC: "rfc",
  NOTE: "note",
  MEETING: "meeting",
  OTHER: "other",
} as const;
export type DocType = (typeof DocType)[keyof typeof DocType];
export const DocTypeSchema = z.enum(["prd", "spec", "rfc", "note", "meeting", "other"]);

// ---------------------------------------------------------------------------
// TagGroup
// ---------------------------------------------------------------------------

export const TagGroup = {
  ISSUE_TYPE: "issue_type",
  STACK: "stack",
  WORK_TYPE: "work_type",
  PHASE: "phase",
  PRIORITY: "priority",
  DOMAIN: "domain",
  STATE: "state",
  CUSTOM: "custom",
} as const;
export type TagGroup = (typeof TagGroup)[keyof typeof TagGroup];
export const TagGroupSchema = z.enum([
  "issue_type",
  "stack",
  "work_type",
  "phase",
  "priority",
  "domain",
  "state",
  "custom",
]);

// ---------------------------------------------------------------------------
// UserType
// ---------------------------------------------------------------------------

export const UserType = {
  HUMAN: "human",
  BOT: "bot",
  AGENT: "agent",
} as const;
export type UserType = (typeof UserType)[keyof typeof UserType];
export const UserTypeSchema = z.enum(["human", "bot", "agent"]);

// ---------------------------------------------------------------------------
// UserRole
// ---------------------------------------------------------------------------

export const UserRole = {
  ADMIN: "admin",
  MEMBER: "member",
  GUEST: "guest",
} as const;
export type UserRole = (typeof UserRole)[keyof typeof UserRole];
export const UserRoleSchema = z.enum(["admin", "member", "guest"]);

// ---------------------------------------------------------------------------
// EnvironmentStatus
// ---------------------------------------------------------------------------

export const EnvironmentStatus = {
  CREATED: "created",
  PROVISIONING: "provisioning",
  RUNNING: "running",
  STOPPED: "stopped",
  DESTROYED: "destroyed",
} as const;
export type EnvironmentStatus = (typeof EnvironmentStatus)[keyof typeof EnvironmentStatus];
export const EnvironmentStatusSchema = z.enum([
  "created",
  "provisioning",
  "running",
  "stopped",
  "destroyed",
]);

// ---------------------------------------------------------------------------
// ResourceProfile
// ---------------------------------------------------------------------------

export const ResourceProfile = {
  LIGHT: "light",
  STANDARD: "standard",
  HEAVY: "heavy",
  GPU: "gpu",
} as const;
export type ResourceProfile = (typeof ResourceProfile)[keyof typeof ResourceProfile];
export const ResourceProfileSchema = z.enum(["light", "standard", "heavy", "gpu"]);

// ---------------------------------------------------------------------------
// NetworkPolicy
// ---------------------------------------------------------------------------

export const NetworkPolicy = {
  FULL: "full",
  RESTRICTED: "restricted",
  ISOLATED: "isolated",
  AIRGAPPED: "airgapped",
} as const;
export type NetworkPolicy = (typeof NetworkPolicy)[keyof typeof NetworkPolicy];
export const NetworkPolicySchema = z.enum(["full", "restricted", "isolated", "airgapped"]);

/**
 * Task protocol - issue CRUD interface.
 *
 * Ported from: agentic_patterns/core/atoms/protocols/task.py
 */

import { z } from "zod";

import {
  IssueTypeSchema,
  PrioritySchema,
  RelationTypeSchema,
  StatusCategorySchema,
  WorkPhaseSchema,
} from "./types.js";
import type {
  IssueType,
  Priority,
  RelationDirection,
  RelationType,
  StatusCategory,
  WorkPhase,
} from "./types.js";

// ---------------------------------------------------------------------------
// Data Models (Zod schemas)
// ---------------------------------------------------------------------------

export const TaskSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().optional(),
  phase: WorkPhaseSchema.default("planning"),
  statusCategory: StatusCategorySchema.default("todo"),
  issueType: IssueTypeSchema.optional(),
  priority: PrioritySchema.default("none"),
  status: z.string(),
  assigneeId: z.string().optional(),
  projectId: z.string().optional(),
  tagIds: z.array(z.string()).default([]),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type Task = z.infer<typeof TaskSchema>;

export const RelationSchema = z.object({
  sourceId: z.string(),
  targetId: z.string(),
  relationType: RelationTypeSchema,
});
export type Relation = z.infer<typeof RelationSchema>;

export const TaskFilterSchema = z.object({
  phase: WorkPhaseSchema.optional(),
  statusCategory: StatusCategorySchema.optional(),
  issueType: IssueTypeSchema.optional(),
  assigneeId: z.string().optional(),
  projectId: z.string().optional(),
  tagIds: z.array(z.string()).optional(),
  hasBlockers: z.boolean().optional(),
});
export type TaskFilter = z.infer<typeof TaskFilterSchema>;

export const CreateTaskInputSchema = z.object({
  title: z.string(),
  description: z.string().optional(),
  phase: WorkPhaseSchema.default("planning"),
  statusCategory: StatusCategorySchema.default("todo"),
  issueType: IssueTypeSchema.optional(),
  priority: PrioritySchema.default("none"),
  assigneeId: z.string().optional(),
  projectId: z.string().optional(),
  tagIds: z.array(z.string()).default([]),
});
export type CreateTaskInput = z.infer<typeof CreateTaskInputSchema>;

export const UpdateTaskInputSchema = z.object({
  id: z.string(),
  title: z.string().optional(),
  description: z.string().optional(),
  phase: WorkPhaseSchema.optional(),
  statusCategory: StatusCategorySchema.optional(),
  issueType: IssueTypeSchema.optional(),
  priority: PrioritySchema.optional(),
  assigneeId: z.string().optional(),
  projectId: z.string().optional(),
});
export type UpdateTaskInput = z.infer<typeof UpdateTaskInputSchema>;

// ---------------------------------------------------------------------------
// Protocol Interface (15 methods)
// ---------------------------------------------------------------------------

export interface TaskProtocol {
  // CRUD
  createTask(input: CreateTaskInput): Promise<Task>;
  getTask(id: string): Promise<Task>;
  updateTask(input: UpdateTaskInput): Promise<Task>;
  listTasks(filter?: TaskFilter): Promise<Task[]>;
  deleteTask(id: string): Promise<void>;

  // Bulk
  createTasks(inputs: CreateTaskInput[]): Promise<Task[]>;
  getTasks(ids: string[]): Promise<Task[]>;
  updateTasks(inputs: UpdateTaskInput[]): Promise<Task[]>;
  deleteTasks(ids: string[]): Promise<void>;

  // Phase
  advancePhase(taskId: string): Promise<Task>;

  // Relations
  addRelation(sourceId: string, targetId: string, relationType: RelationType): Promise<void>;
  removeRelation(sourceId: string, targetId: string, relationType: RelationType): Promise<void>;
  getRelations(
    taskId: string,
    relationType?: RelationType,
    direction?: RelationDirection,
  ): Promise<Relation[]>;
  addRelations(relations: Relation[]): Promise<void>;
  removeRelations(relations: Relation[]): Promise<void>;
}

// Re-export enum types used by this protocol for convenience
export type { WorkPhase, StatusCategory, IssueType, Priority, RelationType, RelationDirection };

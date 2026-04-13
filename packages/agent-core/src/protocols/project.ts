/**
 * Project protocol - project CRUD interface.
 *
 * Ported from: agentic_patterns/core/atoms/protocols/project.py
 */

import { z } from "zod";

import { ProjectStatusSchema } from "./types.js";
import type { ProjectStatus } from "./types.js";

// ---------------------------------------------------------------------------
// Data Models (Zod schemas)
// ---------------------------------------------------------------------------

export const ProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  statusCategory: ProjectStatusSchema.default("backlog"),
  status: z.string().optional(),
  leadId: z.string().optional(),
  teamIds: z.array(z.string()).default([]),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type Project = z.infer<typeof ProjectSchema>;

export const ProjectFilterSchema = z.object({
  statusCategory: ProjectStatusSchema.optional(),
  leadId: z.string().optional(),
  teamId: z.string().optional(),
});
export type ProjectFilter = z.infer<typeof ProjectFilterSchema>;

export const CreateProjectInputSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  statusCategory: ProjectStatusSchema.default("backlog"),
  leadId: z.string().optional(),
  teamIds: z.array(z.string()).default([]),
});
export type CreateProjectInput = z.infer<typeof CreateProjectInputSchema>;

export const UpdateProjectInputSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  description: z.string().optional(),
  statusCategory: ProjectStatusSchema.optional(),
  leadId: z.string().optional(),
});
export type UpdateProjectInput = z.infer<typeof UpdateProjectInputSchema>;

// ---------------------------------------------------------------------------
// Protocol Interface (7 methods)
// ---------------------------------------------------------------------------

export interface ProjectProtocol {
  createProject(input: CreateProjectInput): Promise<Project>;
  getProject(id: string): Promise<Project>;
  updateProject(input: UpdateProjectInput): Promise<Project>;
  listProjects(filter?: ProjectFilter): Promise<Project[]>;
  deleteProject(id: string): Promise<void>;
  getProjects(ids: string[]): Promise<Project[]>;
  updateProjects(inputs: UpdateProjectInput[]): Promise<Project[]>;
}

export type { ProjectStatus };

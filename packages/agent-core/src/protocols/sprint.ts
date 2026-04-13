/**
 * Sprint protocol - time-boxed iteration management.
 *
 * Ported from: agentic_patterns/core/atoms/protocols/sprint.py
 */

import { z } from "zod";

import type { Task } from "./task.js";
import { SprintStatusSchema } from "./types.js";
import type { SprintStatus } from "./types.js";

// ---------------------------------------------------------------------------
// Data Models (Zod schemas)
// ---------------------------------------------------------------------------

export const SprintSchema = z.object({
  id: z.string(),
  name: z.string(),
  number: z.number().int(),
  startsAt: z.date(),
  endsAt: z.date(),
  status: SprintStatusSchema,
  teamId: z.string(),
  description: z.string().optional(),
  completedAt: z.date().optional(),
});
export type Sprint = z.infer<typeof SprintSchema>;

export const CreateSprintInputSchema = z.object({
  name: z.string().optional(),
  startsAt: z.date(),
  endsAt: z.date(),
  description: z.string().optional(),
});
export type CreateSprintInput = z.infer<typeof CreateSprintInputSchema>;

export const UpdateSprintInputSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  startsAt: z.date().optional(),
  endsAt: z.date().optional(),
  description: z.string().optional(),
});
export type UpdateSprintInput = z.infer<typeof UpdateSprintInputSchema>;

// ---------------------------------------------------------------------------
// Protocol Interface (8 methods)
// ---------------------------------------------------------------------------

export interface SprintProtocol {
  // Queries
  getSprint(id: string): Promise<Sprint>;
  getActiveSprint(): Promise<Sprint | undefined>;
  listSprints(status?: SprintStatus): Promise<Sprint[]>;
  getSprintIssues(sprintId: string): Promise<Task[]>;

  // Mutations
  createSprint(input: CreateSprintInput): Promise<Sprint>;
  updateSprint(input: UpdateSprintInput): Promise<Sprint>;
  addToSprint(issueId: string, sprintId: string): Promise<void>;
  removeFromSprint(issueId: string): Promise<void>;
}

export type { SprintStatus };

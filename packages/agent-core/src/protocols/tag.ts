/**
 * Tag protocol - universal tagging interface.
 *
 * Ported from: agentic_patterns/core/atoms/protocols/tag.py
 */

import { z } from "zod";

import { TagGroupSchema } from "./types.js";
import type { TagGroup } from "./types.js";

// ---------------------------------------------------------------------------
// Data Models (Zod schemas)
// ---------------------------------------------------------------------------

export const TagSchema = z.object({
  id: z.string(),
  name: z.string(),
  color: z.string().optional(),
  description: z.string().optional(),
  group: TagGroupSchema.default("custom"),
  isExclusive: z.boolean().default(false),
});
export type Tag = z.infer<typeof TagSchema>;

export const TagFilterSchema = z.object({
  group: TagGroupSchema.optional(),
  isExclusive: z.boolean().optional(),
});
export type TagFilter = z.infer<typeof TagFilterSchema>;

export const CreateTagInputSchema = z.object({
  name: z.string(),
  color: z.string().optional(),
  description: z.string().optional(),
  group: TagGroupSchema.default("custom"),
  isExclusive: z.boolean().default(false),
});
export type CreateTagInput = z.infer<typeof CreateTagInputSchema>;

export const UpdateTagInputSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  color: z.string().optional(),
  description: z.string().optional(),
  group: TagGroupSchema.optional(),
  isExclusive: z.boolean().optional(),
});
export type UpdateTagInput = z.infer<typeof UpdateTagInputSchema>;

// ---------------------------------------------------------------------------
// Protocol Interface (16 methods)
// ---------------------------------------------------------------------------

export interface TagProtocol {
  // CRUD
  createTag(input: CreateTagInput): Promise<Tag>;
  getTag(id: string): Promise<Tag>;
  updateTag(input: UpdateTagInput): Promise<Tag>;
  listTags(filter?: TagFilter): Promise<Tag[]>;
  deleteTag(id: string): Promise<void>;

  // Bulk CRUD
  createTags(inputs: CreateTagInput[]): Promise<Tag[]>;
  getTags(ids: string[]): Promise<Tag[]>;
  deleteTags(ids: string[]): Promise<void>;

  // Application (single entity)
  applyTag(entityId: string, tagId: string): Promise<void>;
  removeTag(entityId: string, tagId: string): Promise<void>;
  getEntityTags(entityId: string): Promise<Tag[]>;

  // Application (bulk)
  applyTags(entityId: string, tagIds: string[]): Promise<void>;
  removeTags(entityId: string, tagIds: string[]): Promise<void>;
  setEntityTags(entityId: string, tagIds: string[]): Promise<void>;
  applyTagToEntities(tagId: string, entityIds: string[]): Promise<void>;
  getEntitiesTags(entityIds: string[]): Promise<Record<string, Tag[]>>;
}

export type { TagGroup };

/**
 * Document protocol - PRD, spec, and documentation management interface.
 *
 * Ported from: agentic_patterns/core/atoms/protocols/document.py
 */

import { z } from "zod";

import { DocTypeSchema } from "./types.js";
import type { DocType } from "./types.js";

// ---------------------------------------------------------------------------
// Data Models (Zod schemas)
// ---------------------------------------------------------------------------

export const DocumentSchema = z.object({
  id: z.string(),
  title: z.string(),
  content: z.string(),
  slug: z.string().optional(),
  icon: z.string().optional(),
  docType: DocTypeSchema.default("other"),
  projectId: z.string().optional(),
  createdBy: z.string(),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type Document = z.infer<typeof DocumentSchema>;

export const DocumentFilterSchema = z.object({
  docType: DocTypeSchema.optional(),
  projectId: z.string().optional(),
  createdBy: z.string().optional(),
});
export type DocumentFilter = z.infer<typeof DocumentFilterSchema>;

export const CreateDocumentInputSchema = z.object({
  title: z.string(),
  content: z.string(),
  docType: DocTypeSchema.default("other"),
  projectId: z.string().optional(),
  icon: z.string().optional(),
});
export type CreateDocumentInput = z.infer<typeof CreateDocumentInputSchema>;

export const UpdateDocumentInputSchema = z.object({
  id: z.string(),
  title: z.string().optional(),
  content: z.string().optional(),
  docType: DocTypeSchema.optional(),
  icon: z.string().optional(),
});
export type UpdateDocumentInput = z.infer<typeof UpdateDocumentInputSchema>;

// ---------------------------------------------------------------------------
// Protocol Interface (6 methods)
// ---------------------------------------------------------------------------

export interface DocumentProtocol {
  // CRUD
  createDocument(input: CreateDocumentInput): Promise<Document>;
  getDocument(id: string): Promise<Document>;
  listDocuments(filter?: DocumentFilter): Promise<Document[]>;
  updateDocument(input: UpdateDocumentInput): Promise<Document>;
  deleteDocument(id: string): Promise<void>;

  // Search
  searchDocuments(query: string): Promise<Document[]>;
}

export type { DocType };

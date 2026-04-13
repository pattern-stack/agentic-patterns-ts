/**
 * Comment protocol - issue discussion and collaboration.
 *
 * Ported from: agentic_patterns/core/atoms/protocols/comment.py
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Data Models (Zod schemas)
// ---------------------------------------------------------------------------

export const CommentSchema = z.object({
  id: z.string(),
  body: z.string(),
  issueId: z.string(),
  authorId: z.string(),
  parentId: z.string().optional(),
  createdAt: z.date(),
  updatedAt: z.date(),
  editedAt: z.date().optional(),
});
export type Comment = z.infer<typeof CommentSchema>;

export const ReactionSchema = z.object({
  id: z.string(),
  emoji: z.string(),
  userId: z.string(),
  commentId: z.string(),
});
export type Reaction = z.infer<typeof ReactionSchema>;

// ---------------------------------------------------------------------------
// Protocol Interface (8 methods)
// ---------------------------------------------------------------------------

export interface CommentProtocol {
  // Comment CRUD
  createComment(issueId: string, body: string, parentId?: string): Promise<Comment>;
  getComment(id: string): Promise<Comment>;
  listComments(issueId: string): Promise<Comment[]>;
  updateComment(id: string, body: string): Promise<Comment>;
  deleteComment(id: string): Promise<void>;

  // Reactions
  addReaction(commentId: string, emoji: string): Promise<Reaction>;
  removeReaction(commentId: string, emoji: string): Promise<void>;
  listReactions(commentId: string): Promise<Reaction[]>;
}

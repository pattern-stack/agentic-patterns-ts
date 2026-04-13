/**
 * User protocol - user and team interface (read-only).
 *
 * Ported from: agentic_patterns/core/atoms/protocols/user.py
 */

import { z } from "zod";

import { UserRoleSchema, UserTypeSchema } from "./types.js";
import type { UserRole, UserType } from "./types.js";

// ---------------------------------------------------------------------------
// Data Models (Zod schemas)
// ---------------------------------------------------------------------------

export const UserSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string().optional(),
  avatarUrl: z.string().optional(),
  userType: UserTypeSchema.default("human"),
  role: UserRoleSchema.default("member"),
  isActive: z.boolean().default(true),
});
export type User = z.infer<typeof UserSchema>;

export const TeamSchema = z.object({
  id: z.string(),
  name: z.string(),
  key: z.string().optional(),
  description: z.string().optional(),
  memberIds: z.array(z.string()).default([]),
});
export type Team = z.infer<typeof TeamSchema>;

export const UserFilterSchema = z.object({
  userType: UserTypeSchema.optional(),
  role: UserRoleSchema.optional(),
  isActive: z.boolean().optional(),
  teamId: z.string().optional(),
});
export type UserFilter = z.infer<typeof UserFilterSchema>;

// ---------------------------------------------------------------------------
// Protocol Interface (7 methods, read-only)
// ---------------------------------------------------------------------------

export interface UserProtocol {
  // Users
  getUser(id: string): Promise<User>;
  getCurrentUser(): Promise<User>;
  listUsers(filter?: UserFilter): Promise<User[]>;
  getUsers(ids: string[]): Promise<User[]>;

  // Teams
  getTeam(id: string): Promise<Team>;
  listTeams(): Promise<Team[]>;
  getTeamMembers(teamId: string): Promise<User[]>;
}

export type { UserType, UserRole };

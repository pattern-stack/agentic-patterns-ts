/**
 * Environment protocol - sandbox environment CRUD interface.
 *
 * Ported from: agentic_patterns/core/atoms/protocols/environment.py
 *
 * Note: The Python source imports SandboxEnvironment and related types from
 * core/atoms/datatypes/sandbox.py. For the protocol layer, we define simplified
 * Zod schemas for the sandbox spec inline, since the full sandbox atom will be
 * ported in Phase 2 (atoms layer). The environment protocol references these
 * types for its data models.
 */

import { z } from "zod";

import { EnvironmentStatusSchema, NetworkPolicySchema, ResourceProfileSchema } from "./types.js";
import type { EnvironmentStatus, ResourceProfile } from "./types.js";

// ---------------------------------------------------------------------------
// Sandbox sub-schemas (matching Python sandbox.py structure)
// ---------------------------------------------------------------------------

export const SandboxToolchainSchema = z.object({
  pythonVersions: z.array(z.string()).default(["3.12"]),
  pythonDefault: z.string().default("3.12"),
  nodeVersion: z.string().default("20"),
  installDocker: z.boolean().default(false),
  installPlaywright: z.boolean().default(false),
  installCodeServer: z.boolean().default(false),
  extraAptPackages: z.array(z.string()).default([]),
  extraPipPackages: z.array(z.string()).default([]),
  extraNpmPackages: z.array(z.string()).default([]),
});
export type SandboxToolchain = z.infer<typeof SandboxToolchainSchema>;

export const SandboxResourcesSchema = z.object({
  cpuCores: z.number().int().default(4),
  memoryMb: z.number().int().default(8192),
  swapMb: z.number().int().default(2048),
  diskGb: z.number().int().default(50),
  gpuPassthrough: z.boolean().default(false),
});
export type SandboxResources = z.infer<typeof SandboxResourcesSchema>;

export const SandboxNetworkSchema = z.object({
  policy: NetworkPolicySchema.default("full"),
  staticIp: z.string().optional(),
  portForwards: z.record(z.string(), z.number()).default({}),
  dnsAliases: z.array(z.string()).default([]),
});
export type SandboxNetwork = z.infer<typeof SandboxNetworkSchema>;

export const SandboxEnvironmentSchema = z.object({
  name: z.string(),
  baseImage: z.string().default("ubuntu-24.04-agent-base"),
  resourceProfile: ResourceProfileSchema.default("standard"),
  resources: SandboxResourcesSchema.default({}),
  toolchain: SandboxToolchainSchema.default({}),
  network: SandboxNetworkSchema.default({}),
  enableGui: z.boolean().default(true),
  enableBrowser: z.boolean().default(false),
  agentRole: z.string().default("coder"),
  envVars: z.record(z.string(), z.string()).default({}),
});
export type SandboxEnvironment = z.infer<typeof SandboxEnvironmentSchema>;

// ---------------------------------------------------------------------------
// Environment Data Models (Zod schemas)
// ---------------------------------------------------------------------------

export const EnvironmentSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: EnvironmentStatusSchema,
  spec: SandboxEnvironmentSchema,
  instanceId: z.string().optional(),
  provider: z.string().default("proxmox"),
  deviceId: z.string().optional(),
  ipAddress: z.string().optional(),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type Environment = z.infer<typeof EnvironmentSchema>;

export const CreateEnvironmentInputSchema = z.object({
  name: z.string(),
  spec: SandboxEnvironmentSchema,
  deviceId: z.string().optional(),
});
export type CreateEnvironmentInput = z.infer<typeof CreateEnvironmentInputSchema>;

export const UpdateEnvironmentInputSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  status: EnvironmentStatusSchema.optional(),
  instanceId: z.string().optional(),
  ipAddress: z.string().optional(),
});
export type UpdateEnvironmentInput = z.infer<typeof UpdateEnvironmentInputSchema>;

export const EnvironmentFilterSchema = z.object({
  status: EnvironmentStatusSchema.optional(),
  deviceId: z.string().optional(),
  resourceProfile: ResourceProfileSchema.optional(),
  agentRole: z.string().optional(),
});
export type EnvironmentFilter = z.infer<typeof EnvironmentFilterSchema>;

// ---------------------------------------------------------------------------
// Protocol Interface (7 methods)
// ---------------------------------------------------------------------------

export interface EnvironmentProtocol {
  createEnvironment(input: CreateEnvironmentInput): Promise<Environment>;
  getEnvironment(id: string): Promise<Environment>;
  listEnvironments(filter?: EnvironmentFilter): Promise<Environment[]>;
  updateEnvironment(input: UpdateEnvironmentInput): Promise<Environment>;
  destroyEnvironment(id: string): Promise<void>;
  startEnvironment(id: string): Promise<Environment>;
  stopEnvironment(id: string): Promise<Environment>;
}

export type { EnvironmentStatus, ResourceProfile };

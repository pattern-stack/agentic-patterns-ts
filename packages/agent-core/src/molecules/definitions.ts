/**
 * Definition types for manual reference data.
 *
 * Frozen Zod schemas representing immutable reference data used in manuals.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Universal Definition Types
// ---------------------------------------------------------------------------

/** A step in a procedure or process. */
export const WorkflowStepDefinitionSchema = z.object({
  key: z.string(),
  name: z.string(),
  description: z.string(),
  nextSteps: z.array(z.string()).default([]),
  requires: z.array(z.string()).default([]),
});
export type WorkflowStepDefinition = Readonly<z.infer<typeof WorkflowStepDefinitionSchema>>;

/** A constraint or guardrail for tool usage. */
export const RuleDefinitionSchema = z.object({
  key: z.string(),
  name: z.string(),
  condition: z.string(),
  action: z.string(),
  severity: z.enum(["warning", "blocking"]),
});
export type RuleDefinition = Readonly<z.infer<typeof RuleDefinitionSchema>>;

/** A reusable pattern or template. */
export const TemplateDefinitionSchema = z.object({
  key: z.string(),
  name: z.string(),
  description: z.string(),
  template: z.string(),
  useWhen: z.string(),
});
export type TemplateDefinition = Readonly<z.infer<typeof TemplateDefinitionSchema>>;

/** When to escalate to human or another system. */
export const EscalationTriggerSchema = z.object({
  key: z.string(),
  name: z.string(),
  condition: z.string(),
  escalateTo: z.string(),
  urgency: z.enum(["immediate", "soon", "normal"]),
});
export type EscalationTrigger = Readonly<z.infer<typeof EscalationTriggerSchema>>;

// ---------------------------------------------------------------------------
// Domain-Specific Definition Types (task management examples)
// ---------------------------------------------------------------------------

/** Definition of a workflow state. */
export const StateDefinitionSchema = z.object({
  key: z.string(),
  name: z.string(),
  description: z.string(),
  isTerminal: z.boolean().default(false),
  transitionsTo: z.array(z.string()).default([]),
});
export type StateDefinition = Readonly<z.infer<typeof StateDefinitionSchema>>;

/** Definition of a priority level. */
export const PriorityDefinitionSchema = z.object({
  key: z.string(),
  name: z.string(),
  description: z.string(),
  urgency: z.number().int(),
});
export type PriorityDefinition = Readonly<z.infer<typeof PriorityDefinitionSchema>>;

/** Definition of an issue type. */
export const IssueTypeDefinitionSchema = z.object({
  key: z.string(),
  name: z.string(),
  description: z.string(),
  icon: z.string().optional(),
});
export type IssueTypeDefinition = Readonly<z.infer<typeof IssueTypeDefinitionSchema>>;

/** Definition of a health/quality signal. */
export const HealthSignalSchema = z.object({
  key: z.string(),
  name: z.string(),
  condition: z.string(),
  severity: z.enum(["warning", "critical"]),
});
export type HealthSignal = Readonly<z.infer<typeof HealthSignalSchema>>;

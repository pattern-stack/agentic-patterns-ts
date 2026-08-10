/**
 * TriggerSource datatype - what started this run.
 *
 * The framework-tier trigger contract's data half (M2 ignition, #437): a
 * frozen, prompt-safe record of why a run happened — a schedule occurrence, a
 * webhook delivery, an inbound message, a human, another agent, or the system
 * itself. Hosts construct one at the ignition point and thread it through
 * `RunOptions.trigger` (runtime); an ambient agent may legitimately *know*
 * what woke it, which is why this is an atom with `toPrompt()` rather than
 * opaque host metadata (same core-placement precedent as `SessionScope`:
 * only hosts parse it, but the concept belongs to the composition).
 *
 * Deliberately transport-shaped, not app-shaped: app-level notions (a
 * directive id, a cron slot, a channel) ride `sourceId`/`label`/`summary` —
 * the `kind` vocabulary stays small and stable.
 */

import { z } from "zod";

import { AgenticModel } from "./base.js";

export const TRIGGER_KINDS = [
  "schedule",
  "webhook",
  "message",
  "manual",
  "agent",
  "system",
] as const;

export const TriggerSourceSchema = z.object({
  /** What family of thing fired: a cadence, a delivery, a message, a human, an agent, the system. */
  kind: z.enum(TRIGGER_KINDS),
  /** Stable id of the triggering thing (schedule row id, webhook delivery id, message ts…). */
  sourceId: z.string().optional(),
  /** Human-facing name of the triggering thing ('morning-brief', '#eng-alerts') — prompt-safe. */
  label: z.string().optional(),
  /** When the trigger fired (ISO 8601). */
  firedAt: z.string().datetime({ offset: true }),
  /** Host join key back to the caller's own audit trail (job run id, delivery id…). */
  correlationId: z.string().optional(),
  /** Small prompt-safe excerpt of what fired — NEVER the full event body. */
  summary: z.string().optional(),
});

export type TriggerSourceData = z.infer<typeof TriggerSourceSchema>;

/** Per-kind phrasing for the prompt line ("started by …"). */
const KIND_PHRASES: Record<TriggerSourceData["kind"], string> = {
  schedule: "a schedule",
  webhook: "a webhook delivery",
  message: "an incoming message",
  manual: "a person, manually",
  agent: "another agent",
  system: "the system",
};

/**
 * Why this run is happening. Frozen and Zod-validated like every atom; the
 * render is a compact, prompt-safe line — hosts wanting richer context put it
 * in `summary` or compose their own Awareness text from `data`.
 */
export class TriggerSource extends AgenticModel<typeof TriggerSourceSchema.shape> {
  constructor(data: z.input<typeof TriggerSourceSchema>) {
    super(TriggerSourceSchema, data);
  }

  toPrompt(): string {
    const { kind, label, firedAt, summary } = this.data;
    const what = label !== undefined ? `${KIND_PHRASES[kind]} ('${label}')` : KIND_PHRASES[kind];
    const lines = [`This run was started by ${what} at ${firedAt}.`];
    if (summary !== undefined && summary !== "") {
      lines.push(summary);
    }
    return lines.join("\n");
  }
}

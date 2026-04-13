/**
 * Playbook — abstract class for defining named plays with Zod schemas.
 *
 * Plays are like tools but with error-envelope semantics:
 * PlayDefinition.execute throws on error, Playbook.execute catches
 * and returns { error: message }.
 *
 * Ported from Python: molecules/playbooks/base.py
 */

import type { ZodTypeAny } from "zod";
import { ToolSchema } from "./tool-schema.js";

// ---------------------------------------------------------------------------
// PlayDefinition
// ---------------------------------------------------------------------------

/**
 * A single play definition within a Playbook.
 *
 * Similar to ToolDefinition but errors are caught at the Playbook level.
 */
export interface PlayDefinition {
  description: string;
  parameters: ZodTypeAny;
  execute: (args: Record<string, unknown>) => Promise<unknown>;
}

// ---------------------------------------------------------------------------
// Playbook
// ---------------------------------------------------------------------------

/**
 * Abstract base class for playbooks.
 *
 * Subclasses must provide `name`, `description`, and a `plays` record
 * mapping play names to PlayDefinition objects.
 */
export abstract class Playbook {
  abstract readonly name: string;
  abstract readonly description: string;
  abstract readonly plays: Record<string, PlayDefinition>;

  /** Get play definitions as ToolSchema objects. */
  getPlaySchemas(): ToolSchema[] {
    return Object.entries(this.plays).map(([name, def]) =>
      ToolSchema.fromZod(name, def.description, def.parameters),
    );
  }

  /** Get names of all plays in this playbook. */
  getPlayNames(): string[] {
    return Object.keys(this.plays);
  }

  /**
   * Execute a play by name.
   *
   * Validates args via Zod. On success, returns JSON-safe result.
   * On error (unknown play, validation failure, execution error),
   * returns `{ error: message }` envelope instead of throwing.
   */
  async execute(name: string, args: unknown): Promise<unknown> {
    const play = this.plays[name];
    if (!play) {
      return { error: `Unknown play: ${name}` };
    }
    try {
      const parsed = play.parameters.parse(args) as Record<string, unknown>;
      const result = await play.execute(parsed);
      return JSON.parse(JSON.stringify(result ?? null));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { error: message };
    }
  }
}

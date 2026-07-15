/**
 * Capability class - Toolbox + Manual + optional Playbook composition.
 *
 * A Capability is a specific pairing of tools with guidance.
 * Same Toolbox + different Manual = different Capability.
 */

import type { Manual } from "./manual.js";
import type { Playbook } from "./playbook.js";
import type { ToolSchema } from "./tool-schema.js";
import type { Toolbox } from "./toolbox.js";

/**
 * A pairing of tools (Toolbox) with guidance (Manual) and optional plays (Playbook).
 *
 * Capabilities represent what an agent can do and how they should
 * approach it. The same toolbox with different manuals creates
 * different capabilities with different behaviors.
 */
export class Capability {
  readonly name: string;
  readonly description: string;
  readonly toolbox: Toolbox;
  readonly manual?: Manual;
  readonly playbook?: Playbook;

  constructor(
    name: string,
    description: string,
    toolbox: Toolbox,
    manual?: Manual,
    playbook?: Playbook,
  ) {
    this.name = name;
    this.description = description;
    this.toolbox = toolbox;
    this.manual = manual;
    this.playbook = playbook;
    Object.freeze(this);
  }

  /** Get tool schemas from the toolbox and playbook. */
  getTools(): ToolSchema[] {
    const tools = this.toolbox.getToolSchemas();
    if (this.playbook) {
      tools.push(...this.playbook.getPlaySchemas());
    }
    return tools;
  }

  /** Get guidance from the manual, or empty string if no manual. */
  getGuidance(): string {
    return this.manual?.toPrompt() ?? "";
  }

  /**
   * Render the full capability as a prompt fragment.
   *
   * Combines name, description, guidance, and tool list.
   */
  toPrompt(): string {
    const parts = [`### ${this.name}`, this.description];
    const guidance = this.getGuidance();
    if (guidance) {
      parts.push(guidance);
    }
    const tools = this.getTools();
    if (tools.length > 0) {
      parts.push("**Tools:**");
      parts.push(...tools.map((t) => `- **${t.name}**: ${t.description}`));
    }
    return parts.join("\n\n");
  }
}

/**
 * Create a Capability from a named object literal instead of the positional
 * constructor. A pure adapter: constructor freezing and all methods are
 * preserved, and the result satisfies `instanceof Capability`.
 */
export function capability(spec: {
  name: string;
  description: string;
  toolbox: Toolbox;
  manual?: Manual;
  playbook?: Playbook;
}): Capability {
  return new Capability(spec.name, spec.description, spec.toolbox, spec.manual, spec.playbook);
}

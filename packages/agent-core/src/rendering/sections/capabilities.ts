/**
 * Capabilities section: WHAT the agent can do.
 */

import type { Capability } from "../../molecules/capability.js";
import type { ToolSchema } from "../../molecules/tool-schema.js";
import type { PromptSection } from "./base.js";

/**
 * Renders agent capabilities and tools into Capabilities section.
 */
export class CapabilitiesSection implements PromptSection {
  readonly name = "Capabilities";

  constructor(readonly capabilities: Capability[] = []) {}

  render(): string {
    if (this.capabilities.length === 0) {
      return "";
    }

    const parts: string[] = ["## Capabilities"];

    // Guidance from capabilities
    parts.push("\n### Guidance");
    for (const cap of this.capabilities) {
      parts.push(`\n#### ${cap.name}`);
      parts.push(cap.getGuidance());
    }

    // Available tools
    const tools: ToolSchema[] = [];
    for (const cap of this.capabilities) {
      tools.push(...cap.getTools());
    }

    if (tools.length > 0) {
      parts.push("\n### Available Tools");
      for (const tool of tools) {
        parts.push(`- **${tool.name}**: ${tool.description}`);
      }
    }

    return parts.join("\n");
  }
}

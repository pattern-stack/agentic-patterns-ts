/**
 * Manual base classes.
 *
 * Manuals provide reference material that shapes how toolboxes are used.
 * Same toolbox + different manual = different Capability.
 */

import { z } from "zod";
import { type ToolDefinition, Toolbox } from "./toolbox.js";

// ---------------------------------------------------------------------------
// ManualSection<T>
// ---------------------------------------------------------------------------

/** Item type constraint: must have at least a `name` field, optionally `key` and `description`. */
export interface ManualItem {
  readonly name: string;
  readonly key?: string;
  readonly description?: string;
}

/**
 * A section of a manual containing related definitions.
 *
 * Generic over T — the item type stored in the section.
 */
export class ManualSection<T extends ManualItem> {
  readonly name: string;
  readonly description: string;
  readonly items: readonly T[];

  constructor(name: string, description: string, items: readonly T[]) {
    this.name = name;
    this.description = description;
    this.items = items;
    Object.freeze(this);
  }

  /** Get an item by its key. */
  get(key: string): T | undefined {
    return this.items.find((item) => item.key === key);
  }

  /** Get all keys in this section. */
  keys(): string[] {
    return this.items.filter((item) => item.key !== undefined).map((item) => item.key as string);
  }

  /**
   * Render this section as a prompt fragment.
   *
   * Matches Python's `to_prompt()` output exactly:
   * ```
   * ## Section Name
   *
   * Description text
   *
   * - **Item Name**: Item description
   * - **Item Name**
   * ```
   */
  toPrompt(headingLevel = 2): string {
    const prefix = "#".repeat(headingLevel);
    const lines = [`${prefix} ${this.name}`, "", this.description, ""];
    for (const item of this.items) {
      if (item.description !== undefined) {
        lines.push(`- **${item.name}**: ${item.description}`);
      } else {
        lines.push(`- **${item.name}**`);
      }
    }
    return lines.join("\n");
  }
}

// ---------------------------------------------------------------------------
// Manual (abstract base)
// ---------------------------------------------------------------------------

/**
 * Abstract base class for all manuals.
 *
 * Manuals provide reference material for agents - definitions, guidelines,
 * and domain knowledge that shape how tools are used.
 */
export abstract class Manual {
  abstract readonly name: string;
  abstract readonly description: string;

  abstract toPrompt(): string;

  // Common section accessors — override in subclasses
  get vocabulary(): ManualSection<ManualItem> | undefined {
    return undefined;
  }
  get workflows(): ManualSection<ManualItem> | undefined {
    return undefined;
  }
  get rules(): ManualSection<ManualItem> | undefined {
    return undefined;
  }
  get healthSignals(): ManualSection<ManualItem> | undefined {
    return undefined;
  }
  get templates(): ManualSection<ManualItem> | undefined {
    return undefined;
  }
  get escalation(): ManualSection<ManualItem> | undefined {
    return undefined;
  }
  get examples(): ManualSection<ManualItem> | undefined {
    return undefined;
  }

  /** Get all non-undefined sections in this manual. */
  getAllSections(): ManualSection<ManualItem>[] {
    const sections: (ManualSection<ManualItem> | undefined)[] = [
      this.vocabulary,
      this.workflows,
      this.rules,
      this.healthSignals,
      this.templates,
      this.escalation,
      this.examples,
    ];
    return sections.filter((s): s is ManualSection<ManualItem> => s !== undefined);
  }

  /** Get the names of all populated sections. */
  listSections(): string[] {
    return this.getAllSections().map((s) => s.name);
  }

  /** Create a filtered view rendering only the named sections. */
  scoped(include: string[]): ScopedManual {
    return new ScopedManual(this, include);
  }
}

// ---------------------------------------------------------------------------
// TextManual
// ---------------------------------------------------------------------------

/** Simple manual with plain text guidance. */
export class TextManual extends Manual {
  readonly name: string;
  readonly description: string;
  private readonly _content: string;

  constructor(name: string, content: string, description?: string) {
    super();
    this.name = name;
    this._content = content;
    this.description = description ?? content.slice(0, 100);
  }

  toPrompt(): string {
    return `# ${this.name}\n\n${this._content}`;
  }
}

// ---------------------------------------------------------------------------
// SimpleManual
// ---------------------------------------------------------------------------

/**
 * Concrete manual that takes sections in the constructor.
 * Renders all sections sequentially.
 */
export class SimpleManual extends Manual {
  readonly name: string;
  readonly description: string;
  private readonly _sections: ManualSection<ManualItem>[];

  constructor(name: string, description: string, sections: ManualSection<ManualItem>[]) {
    super();
    this.name = name;
    this.description = description;
    this._sections = sections;
  }

  getAllSections(): ManualSection<ManualItem>[] {
    return this._sections;
  }

  toPrompt(): string {
    return this._sections.map((s) => s.toPrompt()).join("\n\n");
  }
}

// ---------------------------------------------------------------------------
// ScopedManual
// ---------------------------------------------------------------------------

/**
 * A filtered view of an existing Manual that only renders specified sections.
 *
 * Included sections render fully; excluded sections appear as a one-line
 * TOC entry so the agent knows they exist without paying the token cost.
 */
export class ScopedManual extends Manual {
  private readonly _source: Manual;
  private readonly _include: ReadonlySet<string>;

  constructor(source: Manual, include: string[]) {
    super();
    this._source = source;
    this._include = new Set(include);
  }

  get name(): string {
    return this._source.name;
  }

  get description(): string {
    return this._source.description;
  }

  get vocabulary(): ManualSection<ManualItem> | undefined {
    return this._source.vocabulary;
  }

  get workflows(): ManualSection<ManualItem> | undefined {
    return this._source.workflows;
  }

  get rules(): ManualSection<ManualItem> | undefined {
    return this._source.rules;
  }

  get healthSignals(): ManualSection<ManualItem> | undefined {
    return this._source.healthSignals;
  }

  get templates(): ManualSection<ManualItem> | undefined {
    return this._source.templates;
  }

  get escalation(): ManualSection<ManualItem> | undefined {
    return this._source.escalation;
  }

  get examples(): ManualSection<ManualItem> | undefined {
    return this._source.examples;
  }

  toPrompt(): string {
    const allSections = this._source.getAllSections();
    const included = allSections.filter((s) => this._include.has(s.name));
    const excluded = allSections.filter((s) => !this._include.has(s.name));

    const parts = [`# ${this.name}`];

    for (const section of included) {
      parts.push("");
      parts.push(section.toPrompt());
    }

    if (excluded.length > 0) {
      parts.push("");
      parts.push("## Other Sections (available on request)");
      parts.push("");
      for (const section of excluded) {
        parts.push(`- ${section.name}`);
      }
    }

    return parts.join("\n");
  }
}

// ---------------------------------------------------------------------------
// ManualToolbox
// ---------------------------------------------------------------------------

const readManualSectionParams = z.object({
  sectionName: z.string().describe("Name of the section to read"),
});

const listManualSectionsParams = z.object({});

/**
 * Exposes manual sections as readable tools for progressive disclosure.
 *
 * Agents see a TOC in their prompt (via ScopedManual) and can fetch
 * full section content on demand using the readManualSection tool.
 */
export class ManualToolbox extends Toolbox {
  readonly name: string;
  readonly description: string;
  readonly tools: Record<string, ToolDefinition>;

  private readonly _sectionMap: Map<string, ManualSection<ManualItem>>;

  constructor(manual: Manual) {
    super();
    this.name = `${manual.name} Reference`;
    this.description = `Look up sections from the ${manual.name}`;
    this._sectionMap = new Map(manual.getAllSections().map((s) => [s.name, s]));

    // Capture `this` for tool closures
    const sectionMap = this._sectionMap;
    const manualName = manual.name;

    this.tools = {
      readManualSection: {
        description: "Read a specific section from the manual by name.",
        parameters: readManualSectionParams,
        execute: async (args) => {
          const { sectionName } = args as { sectionName: string };
          const section = sectionMap.get(sectionName);
          if (!section) {
            const available = [...sectionMap.keys()].sort().join(", ");
            return `Section '${sectionName}' not found. Available: ${available}`;
          }
          return section.toPrompt();
        },
      },
      listManualSections: {
        description: "List all available manual sections.",
        parameters: listManualSectionsParams,
        execute: async () => {
          if (sectionMap.size === 0) {
            return "No sections available.";
          }
          const lines = [`# ${manualName} — Sections`, ""];
          for (const [name, section] of sectionMap) {
            lines.push(`- **${name}**: ${section.description}`);
          }
          return lines.join("\n");
        },
      },
    };
  }
}

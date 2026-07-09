/**
 * Mission datatype - what the agent is DOING.
 */

import { type ZodTypeAny, z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

import { AgenticModel } from "./base.js";

/**
 * Generate an example JSON object from a JSON schema.
 */
function generateExampleFromSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
  if (!properties) {
    return {};
  }

  const example: Record<string, unknown> = {};

  for (const [propName, propSchema] of Object.entries(properties)) {
    const propType = (propSchema.type as string | undefined) ?? "string";

    if ("default" in propSchema) {
      example[propName] = propSchema.default;
    } else if (
      "examples" in propSchema &&
      Array.isArray(propSchema.examples) &&
      propSchema.examples.length > 0
    ) {
      example[propName] = propSchema.examples[0];
    } else if (propType === "string") {
      example[propName] = `<${propName}>`;
    } else if (propType === "integer") {
      example[propName] = 0;
    } else if (propType === "number") {
      example[propName] = 0.0;
    } else if (propType === "boolean") {
      example[propName] = false;
    } else if (propType === "array") {
      const itemsSchema = (propSchema.items as Record<string, unknown>) ?? {};
      const itemsType = itemsSchema.type as string | undefined;
      if (itemsType === "string") {
        example[propName] = [`<${propName}_item>`];
      } else if (itemsType === "object") {
        example[propName] = [generateExampleFromSchema(itemsSchema)];
      } else {
        example[propName] = [];
      }
    } else if (propType === "object") {
      example[propName] = generateExampleFromSchema(propSchema);
    } else {
      example[propName] = null;
    }
  }

  return example;
}

/**
 * Render a schema as a prompt fragment for guiding model output.
 *
 * Accepts either a Zod schema or a raw JSON schema dict.
 */
export function renderSchemaForPrompt(schema: ZodTypeAny | Record<string, unknown>): string {
  let jsonSchema: Record<string, unknown>;
  let schemaName: string;

  if ("_def" in schema && typeof (schema as ZodTypeAny).parse === "function") {
    // It's a Zod schema
    jsonSchema = zodToJsonSchema(schema as ZodTypeAny) as Record<string, unknown>;
    schemaName =
      (jsonSchema.title as string | undefined) ?? (schema as ZodTypeAny).description ?? "Output";
  } else {
    // It's a raw dict schema
    jsonSchema = schema as Record<string, unknown>;
    schemaName = (jsonSchema.title as string | undefined) ?? "Output";
  }

  const example = generateExampleFromSchema(jsonSchema);

  const lines: string[] = [
    "**Required Output Format:**",
    "",
    `Your response must be valid JSON matching the \`${schemaName}\` schema.`,
    "",
    "Schema:",
    "```json",
    JSON.stringify(jsonSchema, null, 2),
    "```",
    "",
    "Example:",
    "```json",
    JSON.stringify(example, null, 2),
    "```",
  ];

  return lines.join("\n");
}

export const MissionSchema = z.object({
  objective: z.string().min(1),
  successCriteria: z.array(z.string()).default([]),
  constraints: z.array(z.string()).default([]),
  rationale: z.string().default(""),
  outputSchema: z.unknown().optional(),
  strictOutput: z.boolean().default(false),
});

export type MissionData = z.infer<typeof MissionSchema>;

/**
 * Defines what the agent is DOING - current objective.
 */
export class Mission extends AgenticModel<typeof MissionSchema.shape> {
  constructor(data: z.input<typeof MissionSchema>) {
    super(MissionSchema, data);
  }

  toPrompt(): string {
    const lines: string[] = ["## Current Mission", "", this.data.objective];
    if (this.data.successCriteria.length > 0) {
      lines.push("\n**Success criteria:**");
      for (const c of this.data.successCriteria) {
        lines.push(`- ${c}`);
      }
    }
    if (this.data.constraints.length > 0) {
      lines.push("\n**Constraints:**");
      for (const c of this.data.constraints) {
        lines.push(`- ${c}`);
      }
    }
    if (this.data.rationale) {
      lines.push(`\n**Rationale:** ${this.data.rationale}`);
    }

    // Inject schema into prompt when strictOutput is false
    if (this.data.outputSchema != null && !this.data.strictOutput) {
      const schemaPrompt = renderSchemaForPrompt(
        this.data.outputSchema as ZodTypeAny | Record<string, unknown>,
      );
      if (schemaPrompt) {
        lines.push(`\n${schemaPrompt}`);
      }
    }

    return lines.join("\n");
  }

  /** Add success criteria to this mission. */
  withCriteria(criteria: string[]): Mission {
    return this.replace({
      successCriteria: [...this.data.successCriteria, ...criteria],
    });
  }

  /** Add constraints to this mission. */
  withConstraints(constraints: string[]): Mission {
    return this.replace({
      constraints: [...this.data.constraints, ...constraints],
    });
  }
}

/**
 * Client-side schema→form flattening for the Tool Workbench (port-map §2.3).
 *
 * swe-brain flattens a tool's params SERVER-side (`extractToolParams`); the
 * playground's `GET /capabilities/:id` already serves the tool's full
 * JSON-schema `parameters` (and optional `returns`), so no new server
 * endpoint is needed — this just folds that JSON schema into the flat param
 * list the Construction table and the `ToolRunner` form both consume.
 */

export interface ToolParam {
  name: string;
  /** JSON-schema `type` (`string`, `number`, `integer`, `boolean`, `object`,
   *  `array`, …), or `"unknown"` when the schema declares none. */
  type: string;
  required: boolean;
  description?: string;
  /** JSON-schema `enum` values, when the property declares a closed set (a
   *  `z.enum(...)` field) — additive (#308: the scope form's typed rows pick
   *  the picker widget off this, existing consumers ignore it). */
  enum?: string[];
  /** JSON-schema `default`, when the property declares one — additive (#308:
   *  seeds an untouched scope row alongside the scope's own top-level
   *  `instantiation.defaults`; existing consumers ignore it). */
  defaultValue?: unknown;
}

interface JsonSchemaProperty {
  type?: string;
  description?: string;
  enum?: unknown[];
  default?: unknown;
}

/**
 * Fold an object JSON schema (`{type:"object", properties, required?}`, the
 * shape `zodToJsonSchema` produces for a `z.object({...})` tool schema) into
 * a flat `ToolParam[]`. A non-object or empty schema degrades to `[]` rather
 * than throwing — callers render "No parameters." (or fall back to a raw
 * dump for a non-object `returns` schema), never crash on an odd shape.
 */
export function foldToolParams(schema: Record<string, unknown> | undefined): ToolParam[] {
  const properties = (schema?.properties ?? {}) as Record<string, JsonSchemaProperty>;
  const required = Array.isArray(schema?.required) ? (schema?.required as string[]) : [];
  return Object.entries(properties).map(([name, prop]) => ({
    name,
    type: prop?.type ?? "unknown",
    required: required.includes(name),
    description: prop?.description,
    enum: Array.isArray(prop?.enum) ? (prop.enum as string[]) : undefined,
    defaultValue: prop?.default,
  }));
}

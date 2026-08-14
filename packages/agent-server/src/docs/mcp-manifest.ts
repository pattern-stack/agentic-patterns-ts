/**
 * MCP-shaped tool manifest — the agent-world view of the same surface. Two
 * groups, both `{ name, description, inputSchema }` (MCP `tools/list` shape):
 *
 *  - `api.*`        — every REST operation as an agent-callable tool (from the
 *                     same catalog that feeds OpenAPI). Path+query params and the
 *                     request body become the tool's `inputSchema`.
 *  - `capability.*` — the agents' OWN toolbox tools, harvested duck-typed via
 *                     `toolbox.getToolSchemas()` (the JSON-schema'd surface the
 *                     composition routes already expose).
 *
 * Not a running MCP server — a static, introspectable manifest an agent (or an
 * MCP bridge) reads to know what this server can do.
 */

import { displayRoleOf } from "../routes/composition.js";
import { introspectRoutes, resolveRouteDoc, zodJsonSchema } from "./openapi.js";
import type { HonoLike } from "./openapi.js";

// --- Duck-typed capability harvest (never import core classes) --------------

interface ToolSchemaLike {
  name?: string;
  description?: string;
  parameters?: Record<string, unknown>;
}
interface ToolboxLike {
  getToolSchemas?: () => ToolSchemaLike[];
}
interface CapabilityLike {
  name?: string;
  toolbox?: ToolboxLike;
}
interface RoleLike {
  name?: string;
  capabilities?: ReadonlyArray<CapabilityLike>;
}
interface AgentLike {
  role?: RoleLike;
  /** A promoted pipeline's real Role — DISPLAY only (see `routes/composition.ts`
   *  `displayRoleOf`). This manifest is a static description, never an execution
   *  path, so it reads it like the other introspection surfaces. */
  displayRole?: RoleLike;
}
/** Minimal shape of a registration this manifest reads. */
export interface RegistrationLike {
  readonly id: string;
  readonly name?: string;
  readonly agent?: AgentLike;
}

export interface McpTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly annotations: Record<string, unknown>;
}

export interface McpManifest {
  readonly schemaVersion: "mcp-tools/1";
  readonly server: { readonly name: string; readonly version: string };
  readonly tools: McpTool[];
}

const EMPTY_OBJECT_SCHEMA = { type: "object", properties: {} } as const;

function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "unnamed"
  );
}

/** Flatten a route's path params + query + body into one object inputSchema. */
function apiInputSchema(doc: ReturnType<typeof resolveRouteDoc>): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  const spread = (schema: NonNullable<typeof doc.params>, allRequired: boolean): void => {
    const js = zodJsonSchema(schema) as {
      properties?: Record<string, unknown>;
      required?: string[];
    };
    const req = new Set(js.required ?? []);
    for (const [k, v] of Object.entries(js.properties ?? {})) {
      properties[k] = v;
      if (allRequired || req.has(k)) required.push(k);
    }
  };

  if (doc.params) spread(doc.params, true);
  if (doc.query) spread(doc.query, false);
  if (doc.request) {
    properties.body = zodJsonSchema(doc.request);
    required.push("body");
  }
  return { type: "object", properties, ...(required.length ? { required } : {}) };
}

/** Every REST operation as an MCP tool. */
function apiTools(app: HonoLike): McpTool[] {
  return introspectRoutes(app).map((route) => {
    const doc = resolveRouteDoc(route);
    return {
      name: `api.${doc.method.toLowerCase()}.${slug(route.path)}`,
      description: doc.description ? `${doc.summary} — ${doc.description}` : doc.summary,
      inputSchema: apiInputSchema(doc),
      annotations: { group: "api", method: doc.method, path: route.path, tag: doc.tag },
    };
  });
}

/** Every registered agent's toolbox tools as MCP tools. */
function capabilityTools(agents: ReadonlyArray<RegistrationLike>): McpTool[] {
  const out: McpTool[] = [];
  for (const reg of agents) {
    const caps = displayRoleOf(reg.agent)?.capabilities ?? [];
    for (const cap of caps) {
      const schemas =
        typeof cap.toolbox?.getToolSchemas === "function" ? cap.toolbox.getToolSchemas() : [];
      for (const t of schemas) {
        if (!t.name) continue;
        const params =
          t.parameters && Object.keys(t.parameters).length
            ? t.parameters
            : { ...EMPTY_OBJECT_SCHEMA };
        out.push({
          name: `capability.${slug(reg.id)}.${slug(cap.name ?? "capability")}.${t.name}`,
          description: t.description ?? "",
          inputSchema: params,
          annotations: { group: "capability", agent: reg.id, capability: cap.name ?? null },
        });
      }
    }
  }
  return out;
}

export function buildMcpManifest(
  app: HonoLike,
  agents: ReadonlyArray<RegistrationLike>,
  server: { name?: string; version?: string } = {},
): McpManifest {
  return {
    schemaVersion: "mcp-tools/1",
    server: {
      name: server.name ?? "@pattern-stack/agentic-server",
      version: server.version ?? "0",
    },
    tools: [...apiTools(app), ...capabilityTools(agents)],
  };
}

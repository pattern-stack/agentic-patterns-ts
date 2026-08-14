/**
 * OpenAPI 3.1.0 document builder. Introspects Hono's live `app.routes` for
 * COMPLETENESS (every mounted route is documented), overlays hand-authored
 * richness from the catalog, and converts Zod schemas via the server's existing
 * `zod-to-json-schema`. Overlay entries that match no live route are reported as
 * `drift` (and stamped as `x-drift` on the document) rather than silently lost.
 *
 * WHY 3.1 (not 3.0): OpenAPI 3.1 is fully aligned with JSON Schema 2020-12 — a
 * schema object here IS a JSON Schema document, so an agent / MCP bridge / codegen
 * / validator consumes it with zero dialect translation (the whole "already
 * Zod/JSON-Schema'd" thesis, made literal). That requires the converter to emit
 * the JSON-Schema dialect (`type: ["string","null"]`) rather than 3.0's fork
 * (`nullable: true`), so we target `jsonSchema2019-09` — the closest 2020-12
 * dialect this lib ships — and declare it via `jsonSchemaDialect`. 2019-09 vs
 * 2020-12 differ only in `$dynamicRef`/tuple-`prefixItems`, neither of which our
 * emitted shapes (objects/strings/enums/arrays/nullable) use.
 */

import type { ZodTypeAny } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import {
  type LiveRoute,
  OVERLAY,
  type RouteDoc,
  defaultSummary,
  paramsSchemaFor,
  tagOf,
} from "./catalog.js";

/** The one bit of Hono we read — kept structural so tests can pass a stub. */
export interface HonoLike {
  readonly routes: ReadonlyArray<{ readonly method: string; readonly path: string }>;
}

export interface OpenApiInfo {
  readonly title?: string;
  readonly version?: string;
  readonly description?: string;
}

export interface OpenApiResult {
  readonly document: Record<string, unknown>;
  /** Overlay keys (`"METHOD /path"`) that no live route matched. */
  readonly drift: string[];
}

const SKIP_METHODS = new Set(["ALL", "HEAD", "OPTIONS"]);

/** Dedupe `app.routes` to real, documentable operations. */
export function introspectRoutes(app: HonoLike): LiveRoute[] {
  const seen = new Set<string>();
  const out: LiveRoute[] = [];
  for (const r of app.routes) {
    if (SKIP_METHODS.has(r.method)) continue;
    if (r.path.includes("*")) continue; // middleware mounts, not endpoints
    const key = `${r.method} ${r.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ method: r.method, path: r.path });
  }
  return out;
}

/** Hono `/a/:id` → OpenAPI `/a/{id}`. */
function toOpenApiPath(path: string): string {
  return path.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
}

/** `GET /agents/:id/composition` → `get_agents_by_id_composition`. */
function operationId(method: string, path: string): string {
  const body = path
    .split("/")
    .filter(Boolean)
    .map((seg) => (seg.startsWith(":") ? `by_${seg.slice(1)}` : seg))
    .join("_")
    .replace(/[^A-Za-z0-9_]/g, "_");
  return `${method.toLowerCase()}_${body || "root"}`;
}

/** The JSON Schema dialect our converter emits — declared on the 3.1 document
 *  and the honest answer to "what dialect are these schema objects?". */
export const JSON_SCHEMA_DIALECT = "https://json-schema.org/draft/2019-09/schema";

/**
 * Zod → JSON Schema (2019-09 dialect, no `$ref`s) — directly embeddable in an
 * OpenAPI 3.1 document AND handed straight to an agent/validator. Nullable
 * renders as `type: [T, "null"]` (the JSON Schema form), not 3.0's `nullable`.
 * Shared with the MCP builder.
 */
export function zodJsonSchema(schema: ZodTypeAny): Record<string, unknown> {
  return zodToJsonSchema(schema, { target: "jsonSchema2019-09", $refStrategy: "none" }) as Record<
    string,
    unknown
  >;
}

/** An object Zod schema → OpenAPI parameter objects for `path`/`query`. */
function objectToParameters(schema: ZodTypeAny, location: "path" | "query"): unknown[] {
  const js = zodJsonSchema(schema) as {
    properties?: Record<string, { description?: string }>;
    required?: string[];
  };
  const required = new Set(js.required ?? []);
  return Object.entries(js.properties ?? {}).map(([name, s]) => ({
    name,
    in: location,
    required: location === "path" ? true : required.has(name),
    schema: s,
    ...(s.description ? { description: s.description } : {}),
  }));
}

/** Merge derivation + overlay into one fully-resolved RouteDoc. Shared with the MCP builder. */
export function resolveRouteDoc(route: LiveRoute): RouteDoc {
  const overlay = OVERLAY[`${route.method} ${route.path}`] ?? {};
  return {
    method: route.method,
    path: route.path,
    tag: overlay.tag ?? tagOf(route.path),
    summary: overlay.summary ?? defaultSummary(route.method, route.path),
    ...(overlay.description ? { description: overlay.description } : {}),
    params: overlay.params ?? paramsSchemaFor(route.path),
    ...(overlay.query ? { query: overlay.query } : {}),
    ...(overlay.request ? { request: overlay.request } : {}),
    ...(overlay.responses ? { responses: overlay.responses } : {}),
    ...(overlay.persistenceGated ? { persistenceGated: overlay.persistenceGated } : {}),
  };
}

function operationObject(doc: RouteDoc): Record<string, unknown> {
  const op: Record<string, unknown> = {
    tags: [doc.tag],
    summary: doc.summary,
    operationId: operationId(doc.method, doc.path),
  };
  if (doc.description) op.description = doc.description;

  const parameters: unknown[] = [];
  if (doc.params) parameters.push(...objectToParameters(doc.params, "path"));
  if (doc.query) parameters.push(...objectToParameters(doc.query, "query"));
  if (parameters.length) op.parameters = parameters;

  if (doc.request) {
    op.requestBody = {
      required: true,
      content: { "application/json": { schema: zodJsonSchema(doc.request) } },
    };
  }

  const responses: Record<string, unknown> = {};
  if (doc.responses) {
    for (const [status, r] of Object.entries(doc.responses)) {
      responses[status] = {
        description: r.description,
        ...(r.schema
          ? { content: { "application/json": { schema: zodJsonSchema(r.schema) } } }
          : {}),
      };
    }
  } else {
    responses["200"] = { description: "OK" };
  }
  if (doc.persistenceGated) {
    responses["503"] = {
      description: "The optional store/seam backing this route is not configured.",
    };
  }
  op.responses = responses;
  return op;
}

export function buildOpenApiDocument(app: HonoLike, info: OpenApiInfo = {}): OpenApiResult {
  const live = introspectRoutes(app);

  const paths: Record<string, Record<string, unknown>> = {};
  const tags = new Set<string>();
  for (const route of live) {
    const doc = resolveRouteDoc(route);
    tags.add(doc.tag);
    const oaPath = toOpenApiPath(route.path);
    paths[oaPath] ??= {};
    paths[oaPath][route.method.toLowerCase()] = operationObject(doc);
  }

  const liveKeys = new Set(live.map((r) => `${r.method} ${r.path}`));
  const drift = Object.keys(OVERLAY).filter((k) => !liveKeys.has(k));

  const document: Record<string, unknown> = {
    openapi: "3.1.0",
    jsonSchemaDialect: JSON_SCHEMA_DIALECT,
    info: {
      title: info.title ?? "@pattern-stack/agentic-server",
      version: info.version ?? "0",
      description:
        info.description ??
        "REST surface of the agentic-patterns playground server — auto-derived from live routes + the Zod schemas the routes already use.",
    },
    tags: [...tags].sort().map((name) => ({ name })),
    paths,
    ...(drift.length ? { "x-drift": drift } : {}),
  };
  return { document, drift };
}

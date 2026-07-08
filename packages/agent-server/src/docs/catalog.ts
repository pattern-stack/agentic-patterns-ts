/**
 * Route catalog — the single source that feeds every doc surface (OpenAPI,
 * llms.txt, MCP manifest). Two halves, by design:
 *
 *  1. INTROSPECTION (completeness) — `introspectRoutes()` reads Hono's live
 *     `app.routes`, so EVERY mounted endpoint appears in the docs even if
 *     nobody annotated it. Tag, path-params, and a default summary are derived
 *     from the path itself.
 *  2. OVERLAY (richness) — `OVERLAY` attaches human summaries + request/query/
 *     response Zod schemas to the routes worth describing well. Overlay keys
 *     that match no live route are surfaced as DRIFT (a described route that was
 *     renamed/removed), never silently dropped.
 *
 * Nothing here imports core classes; schemas are the ones the routes already
 * use (reused from runtime) or concise local mirrors — the doc layer is
 * read-only and additive.
 */

import { type ZodTypeAny, z } from "zod";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One documented operation. `method`+`path` are Hono-native (`:id` params). */
export interface RouteDoc {
  readonly method: string;
  readonly path: string;
  readonly tag: string;
  readonly summary: string;
  readonly description?: string;
  /** Path params (object schema). Auto-derived from `:x` segments if omitted. */
  readonly params?: ZodTypeAny;
  /** Query params (object schema). */
  readonly query?: ZodTypeAny;
  /** Request body (application/json). */
  readonly request?: ZodTypeAny;
  /** Response bodies by status. A bare string is the description. */
  readonly responses?: Readonly<Record<number, { description: string; schema?: ZodTypeAny }>>;
  /** True when the route 503s unless an optional store/seam is configured. */
  readonly persistenceGated?: boolean;
}

/** A live route as read from `app.routes`, deduped. */
export interface LiveRoute {
  readonly method: string;
  readonly path: string;
}

// ---------------------------------------------------------------------------
// Derivation (introspection half)
// ---------------------------------------------------------------------------

/** First path segment → a human tag. `/eval/runs` → "Eval"; `/openapi.json` → "Docs". */
export function tagOf(path: string): string {
  const seg = path.split("/").filter(Boolean)[0] ?? "root";
  const map: Record<string, string> = {
    health: "Health",
    agents: "Agents",
    roles: "Agents",
    capabilities: "Capabilities",
    conversations: "Conversations",
    messages: "Conversations",
    eval: "Eval",
    events: "Events",
    hooks: "Hooks",
    admin: "Admin",
    openapi: "Docs",
    docs: "Docs",
    mcp: "Docs",
    llms: "Docs",
  };
  // Try the full segment, then the pre-extension stem (`openapi.json` → `openapi`).
  return map[seg] ?? map[seg.split(".")[0] as string] ?? seg.charAt(0).toUpperCase() + seg.slice(1);
}

/** `:x` segments → an all-string object schema (OpenAPI requires each be required). */
export function paramsSchemaFor(path: string): ZodTypeAny | undefined {
  const names = [...path.matchAll(/:([A-Za-z0-9_]+)/g)].map((m) => m[1] as string);
  if (names.length === 0) return undefined;
  const shape: Record<string, ZodTypeAny> = {};
  for (const n of names) shape[n] = z.string().describe(`\`${n}\` path parameter`);
  return z.object(shape);
}

/** A readable default summary when the overlay doesn't provide one. */
export function defaultSummary(method: string, path: string): string {
  return `${method} ${path}`;
}

// ---------------------------------------------------------------------------
// Overlay (richness half) — keyed by "METHOD /hono/path"
// ---------------------------------------------------------------------------

const CreateSetBody = z
  .object({ id: z.string(), name: z.string().optional(), description: z.string().optional() })
  .describe("Eval set to create/upsert");

const CaseBody = z
  .object({
    caseId: z.string().optional(),
    input: z.unknown(),
    expected: z.unknown().optional(),
    tags: z.array(z.string()).optional(),
    split: z.enum(["train", "dev", "test"]).optional(),
  })
  .describe("An eval case");

const SendMessageBody = z
  .object({ message: z.string(), stream: z.boolean().optional() })
  .describe("A user turn for the conversation");

const InvokeToolBody = z
  .object({ arguments: z.record(z.unknown()) })
  .describe("Arguments for the tool, validated against its schema before execution");

const EventBody = z.object({ type: z.string() }).passthrough().describe("An AgentEvent envelope");
const PatchSetBody = z
  .object({ name: z.string().optional(), description: z.string().optional() })
  .describe("Eval set fields to update");

/** Rich descriptions for the routes worth it. Everything else rides derivation. */
export const OVERLAY: Readonly<Record<string, Partial<RouteDoc>>> = {
  // --- Health -------------------------------------------------------------
  "GET /health": {
    summary: "Liveness probe",
    description: 'Returns `{ status: "ok" }` when the server is up. Token-free.',
    responses: { 200: { description: "Healthy", schema: z.object({ status: z.literal("ok") }) } },
  },

  // --- Agents / roles -----------------------------------------------------
  "GET /agents": {
    summary: "List registered agents",
    description: "Every agent registration the server knows, with id/name/description.",
  },
  "GET /agents/:id/capabilities": { summary: "List an agent's capabilities" },
  "GET /agents/:id/composition": {
    summary: "Introspect one agent's full composition",
    description:
      "Two-tier introspection: role slots, instantiation delta, provenance, rendered prompt sections, and coherence checks. Read-only, token-free.",
  },
  "POST /agents/:id/composition/delivered": {
    summary: "Render the delivered (instantiated) composition",
    description:
      "Runs the registration's `instantiate` factory with a caller context and returns the actual delivered Background/prompt. Introspection-only; may hit live sources and can reject.",
  },
  "GET /roles": { summary: "List roles (identity catalog)" },
  "GET /roles/:id": { summary: "Get one role's identity + slot stack" },

  // --- Capabilities -------------------------------------------------------
  "GET /capabilities": {
    summary: "Capability substrate catalog",
    description:
      "Capability-keyed catalog with used-by edges and JSON-schema tool definitions — the agent-facing tool surface.",
  },
  "GET /capabilities/:id": { summary: "Get one capability + its tool schemas" },
  "POST /capabilities/:id/tools/:toolName/invoke": {
    summary: "Execute one capability tool directly",
    description:
      "Runs a single tool with no model in the loop — args are Zod-validated against the tool's schema, then executed. The direct-tool-exec seam.",
    request: InvokeToolBody,
  },

  // --- Conversations ------------------------------------------------------
  "POST /conversations": { summary: "Start a conversation", persistenceGated: true },
  "GET /conversations/:id": { summary: "Get a conversation", persistenceGated: true },
  "GET /conversations/:id/messages": {
    summary: "List a conversation's messages",
    persistenceGated: true,
  },
  "POST /conversations/:id/messages": {
    summary: "Send a message to a conversation",
    request: SendMessageBody,
    persistenceGated: true,
  },
  "GET /messages/:id/parts": { summary: "List a message's parts", persistenceGated: true },

  // --- Eval ---------------------------------------------------------------
  "GET /eval/sets": { summary: "List eval sets", persistenceGated: true },
  "POST /eval/sets": {
    summary: "Create an eval set",
    request: CreateSetBody,
    persistenceGated: true,
  },
  "PATCH /eval/sets/:id": {
    summary: "Update an eval set",
    request: PatchSetBody,
    persistenceGated: true,
  },
  "GET /eval/sets/:id/cases": { summary: "List an eval set's cases", persistenceGated: true },
  "GET /eval/sets/:id/cases/:caseId": { summary: "Get one eval case", persistenceGated: true },
  "PUT /eval/sets/:id/cases/:caseId": {
    summary: "Upsert an eval case",
    request: CaseBody,
    persistenceGated: true,
  },
  "DELETE /eval/sets/:id/cases/:caseId": { summary: "Delete an eval case", persistenceGated: true },
  "POST /eval/cases/from-session": {
    summary: "Capture a live conversation exchange as an eval case",
    persistenceGated: true,
  },
  "GET /eval/runs": { summary: "List eval runs", persistenceGated: true },
  "GET /eval/runs/:id": { summary: "Get one eval run + results", persistenceGated: true },
  "GET /eval/runs/:id/stream": {
    summary: "Stream a live eval run (SSE)",
    persistenceGated: true,
  },
  "POST /eval/runs": {
    summary: "Launch an eval run",
    description: "Runs a set against a target; stream progress via GET /eval/runs/:id/stream.",
    persistenceGated: true,
  },
  "GET /eval/scorers": { summary: "List available scorers" },
  "GET /eval/aggregates/splits": {
    summary: "Per-split pass-rate aggregates",
    persistenceGated: true,
  },

  // --- Events -------------------------------------------------------------
  "POST /events": { summary: "Ingest an agent event", request: EventBody },

  // --- Hooks --------------------------------------------------------------
  "POST /hooks/:eventType": {
    summary: "Deliver a Claude Code hook event",
    description: "Maps a Claude Code hook payload onto the agent event bus.",
  },

  // --- Admin --------------------------------------------------------------
  "GET /admin/dashboard": { summary: "Dashboard rollup stats" },
  "GET /admin/agents": { summary: "Admin agent stats" },
  "GET /admin/tools": { summary: "Tool-usage analytics" },
  "GET /admin/tokens": { summary: "Token-usage rollup" },
  "GET /admin/conversations": { summary: "List stored conversations", persistenceGated: true },
  "GET /admin/runs": { summary: "List run history", persistenceGated: true },
  "GET /admin/runs/:id": { summary: "Get one run", persistenceGated: true },
  "GET /admin/runs/:id/events": { summary: "Get a run's events", persistenceGated: true },
  "GET /admin/events/recent": { summary: "Recent events", persistenceGated: true },
  "GET /admin/events/stream": { summary: "Live event stream (SSE)" },
  "GET /admin/events/trace/:id": { summary: "Historical trace by id", persistenceGated: true },
  "GET /admin/claude-code/sessions": { summary: "List Claude Code sessions" },
  "GET /admin/claude-code/sessions/:sessionId": { summary: "Get one Claude Code session" },

  // --- Docs (self-documenting) -------------------------------------------
  "GET /openapi.json": { summary: "This OpenAPI document" },
  "GET /docs": { summary: "Scalar API reference (this UI)" },
  "GET /llms.txt": { summary: "Token-efficient agent map" },
  "GET /mcp/tools.json": { summary: "MCP-shaped tool manifest" },
};

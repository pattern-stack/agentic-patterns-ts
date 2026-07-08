/**
 * Docs routes — one Zod-fed source, four surfaces:
 *
 *   GET /openapi.json    OpenAPI 3.0.3 document (humans + tooling + codegen)
 *   GET /docs            Scalar API reference UI (self-contained page)
 *   GET /llms.txt        token-efficient markdown map for LLM agents
 *   GET /mcp/tools.json  MCP-shaped tool manifest (REST ops + capability tools)
 *
 * Mounted LAST in `app.ts` and given the parent `app` so it can introspect
 * `app.routes` at request time — every mounted endpoint (including these four)
 * is documented, un-annotated ones included. Read-only and token-free.
 */

import { Hono } from "hono";
import { buildLlmsTxt } from "./llms-txt.js";
import { type RegistrationLike, buildMcpManifest } from "./mcp-manifest.js";
import {
  type HonoLike,
  type OpenApiInfo,
  type OpenApiResult,
  buildOpenApiDocument,
} from "./openapi.js";

export interface DocsOptions {
  readonly info?: OpenApiInfo;
}

/** Self-contained Scalar reference page — points at `/openapi.json`. */
function scalarPage(title: string): string {
  const safe = title.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${safe} — API reference</title>
    <style>body { margin: 0 }</style>
  </head>
  <body>
    <script id="api-reference" data-url="/openapi.json"></script>
    <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
  </body>
</html>`;
}

/**
 * Build the docs sub-app. `app` is the PARENT (introspected at request time);
 * `agents` feed the MCP manifest's capability tools.
 */
export function docsRoutes(
  app: HonoLike,
  agents: ReadonlyArray<RegistrationLike>,
  options: DocsOptions = {},
): Hono {
  const sub = new Hono();
  const info = options.info ?? {};

  // Memoize: `app.routes` is stable once the server has finished mounting.
  let cached: OpenApiResult | undefined;
  const openapi = (): OpenApiResult => {
    if (!cached) {
      cached = buildOpenApiDocument(app, info);
      if (cached.drift.length) {
        console.warn(
          `[docs] catalog drift — described routes with no live match: ${cached.drift.join(", ")}`,
        );
      }
    }
    return cached;
  };

  sub.get("/openapi.json", (c) => c.json(openapi().document));

  sub.get("/docs", (c) => c.html(scalarPage(info.title ?? "@agentic-patterns/server")));

  sub.get("/llms.txt", (c) =>
    c.body(buildLlmsTxt(app, info), 200, { "content-type": "text/markdown; charset=utf-8" }),
  );

  sub.get("/mcp/tools.json", (c) =>
    c.json(buildMcpManifest(app, agents, { name: info.title, version: info.version })),
  );

  return sub;
}

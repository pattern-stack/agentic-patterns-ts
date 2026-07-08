import { describe, expect, it } from "vitest";
import { createServer } from "../app.js";
import type { ServerConfig } from "../config.js";
import { buildLlmsTxt } from "../docs/llms-txt.js";
import { buildMcpManifest } from "../docs/mcp-manifest.js";
import { type HonoLike, buildOpenApiDocument, introspectRoutes } from "../docs/openapi.js";

// A stub Hono whose `routes` we control — the builders only read that.
function stub(routes: Array<{ method: string; path: string }>): HonoLike {
  return { routes };
}

describe("introspectRoutes", () => {
  it("dedupes, and drops ALL / wildcard middleware mounts", () => {
    const live = introspectRoutes(
      stub([
        { method: "ALL", path: "*" },
        { method: "GET", path: "/health" },
        { method: "GET", path: "/health" }, // dup
        { method: "GET", path: "/x/*" }, // middleware
        { method: "POST", path: "/events" },
      ]),
    );
    expect(live).toEqual([
      { method: "GET", path: "/health" },
      { method: "POST", path: "/events" },
    ]);
  });
});

describe("buildOpenApiDocument", () => {
  const app = stub([
    { method: "GET", path: "/health" },
    { method: "GET", path: "/agents/:id/composition" },
    { method: "POST", path: "/eval/runs" },
    { method: "POST", path: "/capabilities/:id/tools/:toolName/invoke" },
  ]);

  it("emits a 3.0.3 doc with derived tags + operations", () => {
    const { document } = buildOpenApiDocument(app, { title: "T", version: "9" });
    expect(document.openapi).toBe("3.0.3");
    expect((document.info as { title: string; version: string }).title).toBe("T");
    const paths = document.paths as Record<string, Record<string, { tags: string[] }>>;
    expect(paths["/agents/{id}/composition"]?.get?.tags).toEqual(["Agents"]);
    expect(Object.keys(paths)).toContain("/capabilities/{id}/tools/{toolName}/invoke");
  });

  it("derives path params as required", () => {
    const { document } = buildOpenApiDocument(app);
    const op = (document.paths as Record<string, Record<string, { parameters?: unknown[] }>>)[
      "/agents/{id}/composition"
    ]?.get;
    expect(op?.parameters).toEqual([
      expect.objectContaining({ name: "id", in: "path", required: true }),
    ]);
  });

  it("adds a 503 to persistence-gated routes + a requestBody where the overlay has one", () => {
    const { document } = buildOpenApiDocument(app);
    const paths = document.paths as Record<
      string,
      Record<string, { responses: Record<string, unknown>; requestBody?: unknown }>
    >;
    expect(paths["/eval/runs"]?.post?.responses["503"]).toBeDefined();
    expect(paths["/capabilities/{id}/tools/{toolName}/invoke"]?.post?.requestBody).toBeDefined();
  });

  it("reports overlay keys with no live route as drift", () => {
    // Only /health is live; every other OVERLAY entry is drift.
    const { drift, document } = buildOpenApiDocument(stub([{ method: "GET", path: "/health" }]));
    expect(drift).toContain("POST /eval/runs");
    expect(drift).not.toContain("GET /health");
    expect(document["x-drift"]).toEqual(drift);
  });
});

describe("buildMcpManifest", () => {
  const app = stub([
    { method: "GET", path: "/agents" },
    { method: "POST", path: "/capabilities/:id/tools/:toolName/invoke" },
  ]);

  it("emits api tools for every route + capability tools harvested via getToolSchemas()", () => {
    const toolbox = {
      getToolSchemas: () => [
        {
          name: "search",
          description: "Search",
          parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
        },
      ],
    };
    const agents = [
      {
        id: "researcher",
        name: "R",
        agent: { role: { name: "R", capabilities: [{ name: "Research", toolbox }] } },
      },
    ];
    const manifest = buildMcpManifest(app, agents);
    const api = manifest.tools.filter((t) => t.annotations.group === "api");
    const caps = manifest.tools.filter((t) => t.annotations.group === "capability");
    expect(api.length).toBe(2);
    // path + query params + body fold into one inputSchema
    const invoke = api.find((t) => t.name.includes("invoke"));
    expect((invoke?.inputSchema.properties as Record<string, unknown>).id).toBeDefined();
    expect((invoke?.inputSchema.properties as Record<string, unknown>).body).toBeDefined();
    expect(caps).toEqual([
      expect.objectContaining({
        name: "capability.researcher.research.search",
        description: "Search",
        inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
      }),
    ]);
  });
});

describe("buildLlmsTxt", () => {
  it("groups by tag and omits the em-dash for un-annotated routes", () => {
    const txt = buildLlmsTxt(
      stub([
        { method: "GET", path: "/health" }, // annotated → "Liveness probe"
        { method: "GET", path: "/unknown/thing" }, // not annotated → bare
      ]),
    );
    expect(txt).toContain("# @agentic-patterns/server");
    expect(txt).toContain("- `GET /health` — Liveness probe");
    expect(txt).toContain("- `GET /unknown/thing`\n"); // no " — " suffix
  });
});

// --- Integration: the four surfaces served by a real server -----------------

const testConfig = {
  agents: [],
  cors: { origin: "*" },
  docs: { title: "@agentic-patterns/server", version: "0.16.0" },
} as unknown as ServerConfig;

describe("docs routes (served)", () => {
  it("GET /openapi.json returns the document", async () => {
    const app = createServer(testConfig);
    const res = await app.request("/openapi.json");
    expect(res.status).toBe(200);
    const doc = (await res.json()) as { openapi: string; paths: Record<string, unknown> };
    expect(doc.openapi).toBe("3.0.3");
    expect(Object.keys(doc.paths).length).toBeGreaterThan(20);
    // self-documenting: the docs routes appear too
    expect(doc.paths["/openapi.json"]).toBeDefined();
  });

  it("GET /docs serves the Scalar page pointing at /openapi.json", async () => {
    const app = createServer(testConfig);
    const res = await app.request("/docs");
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("@scalar/api-reference");
    expect(html).toContain('data-url="/openapi.json"');
  });

  it("GET /llms.txt serves markdown", async () => {
    const app = createServer(testConfig);
    const res = await app.request("/llms.txt");
    expect(res.headers.get("content-type")).toContain("text/markdown");
    expect(await res.text()).toContain("# @agentic-patterns/server");
  });

  it("GET /mcp/tools.json serves the manifest", async () => {
    const app = createServer(testConfig);
    const res = await app.request("/mcp/tools.json");
    const manifest = (await res.json()) as { schemaVersion: string; tools: unknown[] };
    expect(manifest.schemaVersion).toBe("mcp-tools/1");
    expect(manifest.tools.length).toBeGreaterThan(20);
  });
});

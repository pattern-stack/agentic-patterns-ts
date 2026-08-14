/**
 * `/llms.txt` — a token-efficient markdown map of the surface for LLM agents
 * (llmstxt.org convention: H1 title, a blockquote summary, then one bullet per
 * operation grouped by tag). What an agent reads to understand the API without
 * ingesting the full OpenAPI document.
 */

import { defaultSummary } from "./catalog.js";
import type { OpenApiInfo } from "./openapi.js";
import { type HonoLike, introspectRoutes, resolveRouteDoc } from "./openapi.js";

export function buildLlmsTxt(app: HonoLike, info: OpenApiInfo = {}): string {
  const title = info.title ?? "@pattern-stack/agentic-server";
  const summary =
    info.description ??
    "REST surface of the agentic-patterns playground server. Auto-derived from live routes + Zod schemas.";

  const byTag = new Map<string, string[]>();
  for (const route of introspectRoutes(app)) {
    const doc = resolveRouteDoc(route);
    // Drop the "— summary" when it's the bare `METHOD /path` default (no annotation).
    const annotated = doc.summary !== defaultSummary(doc.method, route.path);
    const line = `- \`${doc.method} ${route.path}\`${annotated ? ` — ${doc.summary}` : ""}${
      doc.persistenceGated ? " _(503 unless the backing store is configured)_" : ""
    }`;
    const bucket = byTag.get(doc.tag) ?? [];
    bucket.push(line);
    byTag.set(doc.tag, bucket);
  }

  const sections = [...byTag.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([tag, lines]) => `## ${tag}\n\n${lines.sort().join("\n")}`)
    .join("\n\n");

  return [
    `# ${title}`,
    "",
    `> ${summary}`,
    "",
    "Full machine spec: [/openapi.json](/openapi.json) · Human docs: [/docs](/docs) · Agent tools: [/mcp/tools.json](/mcp/tools.json)",
    "",
    sections,
    "",
  ].join("\n");
}

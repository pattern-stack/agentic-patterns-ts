/**
 * Docs link gate (#458): every INTERNAL href in the built site must resolve to
 * a file in dist/. Runs against the final HTML — so it covers sidebar, hero,
 * and generated links, not just markdown-authored ones — and replaces
 * starlight-links-validator, which cannot follow this project's out-of-tree
 * content collection (docs/ read in place via a glob loader).
 *
 *   bun run tools/check-docs-links.ts   # exit 1 on any broken internal link
 *
 * Scope: internal absolute hrefs (`/...`). External schemes, mailto, and
 * same-page `#` fragments pass through. Anchor *existence* on the target page
 * is not verified in v1 — the failure mode that bit this repo is missing
 * pages, not missing anchors.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dist = join(dirname(fileURLToPath(import.meta.url)), "..", "docs-site", "dist");

if (!existsSync(dist)) {
  console.error(`check-docs-links: ${dist} not found — build docs-site first`);
  process.exit(1);
}

function* htmlFiles(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* htmlFiles(p);
    else if (p.endsWith(".html")) yield p;
  }
}

const resolves = (href: string): boolean => {
  const path = decodeURIComponent(href.split("#")[0] ?? "").split("?")[0] ?? "";
  if (path === "" || path === "/") return existsSync(join(dist, "index.html"));
  const clean = path.replace(/^\//, "").replace(/\/$/, "");
  return (
    existsSync(join(dist, clean)) ||
    existsSync(join(dist, `${clean}.html`)) ||
    existsSync(join(dist, clean, "index.html"))
  );
};

let checked = 0;
const broken: Array<{ file: string; href: string }> = [];
for (const file of htmlFiles(dist)) {
  const html = readFileSync(file, "utf8");
  for (const match of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
    const href = match[1] ?? "";
    if (!href.startsWith("/") || href.startsWith("//")) continue; // internal absolute only
    checked++;
    if (!resolves(href)) {
      broken.push({ file: file.slice(dist.length + 1), href });
    }
  }
}

if (broken.length > 0) {
  console.error(`check-docs-links: ${broken.length} broken internal link(s):`);
  for (const b of broken) console.error(`  ${b.file} -> ${b.href}`);
  process.exit(1);
}
console.log(`check-docs-links: ${checked} internal refs OK across the built site`);

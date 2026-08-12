// Starlight site over the repo's docs/ tree (#457/#458).
//
// docs/ stays the single source of truth at its current paths — code comments
// and ADR cross-references point at docs/... — so the content collection reads
// it IN PLACE via a glob loader (see src/content.config.ts) instead of moving
// files under src/content/docs/.
//
// The build script chains tools/check-docs-links.ts after `astro build`, so a
// broken internal link in the FINAL html fails the workspace build — which is
// the CI `check` gate. That is the point: docs join the same required status
// as code (#457 truth pipeline).
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import starlight from "@astrojs/starlight";
import { defineConfig, passthroughImageService } from "astro/config";

const DOCS_ROOT = fileURLToPath(new URL("../docs", import.meta.url));

/**
 * Inter-doc links are authored as relative *.md paths so they keep working in
 * GitHub's file view (docs/ is read in both places). This rewrites them to
 * site routes at build time: resolve against the source file, re-root under
 * the docs/ collection base, drop the extension, lowercase (the glob loader's
 * slug rule for this tree — no spaces/unicode in these filenames). Links that
 * escape docs/ or aren't *.md pass through untouched and the validator flags
 * them — that's the desired failure mode.
 */
function remarkRelativeMdLinks() {
  return (tree, file) => {
    const walk = (node) => {
      if (node.type === "link" && typeof node.url === "string") {
        const m = /^([^#?]+\.mdx?)(#.*)?$/i.exec(node.url);
        if (m && !/^([a-z]+:|\/)/i.test(node.url)) {
          const target = resolve(dirname(file.path), m[1]);
          const rel = relative(DOCS_ROOT, target);
          if (!rel.startsWith("..")) {
            const slug = rel
              .replace(/\.mdx?$/i, "")
              .split(sep)
              .join("/")
              .toLowerCase();
            node.url = (slug === "index" ? "/" : `/${slug}/`) + (m[2] ?? "");
          }
        }
      }
      for (const child of node.children ?? []) walk(child);
    };
    walk(tree);
  };
}

export default defineConfig({
  site: "https://agentic-patterns.pattern-stack.com",
  markdown: {
    remarkPlugins: [remarkRelativeMdLinks],
  },
  // No sharp: the site is text-only today and the native dependency has bitten
  // this repo before (better-sqlite3 ABI). Passthrough keeps installs boring.
  image: { service: passthroughImageService() },
  integrations: [
    starlight({
      title: "Agentic Patterns",
      description:
        "Build ambient agents that run on their own — TypeScript. Composable primitives from atoms to organisms, executed by a runtime with triggers, typed events, gates, and cross-session memory.",
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/pattern-stack/agentic-patterns-ts",
        },
      ],
      // Grouping follows the cold-reader audit (#458): a short, honest Guides
      // path first; dated design/plan documents live under "Design notes" so a
      // visitor can tell shipped API from aspiration at a glance.
      sidebar: [
        {
          label: "Guides",
          items: ["getting-started", "authoring-a-toolbox", "runners"],
        },
        // Ambient sits directly under Guides: it is the program the framework is
        // being built toward (#414), and its ignition seam (#437) shipped in
        // core 0.18 / lockstep 0.39 with no page at all until this group existed.
        // Every page here states shipped-vs-roadmap explicitly — the trigger seam
        // is real, AgencyHost (M3) and channels (M4) are not.
        {
          label: "Ambient",
          items: ["ambient", "ambient/triggers", "ambient/conversations", "ambient/gateway"],
        },
        { label: "Memory", items: [{ autogenerate: { directory: "memory" } }] },
        {
          label: "Reference",
          items: ["reference/events", "event-persistence"],
        },
        { label: "Architecture Decisions", items: [{ autogenerate: { directory: "adr" } }] },
        {
          label: "Design notes",
          collapsed: true,
          items: [
            "agent-packages",
            "store-family",
            "node-context",
            "closed-composition",
            "eval-surface",
            "playground-redesign",
            "claude-code-plugin-activation",
            "migration/cockpit-port",
          ],
        },
      ],
    }),
  ],
});

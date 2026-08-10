import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineCollection } from "astro:content";
// Content collection over the REPO's docs/ tree, read in place (#458).
//
// Starlight's default docsLoader() reads src/content/docs/; this project's
// content lives at <repo>/docs and must stay there (single source of truth —
// code comments and ADR links reference docs/... paths). The generic glob
// loader with a ../docs base gives the same collection without moving files.
//
// Schema is Starlight's docsSchema, which requires `title`. Frontmatter is
// still the preferred way to set it — it also carries `description` and the
// short `sidebar.label`. But requiring it made every new doc merged to main a
// build break for anyone whose branch predated it (exactly what happened to
// this PR: ADRs 0009/0010 landed on main and reddened the required `check`).
// So a doc with no `title` falls back to its first H1 rather than failing the
// build. The gates that carry real signal — link validation and event-manifest
// drift — are unaffected; only the frontmatter tax is lifted.
import { docsSchema } from "@astrojs/starlight/schema";
import { glob } from "astro/loaders";

const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---\r?\n/;
const ATX_H1 = /^#\s+(.+?)\s*$/m;

/**
 * First ATX H1 in the body, used as `title` when frontmatter omits one.
 * Returns undefined on an unreadable path or a doc with no H1 — in which case
 * the original schema error surfaces unchanged, which is the right failure.
 */
function titleFromFirstHeading(filePath: string): string | undefined {
  try {
    const raw = readFileSync(resolve(filePath), "utf8");
    return ATX_H1.exec(raw.replace(FRONTMATTER, ""))?.[1];
  } catch {
    return undefined;
  }
}

const docsLoader = glob({ pattern: "**/*.{md,mdx}", base: "../docs" });

export const collections = {
  docs: defineCollection({
    loader: {
      ...docsLoader,
      load: (context) =>
        docsLoader.load({
          ...context,
          parseData: ({ id, data, filePath }) => {
            if (!data.title && filePath) {
              const fallback = titleFromFirstHeading(filePath);
              if (fallback)
                return context.parseData({ id, data: { ...data, title: fallback }, filePath });
            }
            return context.parseData({ id, data, filePath });
          },
        }),
    },
    schema: docsSchema(),
  }),
};

import { defineCollection } from "astro:content";
// Content collection over the REPO's docs/ tree, read in place (#458).
//
// Starlight's default docsLoader() reads src/content/docs/; this project's
// content lives at <repo>/docs and must stay there (single source of truth —
// code comments and ADR links reference docs/... paths). The generic glob
// loader with a ../docs base gives the same collection without moving files.
// Schema stays Starlight's docsSchema, so every page needs `title` frontmatter
// (added across docs/ in this slice's migration).
import { docsSchema } from "@astrojs/starlight/schema";
import { glob } from "astro/loaders";

export const collections = {
  docs: defineCollection({
    loader: glob({ pattern: "**/*.{md,mdx}", base: "../docs" }),
    schema: docsSchema(),
  }),
};

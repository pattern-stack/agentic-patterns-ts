/**
 * Markdown — the dashboard's one markdown-to-DOM renderer, sitting on the
 * dependency-free `md()` (lib/markdown.ts). Originated in chat/atoms.tsx for
 * the assistant chat bubble; promoted here so non-chat surfaces (Role/Agent
 * slot stacks, capability manuals, conversation history) can reuse it without
 * reaching into `chat/`. `chat/atoms.tsx` re-exports this for its existing
 * call sites — the `.answer .md` class hooks it renders are chat.css's, but
 * they degrade to plain semantic-tag styling wherever chat.css isn't loaded.
 */
import { looksMarkdown, md } from "../../lib/markdown";

export function Markdown({
  content,
  className,
  postprocess,
  gate,
}: {
  content: string;
  className?: string;
  /** Optional HTML rewrite applied AFTER md() (e.g. [#N] cite-chip linkification
   *  — chat/parts.tsx `linkifyCites`). Receives md()'s escaped, controlled-tag output. */
  postprocess?: (html: string) => string;
  /** Skip the renderer for content that doesn't `looksMarkdown()` — e.g. a
   *  one-line description field where markdown is possible but rare, and a
   *  plain string is the safer default. Omit for content that's markdown by
   *  construction (chat replies, manuals, slot text already gated by a caller). */
  gate?: boolean;
}) {
  if (gate && !looksMarkdown(content)) {
    return <>{content}</>;
  }
  const html = md(content);
  return (
    <div
      className={`answer md ${className ?? ""}`}
      // biome-ignore lint/security/noDangerouslySetInnerHtml: md() emits a controlled tag set on escaped input.
      dangerouslySetInnerHTML={{ __html: postprocess ? postprocess(html) : html }}
    />
  );
}

/**
 * JsonBlock — pretty-printed JSON `<pre>` (port-map §7.2), replacing the
 * `preStyle` const hand-copied across EvalComparePage, EvalCaseDetailPage,
 * ConversationDetailPage, and CaseDetail.tsx. Defaults to always
 * `JSON.stringify`-ing `value` (matching those four call sites' `pretty()`
 * helper exactly, quotes-and-all for a bare string) — pass `raw` for the one
 * call site (ConversationDetailPage's `tool_result` part) that shows an
 * already-string payload verbatim instead.
 */
import type { CSSProperties } from "react";
import { prettyJson } from "../../lib/format";
import { T } from "../../ui/tokens";

export function JsonBlock({
  value,
  maxHeight,
  errorTinted,
  raw = false,
  style,
}: {
  value: unknown;
  maxHeight?: number;
  /** Left-border + ink tint for a failed/errored result (the eval pages' fail marker). */
  errorTinted?: boolean;
  /** Render `value` (already a string) as-is instead of JSON-stringifying it. */
  raw?: boolean;
  style?: CSSProperties;
}) {
  const text = raw ? String(value) : prettyJson(value);
  return (
    <pre
      style={{
        margin: 0,
        padding: 10,
        background: "var(--background)",
        borderRadius: T.radius.sm,
        fontSize: T.fz.tiny,
        fontFamily: T.font.mono,
        overflowX: "auto",
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
        ...(maxHeight ? { maxHeight, overflow: "auto" } : {}),
        ...(errorTinted ? { borderLeft: "3px solid var(--err)" } : {}),
        ...style,
      }}
    >
      {text}
    </pre>
  );
}

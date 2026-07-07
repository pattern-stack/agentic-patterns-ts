/**
 * Shared client-side table-sort state (port-map §7.2 kit) — replaces the
 * sort-state triple (`sortKey`/`sortDir`/`handleSort`) hand-copied across
 * EvalRunsPage, TokensPage, ToolsPage, and ConversationsPage.
 *
 * Every one of those copies used the SAME "new column" convention: switching
 * to a not-yet-active column resets direction back to whatever the initial
 * direction was (asc for Tools/Tokens, desc for EvalRuns/Conversations) — so
 * one `initialDir` parameter covers every existing call site.
 */
import { useCallback, useMemo, useState } from "react";

export type SortDir = "asc" | "desc";

function getField<T>(row: T, key: string): string {
  return String((row as unknown as Record<string, unknown>)[key] ?? "");
}

export function useSortedRows<T>(
  rows: readonly T[],
  initialKey: string,
  initialDir: SortDir = "asc",
) {
  const [sortKey, setSortKey] = useState(initialKey);
  const [sortDir, setSortDir] = useState<SortDir>(initialDir);

  const handleSort = useCallback(
    (key: string) => {
      // Sibling set-calls, never a set inside another updater: StrictMode
      // double-invokes updaters, so a nested toggle enqueues twice and
      // cancels itself (same-column clicks stop flipping direction in dev).
      if (key === sortKey) {
        setSortDir((d) => (d === "asc" ? "desc" : "asc"));
      } else {
        setSortKey(key);
        setSortDir(initialDir);
      }
    },
    [sortKey, initialDir],
  );

  const sorted = useMemo(() => {
    return [...rows].sort((a, b) => {
      const cmp = getField(a, sortKey).localeCompare(getField(b, sortKey), undefined, {
        numeric: true,
      });
      return sortDir === "asc" ? cmp : -cmp;
    });
  }, [rows, sortKey, sortDir]);

  return { sorted, sortKey, sortDir, handleSort };
}

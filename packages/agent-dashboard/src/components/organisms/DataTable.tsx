/**
 * DataTable organism — sortable + optionally expandable rows.
 *
 * Hover/cursor affordances only apply when a row-level interaction is
 * configured (`onRowClick` or `renderExpanded`); otherwise rows render
 * as static cells so the UI doesn't imply an interaction that isn't
 * wired up. Interactive rows carry `tabIndex={0}` — the hover/focus-visible
 * tint comes from the global `tr[tabindex]` CSS rule (styles/globals.css,
 * port-map §7.1), not a JS `onMouseEnter`/`onMouseLeave` mutation.
 */

import { Fragment, type ReactNode, useMemo } from "react";
import { useBreakpoint } from "../../hooks/useMediaQuery";

export interface Column<T> {
  key: string;
  header: string;
  render?: (row: T) => ReactNode;
  align?: "left" | "right" | "center";
  /** Drop this column below the breakpoint: "sm" = <640px, "md" = <900px. */
  hideBelow?: "sm" | "md";
}

interface DataTableProps<T> {
  columns: Column<T>[];
  data: T[];
  sortKey?: string;
  sortDir?: "asc" | "desc";
  onSort?: (key: string) => void;
  onRowClick?: (row: T) => void;
  /** Returns a stable key for this row — required for expansion tracking. */
  rowKey?: (row: T) => string;
  /** The currently-expanded rowKey, or undefined. */
  expandedKey?: string;
  /** Called when a row is clicked to toggle expansion. */
  onToggleExpand?: (key: string) => void;
  /** Renders the expanded detail block for a row. */
  renderExpanded?: (row: T) => ReactNode;
}

const cellStyle = (align = "left", isPhone = false) =>
  ({
    padding: isPhone ? "8px 10px" : "10px 14px",
    textAlign: align as "left" | "right" | "center",
    borderBottom: "1px solid var(--line)",
    fontSize: 14,
  }) as const;

const headerStyle = (align = "left", isPhone = false) =>
  ({
    ...cellStyle(align, isPhone),
    color: "var(--ink-2)",
    fontWeight: 500,
    fontSize: 12,
    textTransform: "uppercase" as const,
    letterSpacing: "0.05em",
    cursor: "pointer",
    userSelect: "none" as const,
  }) as const;

function defaultRowKey<T>(row: T, i: number): string {
  const r = row as Record<string, unknown>;
  return String(r.id ?? r.name ?? i);
}

export function DataTable<T>({
  columns,
  data,
  sortKey,
  sortDir,
  onSort,
  onRowClick,
  rowKey,
  expandedKey,
  onToggleExpand,
  renderExpanded,
}: DataTableProps<T>) {
  const { isPhone, isNarrow } = useBreakpoint();
  const visibleColumns = useMemo(
    () =>
      columns.filter((col) => {
        if (col.hideBelow === "sm") return !isPhone;
        if (col.hideBelow === "md") return !isNarrow;
        return true;
      }),
    [columns, isPhone, isNarrow],
  );
  const expandable = Boolean(onToggleExpand && renderExpanded);
  const interactive = expandable || Boolean(onRowClick);
  const totalColSpan = visibleColumns.length + (expandable ? 1 : 0);

  return (
    <div
      style={{
        background: "var(--paper)",
        border: "1px solid var(--line)",
        borderRadius: "var(--radius-lg)",
        overflow: "hidden",
        overflowX: "auto",
        WebkitOverflowScrolling: "touch",
      }}
    >
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr>
            {expandable && <th style={headerStyle(undefined, isPhone)} aria-label="expand" />}
            {visibleColumns.map((col) => (
              <th
                key={col.key}
                style={headerStyle(col.align, isPhone)}
                onClick={() => onSort?.(col.key)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") onSort?.(col.key);
                }}
              >
                {col.header}
                {sortKey === col.key ? (sortDir === "asc" ? " ▲" : " ▼") : ""}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.map((row, i) => {
            const key = (rowKey ?? ((r: T) => defaultRowKey(r, i)))(row);
            const isExpanded = expandable && expandedKey === key;
            const handleActivate = () => {
              if (expandable) onToggleExpand?.(key);
              else onRowClick?.(row);
            };
            return (
              <Fragment key={key}>
                <tr
                  onClick={interactive ? handleActivate : undefined}
                  onKeyDown={
                    interactive
                      ? (e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            handleActivate();
                          }
                        }
                      : undefined
                  }
                  tabIndex={interactive ? 0 : undefined}
                  role={interactive ? "button" : undefined}
                  aria-expanded={expandable ? isExpanded : undefined}
                  style={{
                    cursor: interactive ? "pointer" : "default",
                    // Only set an inline background for the expanded row (a
                    // permanent, data-driven tint) — leaving it unset otherwise
                    // lets the global `tr[tabindex]:hover` rule apply; an inline
                    // "transparent" would out-specificity that CSS hover.
                    ...(isExpanded ? { background: "var(--fill-2)" } : {}),
                  }}
                >
                  {expandable && (
                    <td
                      style={{
                        ...cellStyle(undefined, isPhone),
                        width: 28,
                        color: "var(--ink-2)",
                        fontFamily: "var(--font-mono)",
                      }}
                    >
                      {isExpanded ? "▾" : "▸"}
                    </td>
                  )}
                  {visibleColumns.map((col) => (
                    <td key={col.key} style={cellStyle(col.align, isPhone)}>
                      {col.render
                        ? col.render(row)
                        : String((row as Record<string, unknown>)[col.key] ?? "")}
                    </td>
                  ))}
                </tr>
                {isExpanded && renderExpanded && (
                  <tr>
                    <td
                      colSpan={totalColSpan}
                      style={{
                        padding: "12px 14px 16px 42px",
                        background: "var(--background)",
                        borderBottom: "1px solid var(--line)",
                      }}
                    >
                      {renderExpanded(row)}
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
          {data.length === 0 && (
            <tr>
              <td
                colSpan={totalColSpan}
                style={{
                  ...cellStyle("center", isPhone),
                  color: "var(--ink-2)",
                  padding: 32,
                }}
              >
                No data
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

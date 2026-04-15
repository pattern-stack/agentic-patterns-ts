/**
 * DataTable organism — sortable + optionally expandable rows.
 *
 * Hover/cursor affordances only apply when a row-level interaction is
 * configured (`onRowClick` or `renderExpanded`); otherwise rows render
 * as static cells so the UI doesn't imply an interaction that isn't
 * wired up.
 */

import { Fragment, type ReactNode } from "react";

interface Column<T> {
  key: string;
  header: string;
  render?: (row: T) => ReactNode;
  align?: "left" | "right" | "center";
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

const cellStyle = (align = "left") =>
  ({
    padding: "10px 14px",
    textAlign: align as "left" | "right" | "center",
    borderBottom: "1px solid var(--border)",
    fontSize: 14,
  }) as const;

const headerStyle = (align = "left") =>
  ({
    ...cellStyle(align),
    color: "var(--fg-muted)",
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
  const expandable = Boolean(onToggleExpand && renderExpanded);
  const interactive = expandable || Boolean(onRowClick);
  const totalColSpan = columns.length + (expandable ? 1 : 0);

  return (
    <div
      style={{
        background: "var(--bg-surface)",
        border: "1px solid var(--border)",
        borderRadius: 8,
        overflow: "hidden",
      }}
    >
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr>
            {expandable && <th style={headerStyle()} aria-label="expand" />}
            {columns.map((col) => (
              <th
                key={col.key}
                style={headerStyle(col.align)}
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
                    background: isExpanded ? "var(--bg-surface-hover)" : "transparent",
                  }}
                  onMouseEnter={
                    interactive
                      ? (e) => {
                          e.currentTarget.style.background = "var(--bg-surface-hover)";
                        }
                      : undefined
                  }
                  onMouseLeave={
                    interactive
                      ? (e) => {
                          e.currentTarget.style.background = isExpanded
                            ? "var(--bg-surface-hover)"
                            : "transparent";
                        }
                      : undefined
                  }
                >
                  {expandable && (
                    <td
                      style={{
                        ...cellStyle(),
                        width: 28,
                        color: "var(--fg-muted)",
                        fontFamily: "var(--font-mono)",
                      }}
                    >
                      {isExpanded ? "▾" : "▸"}
                    </td>
                  )}
                  {columns.map((col) => (
                    <td key={col.key} style={cellStyle(col.align)}>
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
                        background: "var(--bg-inset)",
                        borderBottom: "1px solid var(--border)",
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
                  ...cellStyle("center"),
                  color: "var(--fg-muted)",
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

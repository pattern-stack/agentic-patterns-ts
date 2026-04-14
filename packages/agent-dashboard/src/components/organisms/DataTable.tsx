interface Column<T> {
  key: string;
  header: string;
  render?: (row: T) => React.ReactNode;
  align?: "left" | "right" | "center";
}

interface DataTableProps<T> {
  columns: Column<T>[];
  data: T[];
  sortKey?: string;
  sortDir?: "asc" | "desc";
  onSort?: (key: string) => void;
  onRowClick?: (row: T) => void;
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

export function DataTable<T>({
  columns,
  data,
  sortKey,
  sortDir,
  onSort,
  onRowClick,
}: DataTableProps<T>) {
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
          {data.map((row, i) => (
            <tr
              key={`row-${String((row as Record<string, unknown>).id ?? (row as Record<string, unknown>).name ?? i)}`}
              onClick={() => onRowClick?.(row)}
              onKeyDown={(e) => {
                if (e.key === "Enter") onRowClick?.(row);
              }}
              style={{
                cursor: onRowClick ? "pointer" : "default",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = "var(--bg-surface-hover)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = "transparent";
              }}
            >
              {columns.map((col) => (
                <td key={col.key} style={cellStyle(col.align)}>
                  {col.render
                    ? col.render(row)
                    : String((row as Record<string, unknown>)[col.key] ?? "")}
                </td>
              ))}
            </tr>
          ))}
          {data.length === 0 && (
            <tr>
              <td
                colSpan={columns.length}
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

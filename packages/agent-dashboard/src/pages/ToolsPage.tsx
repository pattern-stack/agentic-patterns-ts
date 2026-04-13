import { useState } from "react";
import type { ToolAnalytics } from "../api/types";
import { DataTable } from "../components/DataTable";
import { useAdminData } from "../hooks/useAdminData";

function errorRateColor(totalCalls: number, totalErrors: number): string {
  if (totalCalls === 0) return "var(--text-secondary)";
  const rate = 1 - totalErrors / totalCalls;
  if (rate >= 0.95) return "var(--accent-green)";
  if (rate >= 0.8) return "var(--accent-yellow)";
  return "var(--accent-red)";
}

function getField(row: ToolAnalytics, key: string): string {
  return String((row as unknown as Record<string, unknown>)[key] ?? "");
}

export function ToolsPage() {
  const { data, loading, error } = useAdminData<ToolAnalytics[]>("/admin/tools");
  const [sortKey, setSortKey] = useState("toolName");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");

  const handleSort = (key: string) => {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  };

  const sorted = [...(data ?? [])].sort((a, b) => {
    const cmp = getField(a, sortKey).localeCompare(getField(b, sortKey), undefined, {
      numeric: true,
    });
    return sortDir === "asc" ? cmp : -cmp;
  });

  if (loading) return <div style={{ color: "var(--text-secondary)" }}>Loading...</div>;
  if (error) return <div style={{ color: "var(--accent-red)" }}>Error: {error}</div>;

  return (
    <div>
      <h1 style={{ fontSize: 20, fontWeight: 600, marginBottom: 20 }}>Tools</h1>
      <DataTable<ToolAnalytics>
        columns={[
          { key: "toolName", header: "Name" },
          { key: "totalCalls", header: "Calls", align: "right" },
          {
            key: "totalErrors",
            header: "Errors",
            align: "right",
            render: (row) => (
              <span style={{ color: errorRateColor(row.totalCalls, row.totalErrors) }}>
                {row.totalErrors}
              </span>
            ),
          },
          {
            key: "avgDurationMs",
            header: "Avg Duration",
            align: "right",
            render: (row) => `${row.avgDurationMs.toFixed(0)}ms`,
          },
        ]}
        data={sorted}
        sortKey={sortKey}
        sortDir={sortDir}
        onSort={handleSort}
      />
    </div>
  );
}

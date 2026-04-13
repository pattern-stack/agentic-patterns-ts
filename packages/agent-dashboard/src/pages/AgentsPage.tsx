import { useState } from "react";
import type { AgentStats } from "../api/types";
import { DataTable } from "../components/DataTable";
import { useAdminData } from "../hooks/useAdminData";

function formatDate(dateStr: string | null): string {
  if (!dateStr) return "—";
  try {
    return new Date(dateStr).toLocaleString();
  } catch {
    return dateStr;
  }
}

function getField(row: AgentStats, key: string): string {
  return String((row as unknown as Record<string, unknown>)[key] ?? "");
}

export function AgentsPage() {
  const { data, loading, error } = useAdminData<AgentStats[]>("/admin/agents");
  const [sortKey, setSortKey] = useState("name");
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
      <h1 style={{ fontSize: 20, fontWeight: 600, marginBottom: 20 }}>Agents</h1>
      <DataTable<AgentStats>
        columns={[
          { key: "name", header: "Name" },
          { key: "model", header: "Model" },
          { key: "conversations", header: "Conversations", align: "right" },
          {
            key: "totalTokens",
            header: "Tokens",
            align: "right",
            render: (row) => row.totalTokens.toLocaleString(),
          },
          {
            key: "errors",
            header: "Errors",
            align: "right",
            render: (row) => (
              <span
                style={{
                  color: row.errors > 0 ? "var(--accent-red)" : "var(--text-secondary)",
                }}
              >
                {row.errors}
              </span>
            ),
          },
          {
            key: "lastActive",
            header: "Last Active",
            render: (row) => formatDate(row.lastActive),
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

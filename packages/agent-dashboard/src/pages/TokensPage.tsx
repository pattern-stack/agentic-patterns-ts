import { useState } from "react";
import type { TokenUsageRow } from "../api/types";
import { DataTable } from "../components/DataTable";
import { useAdminData } from "../hooks/useAdminData";

function getField(row: TokenUsageRow, key: string): string {
  return String((row as unknown as Record<string, unknown>)[key] ?? "");
}

export function TokensPage() {
  const [groupBy, setGroupBy] = useState<"agent" | "model">("agent");
  const { data, loading, error } = useAdminData<TokenUsageRow[]>(
    `/admin/tokens?group_by=${groupBy}`,
  );
  const [sortKey, setSortKey] = useState("agentName");
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
      <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 20 }}>
        <h1 style={{ fontSize: 20, fontWeight: 600, margin: 0 }}>Tokens</h1>
        <div style={{ display: "flex", gap: 4 }}>
          <button
            type="button"
            onClick={() => setGroupBy("agent")}
            style={{
              padding: "4px 12px",
              fontSize: 13,
              border: "1px solid var(--border)",
              borderRadius: 4,
              background: groupBy === "agent" ? "var(--accent-blue)" : "var(--bg-secondary)",
              color: groupBy === "agent" ? "#fff" : "var(--text-secondary)",
              cursor: "pointer",
            }}
          >
            By Agent
          </button>
          <button
            type="button"
            onClick={() => setGroupBy("model")}
            style={{
              padding: "4px 12px",
              fontSize: 13,
              border: "1px solid var(--border)",
              borderRadius: 4,
              background: groupBy === "model" ? "var(--accent-blue)" : "var(--bg-secondary)",
              color: groupBy === "model" ? "#fff" : "var(--text-secondary)",
              cursor: "pointer",
            }}
          >
            By Model
          </button>
        </div>
      </div>
      <DataTable<TokenUsageRow>
        columns={[
          { key: "agentName", header: groupBy === "agent" ? "Agent" : "Model" },
          {
            key: "promptTokens",
            header: "Prompt Tokens",
            align: "right",
            render: (row) => row.promptTokens.toLocaleString(),
          },
          {
            key: "completionTokens",
            header: "Completion Tokens",
            align: "right",
            render: (row) => row.completionTokens.toLocaleString(),
          },
          {
            key: "totalTokens",
            header: "Total",
            align: "right",
            render: (row) => row.totalTokens.toLocaleString(),
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

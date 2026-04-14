import { useState } from "react";
import type { ToolAnalytics } from "../api/types";
import { Badge, type BadgeTone } from "../components/atoms/Badge";
import { Card } from "../components/atoms/Card";
import { Spinner } from "../components/atoms/Spinner";
import { AlertIcon, WrenchIcon } from "../components/atoms/icons";
import { DataTable } from "../components/organisms/DataTable";
import { useAdminData } from "../hooks/useAdminData";

interface ToolRow extends ToolAnalytics {
  successRate: number;
}

function healthTone(successRate: number): BadgeTone {
  if (successRate >= 0.95) return "green";
  if (successRate >= 0.8) return "yellow";
  return "red";
}

function getField(row: ToolRow, key: string): string {
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

  const rows: ToolRow[] = (data ?? []).map((row) => ({
    ...row,
    successRate: row.totalCalls === 0 ? 1 : 1 - row.totalErrors / row.totalCalls,
  }));

  const sorted = [...rows].sort((a, b) => {
    const cmp = getField(a, sortKey).localeCompare(getField(b, sortKey), undefined, {
      numeric: true,
    });
    return sortDir === "asc" ? cmp : -cmp;
  });

  const title = <h1 style={{ fontSize: 20, fontWeight: 600, marginBottom: 20 }}>Tools</h1>;

  if (loading) {
    return (
      <div>
        {title}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 10,
            padding: 48,
            color: "var(--fg-muted)",
          }}
        >
          <Spinner />
          <span>Loading tools…</span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div>
        {title}
        <Card style={{ borderColor: "var(--red)" }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              color: "var(--red)",
            }}
          >
            <AlertIcon size={18} />
            <span>Error: {error}</span>
          </div>
        </Card>
      </div>
    );
  }

  if (sorted.length === 0) {
    return (
      <div>
        {title}
        <Card>
          <div
            style={{
              textAlign: "center",
              color: "var(--fg-muted)",
              padding: 12,
            }}
          >
            No tool calls recorded yet
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div>
      {title}
      <Card padded={false}>
        <DataTable<ToolRow>
          columns={[
            {
              key: "toolName",
              header: "Name",
              render: (row) => (
                <span
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 8,
                    color: "var(--fg-default)",
                  }}
                >
                  <span style={{ color: "var(--fg-subtle)" }}>
                    <WrenchIcon size={14} />
                  </span>
                  <span style={{ fontFamily: "var(--font-mono)" }}>{row.toolName}</span>
                </span>
              ),
            },
            { key: "totalCalls", header: "Calls", align: "right" },
            {
              key: "totalErrors",
              header: "Errors",
              align: "right",
              render: (row) => (
                <Badge tone={row.totalErrors > 0 ? "red" : "muted"}>{row.totalErrors}</Badge>
              ),
            },
            {
              key: "successRate",
              header: "Health",
              align: "right",
              render: (row) => (
                <Badge tone={healthTone(row.successRate)}>
                  {(row.successRate * 100).toFixed(1)}%
                </Badge>
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
      </Card>
    </div>
  );
}

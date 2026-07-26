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
  if (successRate >= 0.95) return "ok";
  if (successRate >= 0.8) return "warn";
  return "err";
}

function getField(row: ToolRow, key: string): string {
  return String((row as unknown as Record<string, unknown>)[key] ?? "");
}

export function ToolsPage() {
  const { data, loading, error } = useAdminData<ToolAnalytics[]>("/admin/tools");
  const [sortKey, setSortKey] = useState("toolName");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [expandedKey, setExpandedKey] = useState<string | undefined>();

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
            color: "var(--ink-2)",
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
        <Card style={{ borderColor: "var(--err)" }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              color: "var(--err)",
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
              color: "var(--ink-2)",
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
                    color: "var(--ink)",
                  }}
                >
                  <span style={{ color: "var(--ink-3)" }}>
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
              hideBelow: "sm",
              render: (row) => (
                <Badge tone={row.totalErrors > 0 ? "err" : "mute"}>{row.totalErrors}</Badge>
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
              hideBelow: "md",
              render: (row) => `${row.avgDurationMs.toFixed(0)}ms`,
            },
          ]}
          data={sorted}
          sortKey={sortKey}
          sortDir={sortDir}
          onSort={handleSort}
          rowKey={(row) => row.toolName}
          expandedKey={expandedKey}
          onToggleExpand={(k) => setExpandedKey((cur) => (cur === k ? undefined : k))}
          renderExpanded={(row) => <ToolAgentBreakdown tool={row} />}
        />
      </Card>
    </div>
  );
}

function ToolAgentBreakdown({ tool }: { tool: ToolRow }) {
  if (!tool.agentBreakdown.length) {
    return (
      <div style={{ color: "var(--ink-2)", fontSize: 13 }}>No per-agent breakdown available.</div>
    );
  }
  const total = tool.agentBreakdown.reduce((n, a) => n + a.callCount, 0) || 1;
  const sorted = [...tool.agentBreakdown].sort((a, b) => b.callCount - a.callCount);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div
        style={{
          fontSize: 11,
          textTransform: "uppercase",
          letterSpacing: 0.5,
          color: "var(--ink-3)",
        }}
      >
        {tool.toolName} usage by agent
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {sorted.map((a) => {
          const pct = Math.round((a.callCount / total) * 100);
          return (
            <div
              key={a.agentName}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                fontFamily: "var(--font-mono)",
                fontSize: 12,
                color: "var(--ink-2)",
              }}
            >
              <Badge tone="ok">{a.agentName}</Badge>
              <span style={{ color: "var(--ink)" }}>{a.callCount} calls</span>
              <span style={{ color: "var(--ink-3)" }}>{pct}%</span>
              <div
                style={{
                  flex: 1,
                  height: 4,
                  background: "var(--fill-2)",
                  borderRadius: 2,
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    width: `${pct}%`,
                    height: "100%",
                    background: "var(--accent)",
                  }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

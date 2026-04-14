import { useState } from "react";
import type { AgentStats } from "../api/types";
import { Badge, type BadgeTone } from "../components/atoms/Badge";
import { Card } from "../components/atoms/Card";
import { Spinner } from "../components/atoms/Spinner";
import { AlertIcon } from "../components/atoms/icons";
import { DataTable } from "../components/organisms/DataTable";
import { useAdminData } from "../hooks/useAdminData";

function formatDate(dateStr: string | undefined): string {
  if (!dateStr) return "\u2014";
  try {
    return new Date(dateStr).toLocaleString();
  } catch {
    return dateStr;
  }
}

function getField(row: AgentStats, key: string): string {
  return String((row as unknown as Record<string, unknown>)[key] ?? "");
}

function statusTone(status: AgentStats["status"]): BadgeTone {
  switch (status) {
    case "running":
      return "emerald";
    case "error":
      return "red";
    case "idle":
    case "completed":
      return "green";
    default:
      return "neutral";
  }
}

export function AgentsPage() {
  const { data, loading, error } = useAdminData<AgentStats[]>("/admin/agents");
  const [sortKey, setSortKey] = useState("agentName");
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

  const sorted = [...(data ?? [])].sort((a, b) => {
    const cmp = getField(a, sortKey).localeCompare(getField(b, sortKey), undefined, {
      numeric: true,
    });
    return sortDir === "asc" ? cmp : -cmp;
  });

  if (loading) {
    return (
      <div>
        <h1 style={{ fontSize: 20, fontWeight: 600, marginBottom: 20 }}>Agents</h1>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 10,
            padding: "48px 0",
            color: "var(--fg-muted)",
          }}
        >
          <Spinner />
          <span>Loading agents...</span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div>
        <h1 style={{ fontSize: 20, fontWeight: 600, marginBottom: 20 }}>Agents</h1>
        <Card
          style={{
            borderColor: "var(--red)",
            display: "flex",
            alignItems: "flex-start",
            gap: 12,
          }}
        >
          <span style={{ color: "var(--red)", display: "inline-flex", flexShrink: 0 }}>
            <AlertIcon size={18} />
          </span>
          <div>
            <div style={{ fontWeight: 600, color: "var(--red)", marginBottom: 4 }}>
              Failed to load agents
            </div>
            <div style={{ color: "var(--fg-muted)", fontSize: 14 }}>{error}</div>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div>
      <h1 style={{ fontSize: 20, fontWeight: 600, marginBottom: 20 }}>Agents</h1>
      {sorted.length === 0 ? (
        <Card
          style={{
            textAlign: "center",
            padding: 40,
            color: "var(--fg-muted)",
          }}
        >
          <div style={{ fontWeight: 600, color: "var(--fg-default)", marginBottom: 6 }}>
            No agents registered
          </div>
          <div style={{ fontSize: 14 }}>
            Agents will appear here once the runtime starts emitting events.
          </div>
        </Card>
      ) : (
        <Card padded={false}>
          <DataTable<AgentStats>
            columns={[
              { key: "agentName", header: "Name" },
              {
                key: "status",
                header: "Status",
                render: (row) => <Badge tone={statusTone(row.status)}>{row.status}</Badge>,
              },
              { key: "totalIterations", header: "Iterations", align: "right" },
              { key: "totalToolCalls", header: "Tool Calls", align: "right" },
              {
                key: "totalInputTokens",
                header: "Tokens In",
                align: "right",
                render: (row) => row.totalInputTokens.toLocaleString(),
              },
              {
                key: "totalOutputTokens",
                header: "Tokens Out",
                align: "right",
                render: (row) => row.totalOutputTokens.toLocaleString(),
              },
              {
                key: "totalErrors",
                header: "Errors",
                align: "right",
                render: (row) =>
                  row.totalErrors > 0 ? (
                    <Badge tone="red" variant="filled">
                      {row.totalErrors}
                    </Badge>
                  ) : (
                    <span style={{ color: "var(--fg-muted)" }}>{row.totalErrors}</span>
                  ),
              },
              {
                key: "lastEventAt",
                header: "Last Active",
                render: (row) => formatDate(row.lastEventAt),
              },
            ]}
            data={sorted}
            sortKey={sortKey}
            sortDir={sortDir}
            onSort={handleSort}
            rowKey={(row) => row.agentName}
            expandedKey={expandedKey}
            onToggleExpand={(k) => setExpandedKey((cur) => (cur === k ? undefined : k))}
            renderExpanded={(row) => <AgentToolBreakdown agent={row} />}
          />
        </Card>
      )}
    </div>
  );
}

function AgentToolBreakdown({ agent }: { agent: AgentStats }) {
  if (!agent.toolStats.length) {
    return (
      <div style={{ color: "var(--fg-muted)", fontSize: 13 }}>
        No tool usage recorded for this agent.
      </div>
    );
  }
  const sorted = [...agent.toolStats].sort((a, b) => b.callCount - a.callCount);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div
        style={{
          fontSize: 11,
          textTransform: "uppercase",
          letterSpacing: 0.5,
          color: "var(--fg-subtle)",
        }}
      >
        Tools used by {agent.agentName}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {sorted.map((t) => {
          const avg = t.avgDurationMs ? `${Math.round(t.avgDurationMs)}ms avg` : null;
          return (
            <div
              key={t.toolName}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                fontFamily: "var(--font-mono)",
                fontSize: 12,
                color: "var(--fg-muted)",
              }}
            >
              <span style={{ color: "var(--fg-default)", minWidth: 160 }}>{t.toolName}</span>
              <Badge tone="muted">{t.callCount} calls</Badge>
              {t.errorCount > 0 && <Badge tone="red">{t.errorCount} err</Badge>}
              {avg && <span style={{ color: "var(--fg-subtle)" }}>{avg}</span>}
              {t.lastUsed && (
                <span style={{ color: "var(--fg-subtle)", marginLeft: "auto" }}>
                  last {formatDate(t.lastUsed)}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

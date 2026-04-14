import { useState } from "react";
import type { TokenUsageGroup } from "../api/types";
import { Badge } from "../components/atoms/Badge";
import { Button } from "../components/atoms/Button";
import { Card } from "../components/atoms/Card";
import { Spinner } from "../components/atoms/Spinner";
import { AlertIcon } from "../components/atoms/icons";
import { DataTable } from "../components/organisms/DataTable";
import { useAdminData } from "../hooks/useAdminData";

function getField(row: TokenUsageGroup, key: string): string {
  return String((row as unknown as Record<string, unknown>)[key] ?? "");
}

export function TokensPage() {
  const [groupBy, setGroupBy] = useState<"agent" | "model">("agent");
  const { data, loading, error } = useAdminData<TokenUsageGroup[]>(
    `/admin/tokens?group_by=${groupBy}`,
  );
  const [sortKey, setSortKey] = useState("key");
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

  const header = (
    <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 20 }}>
      <h1 style={{ fontSize: 20, fontWeight: 600, margin: 0 }}>Tokens</h1>
      <div style={{ display: "flex", gap: 4 }}>
        <Button
          size="sm"
          variant={groupBy === "agent" ? "primary" : "ghost"}
          onClick={() => setGroupBy("agent")}
        >
          By Agent
        </Button>
        <Button
          size="sm"
          variant={groupBy === "model" ? "primary" : "ghost"}
          onClick={() => setGroupBy("model")}
        >
          By Model
        </Button>
      </div>
    </div>
  );

  if (loading) {
    return (
      <div>
        {header}
        <Card>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 10,
              color: "var(--fg-muted)",
              padding: "24px 0",
            }}
          >
            <Spinner />
            <span>Loading token usage...</span>
          </div>
        </Card>
      </div>
    );
  }

  if (error) {
    return (
      <div>
        {header}
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
        {header}
        <Card>
          <div
            style={{
              textAlign: "center",
              color: "var(--fg-muted)",
              padding: "24px 0",
            }}
          >
            No token usage recorded yet
          </div>
        </Card>
      </div>
    );
  }

  const keyTone = groupBy === "agent" ? "emerald" : "accent";
  const keyLabel = groupBy === "agent" ? "agent" : "model";

  return (
    <div>
      {header}
      <Card padded={false}>
        <DataTable<TokenUsageGroup>
          columns={[
            {
              key: "key",
              header: groupBy === "agent" ? "Agent" : "Model",
              render: (row) => (
                <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                  <Badge tone={keyTone}>{keyLabel}</Badge>
                  <span>{row.key}</span>
                </span>
              ),
            },
            {
              key: "inputTokens",
              header: "Input Tokens",
              align: "right",
              render: (row) => row.inputTokens.toLocaleString(),
            },
            {
              key: "outputTokens",
              header: "Output Tokens",
              align: "right",
              render: (row) => row.outputTokens.toLocaleString(),
            },
            {
              key: "totalTokens",
              header: "Total",
              align: "right",
              render: (row) => (
                <Badge tone="emerald" variant="filled">
                  {row.totalTokens.toLocaleString()}
                </Badge>
              ),
            },
            {
              key: "conversationCount",
              header: "Conversations",
              align: "right",
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

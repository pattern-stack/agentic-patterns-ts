import { useState } from "react";
import type { TokenUsageGroup } from "../api/types";
import { Badge } from "../components/atoms/Badge";
import { Card } from "../components/atoms/Card";
import { AsyncState } from "../components/kit/AsyncState";
import { PageHeader } from "../components/kit/PageHeader";
import { Segmented } from "../components/kit/Segmented";
import { DataTable } from "../components/organisms/DataTable";
import { useAdminData } from "../hooks/useAdminData";
import { useSortedRows } from "../hooks/useSortedRows";

const GROUP_BY_OPTIONS: { value: "agent" | "model"; label: string }[] = [
  { value: "agent", label: "By Agent" },
  { value: "model", label: "By Model" },
];

export function TokensPage() {
  const [groupBy, setGroupBy] = useState<"agent" | "model">("agent");
  const { data, loading, error } = useAdminData<TokenUsageGroup[]>(
    `/admin/tokens?group_by=${groupBy}`,
  );
  const { sorted, sortKey, sortDir, handleSort } = useSortedRows(data ?? [], "key");

  const header = (
    <PageHeader
      title="Tokens"
      actions={
        <Segmented
          options={GROUP_BY_OPTIONS}
          value={groupBy}
          onChange={setGroupBy}
          size="sm"
          aria-label="Group by"
        />
      }
    />
  );

  if (loading || error) {
    return (
      <div>
        {header}
        <Card>
          <AsyncState
            kind={loading ? "loading" : "error"}
            loading="Loading token usage..."
            error={error ? { title: "Error", message: error } : undefined}
          />
        </Card>
      </div>
    );
  }

  if (sorted.length === 0) {
    return (
      <div>
        {header}
        <AsyncState kind="empty" empty={{ title: "No token usage recorded yet" }} />
      </div>
    );
  }

  const keyTone = groupBy === "agent" ? "ok" : "accent";
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
                <Badge tone="ok" variant="filled">
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

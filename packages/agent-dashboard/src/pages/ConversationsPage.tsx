import { useNavigate } from "react-router-dom";
import type { ConversationSummary } from "../api/types";
import { Badge } from "../components/atoms/Badge";
import { Card } from "../components/atoms/Card";
import { AsyncState } from "../components/kit/AsyncState";
import { PageHeader } from "../components/kit/PageHeader";
import { DataTable } from "../components/organisms/DataTable";
import { useAdminData } from "../hooks/useAdminData";
import { useSortedRows } from "../hooks/useSortedRows";
import { relTime, shortId, statusTone } from "../lib/format";

export function ConversationsPage() {
  const { data, loading, error } = useAdminData<ConversationSummary[]>("/admin/conversations");
  const navigate = useNavigate();
  const { sorted, sortKey, sortDir, handleSort } = useSortedRows(data ?? [], "startedAt", "desc");

  if (loading || error) {
    return (
      <div>
        <PageHeader title="Conversations" />
        <AsyncState
          kind={loading ? "loading" : "error"}
          loading="Loading conversations..."
          error={error ? { title: "Failed to load conversations", message: error } : undefined}
        />
      </div>
    );
  }

  return (
    <div>
      <PageHeader title="Conversations" />
      {sorted.length === 0 ? (
        <AsyncState
          kind="empty"
          empty={{
            title: "No conversations yet",
            body: "Conversations will appear here once the runtime stores a message.",
          }}
        />
      ) : (
        <Card padded={false}>
          <DataTable<ConversationSummary>
            columns={[
              {
                key: "conversationId",
                header: "Conversation",
                render: (row) => (
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>
                    {shortId(row.conversationId)}
                  </span>
                ),
              },
              { key: "agentName", header: "Agent" },
              { key: "messageCount", header: "Messages", align: "right" },
              {
                key: "tokenCount",
                header: "Tokens",
                align: "right",
                render: (row) => row.tokenCount.toLocaleString(),
              },
              {
                key: "status",
                header: "Status",
                render: (row) => <Badge tone={statusTone(row.status)}>{row.status}</Badge>,
              },
              {
                key: "startedAt",
                header: "Started",
                render: (row) => relTime(row.startedAt),
              },
              {
                key: "lastMessageAt",
                header: "Last Message",
                render: (row) => relTime(row.lastMessageAt),
              },
            ]}
            data={sorted}
            sortKey={sortKey}
            sortDir={sortDir}
            onSort={handleSort}
            rowKey={(row) => row.conversationId}
            onRowClick={(row) => navigate(`/conversations/${row.conversationId}`)}
          />
        </Card>
      )}
    </div>
  );
}

import { useNavigate } from "react-router-dom";
import type { ConversationSummary } from "../api/types";
import { Badge } from "../components/atoms/Badge";
import { Card } from "../components/atoms/Card";
import { AsyncState } from "../components/kit/AsyncState";
import { PageHeader } from "../components/kit/PageHeader";
import { DataTable } from "../components/organisms/DataTable";
import { useAdminData } from "../hooks/useAdminData";
import { useBreakpoint } from "../hooks/useMediaQuery";
import { useSortedRows } from "../hooks/useSortedRows";
import { relTime, shortId, statusTone } from "../lib/format";

export function ConversationsPage() {
  const { data, loading, error } = useAdminData<ConversationSummary[]>("/admin/conversations");
  const navigate = useNavigate();
  const { isPhone } = useBreakpoint();
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
              {
                key: "messageCount",
                header: "Messages",
                align: "right",
                hideBelow: "sm",
              },
              {
                key: "tokenCount",
                header: "Tokens",
                align: "right",
                hideBelow: "md",
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
                hideBelow: "md",
                render: (row) => relTime(row.startedAt),
              },
              {
                key: "lastMessageAt",
                // "Last Message" is the widest header left after phone pruning
                // and pushed the table past a 390px viewport (the header, not
                // the "8m ago" cell, is what overflowed). Shorten it instead of
                // hiding the column — recency is the most useful phone signal.
                header: isPhone ? "Last" : "Last Message",
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

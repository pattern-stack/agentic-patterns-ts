import { useState } from "react";
import { useNavigate } from "react-router-dom";
import type { ConversationSummary } from "../api/types";
import { Badge, type BadgeTone } from "../components/atoms/Badge";
import { Card } from "../components/atoms/Card";
import { Spinner } from "../components/atoms/Spinner";
import { AlertIcon } from "../components/atoms/icons";
import { DataTable } from "../components/organisms/DataTable";
import { useAdminData } from "../hooks/useAdminData";

function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

function relative(dateStr: string | undefined | null): string {
  if (!dateStr) return "\u2014";
  const then = new Date(dateStr).getTime();
  if (Number.isNaN(then)) return String(dateStr);
  const diffSec = Math.round((Date.now() - then) / 1000);
  const abs = Math.abs(diffSec);
  if (abs < 60) return `${diffSec}s ago`;
  if (abs < 3600) return `${Math.round(diffSec / 60)}m ago`;
  if (abs < 86400) return `${Math.round(diffSec / 3600)}h ago`;
  return `${Math.round(diffSec / 86400)}d ago`;
}

function statusTone(status: ConversationSummary["status"]): BadgeTone {
  switch (status) {
    case "active":
      return "emerald";
    case "error":
      return "red";
    case "completed":
      return "green";
    default:
      return "neutral";
  }
}

function getField(row: ConversationSummary, key: string): string {
  return String((row as unknown as Record<string, unknown>)[key] ?? "");
}

export function ConversationsPage() {
  const { data, loading, error } = useAdminData<ConversationSummary[]>("/admin/conversations");
  const navigate = useNavigate();
  const [sortKey, setSortKey] = useState("startedAt");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const handleSort = (key: string) => {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("desc");
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
        <h1 style={{ fontSize: 20, fontWeight: 600, marginBottom: 20 }}>Conversations</h1>
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
          <span>Loading conversations...</span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div>
        <h1 style={{ fontSize: 20, fontWeight: 600, marginBottom: 20 }}>Conversations</h1>
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
              Failed to load conversations
            </div>
            <div style={{ color: "var(--fg-muted)", fontSize: 14 }}>{error}</div>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div>
      <h1 style={{ fontSize: 20, fontWeight: 600, marginBottom: 20 }}>Conversations</h1>
      {sorted.length === 0 ? (
        <Card
          style={{
            textAlign: "center",
            padding: 40,
            color: "var(--fg-muted)",
          }}
        >
          <div style={{ fontWeight: 600, color: "var(--fg-default)", marginBottom: 6 }}>
            No conversations yet
          </div>
          <div style={{ fontSize: 14 }}>
            Conversations will appear here once the runtime stores a message.
          </div>
        </Card>
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
                render: (row) => relative(row.startedAt),
              },
              {
                key: "lastMessageAt",
                header: "Last Message",
                render: (row) => relative(row.lastMessageAt),
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

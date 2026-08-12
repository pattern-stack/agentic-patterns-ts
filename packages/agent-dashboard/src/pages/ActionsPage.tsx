/**
 * /actions — Quick Actions: the canned prompt templates registrations ship
 * (`quickActions` on the registration, `quick_actions` on `GET /agents`),
 * rendered one card per action with its template VISIBLE and a one-click Run.
 *
 * Run hands the prompt to the chat surface through router navigation state
 * (`{ autoSend }`, consumed by `App.tsx`'s ChatRoute) rather than a query
 * param: the run must fire exactly once, and a link that re-fires a real agent
 * run on refresh or Back is the wrong primitive for a button that spends
 * tokens. The prompt is sent as the first message of a NEW conversation via
 * the ordinary create-on-first-send path, so the registration's own default
 * scope binds exactly as it would for a hand-typed message.
 *
 * Read-only page — it never pre-creates a conversation.
 */
import { useNavigate } from "react-router-dom";
import { type AgentSummary, type QuickAction, quickActionsOf } from "../api/chat-client";
import { Badge } from "../components/atoms/Badge";
import { Button } from "../components/atoms/Button";
import { Card } from "../components/atoms/Card";
import { AsyncState } from "../components/kit/AsyncState";
import { JsonBlock } from "../components/kit/JsonBlock";
import { PageHeader } from "../components/kit/PageHeader";
import { useAdminData } from "../hooks/useAdminData";
import { T } from "../ui/tokens";

/** One flat, stably-ordered list: by agent name, then by the order the
 *  registration declared its actions in (its own intended priority). */
function flattenActions(agents: AgentSummary[]): { agent: AgentSummary; action: QuickAction }[] {
  return agents
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((agent) => quickActionsOf(agent).map((action) => ({ agent, action })));
}

export function ActionsPage() {
  // One-shot (`0`): the registration's action list is static for the life of
  // the server process — polling it would be noise.
  const { data, loading, error } = useAdminData<AgentSummary[]>("/agents", 0);
  const navigate = useNavigate();

  if (loading || error) {
    return (
      <div>
        <PageHeader title="Actions" />
        <AsyncState
          kind={loading ? "loading" : "error"}
          loading="Loading actions..."
          error={error ? { title: "Failed to load agents", message: error } : undefined}
        />
      </div>
    );
  }

  const rows = flattenActions(data ?? []);

  return (
    <div>
      <PageHeader
        title="Actions"
        badges={
          rows.length > 0 ? (
            <Badge tone="mute" variant="outline">
              {rows.length} {rows.length === 1 ? "action" : "actions"}
            </Badge>
          ) : undefined
        }
      />
      {rows.length === 0 ? (
        <AsyncState
          kind="empty"
          empty={{
            title: "No quick actions",
            body: "Agents surface actions here by declaring `quickActions` on their registration.",
          }}
        />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {rows.map(({ agent, action }) => (
            <ActionCard
              key={`${agent.id}:${action.id}`}
              agent={agent}
              action={action}
              onRun={() =>
                // Router STATE, not a query param — see the file header.
                navigate(`/chat/${encodeURIComponent(agent.id)}`, {
                  state: { autoSend: action.prompt },
                })
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ActionCard({
  agent,
  action,
  onRun,
}: {
  agent: AgentSummary;
  action: QuickAction;
  onRun: () => void;
}) {
  return (
    <Card>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 10, flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: T.fz.md, fontWeight: 600 }}>{action.label}</div>
          {action.description && (
            <div style={{ fontSize: T.fz.small, color: "var(--ink-2)", marginTop: 2 }}>
              {action.description}
            </div>
          )}
        </div>
        <Badge tone="ok" variant="outline">
          {agent.name}
        </Badge>
        {/* Visible text stays short; the accessible name carries the whole
            action (label-in-name holds — "Run" is a prefix of it). */}
        <Button size="sm" onClick={onRun} aria-label={`Run ${action.label}`}>
          Run
        </Button>
      </div>
      {/* Open by default — the template is the point of this page, not a
          detail to go hunting for. `maxHeight` keeps a long brief from
          burying the next card; it scrolls in place. */}
      <details open style={{ marginTop: 10 }}>
        <summary style={{ cursor: "pointer", fontSize: T.fz.tiny, color: "var(--mute)" }}>
          Prompt template
        </summary>
        <JsonBlock value={action.prompt} raw maxHeight={220} style={{ marginTop: 6 }} />
      </details>
    </Card>
  );
}

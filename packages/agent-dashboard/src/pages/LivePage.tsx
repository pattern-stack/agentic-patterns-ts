import { Badge } from "../components/atoms/Badge";
import { Button } from "../components/atoms/Button";
import { Card } from "../components/atoms/Card";
import { Spinner } from "../components/atoms/Spinner";
import { AlertIcon } from "../components/atoms/icons";
import { EventStream } from "../components/organisms/EventStream";
import { useEventStream } from "../hooks/useEventStream";

export function LivePage() {
  const { events, connected, error, clear } = useEventStream("/admin/events/stream");

  return (
    <div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 20,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <h1 style={{ fontSize: 20, fontWeight: 600 }}>Live Events</h1>
          {connected ? (
            <Badge tone="ok" variant="outline">
              <span
                style={{
                  display: "inline-block",
                  width: 6,
                  height: 6,
                  borderRadius: "50%",
                  background: "var(--ok)",
                }}
              />
              connected
            </Badge>
          ) : (
            <Badge tone="warn" variant="outline">
              <Spinner size={10} color="var(--warn)" thickness={1.5} />
              reconnecting…
            </Badge>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <Badge tone="mute" variant="outline">
            {events.length} events
          </Badge>
          <Button variant="ghost" size="sm" onClick={clear}>
            Clear
          </Button>
        </div>
      </div>
      {error && (
        <Card
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginBottom: 12,
            padding: "10px 14px",
            color: "var(--err)",
            borderColor: "var(--err)",
            fontSize: 13,
          }}
          padded={false}
        >
          <AlertIcon size={14} />
          <span>{error}</span>
        </Card>
      )}
      <Card padded={false}>
        <EventStream events={events} />
      </Card>
    </div>
  );
}

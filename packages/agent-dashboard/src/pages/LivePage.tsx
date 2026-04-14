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
            <Badge tone="green" variant="outline">
              <span
                style={{
                  display: "inline-block",
                  width: 6,
                  height: 6,
                  borderRadius: "50%",
                  background: "var(--green)",
                }}
              />
              connected
            </Badge>
          ) : (
            <Badge tone="yellow" variant="outline">
              <Spinner size={10} color="var(--yellow)" thickness={1.5} />
              reconnecting…
            </Badge>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <Badge tone="muted" variant="outline">
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
            color: "var(--red)",
            borderColor: "var(--red)",
            fontSize: 13,
          }}
          padded={false}
        >
          <AlertIcon size={14} />
          <span>{error}</span>
        </Card>
      )}
      <Card padded={false}>
        <EventStream events={events} connected={connected} />
      </Card>
    </div>
  );
}

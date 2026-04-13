import { EventStream } from "../components/EventStream";
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
        <h1 style={{ fontSize: 20, fontWeight: 600 }}>Live Events</h1>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ fontSize: 13, color: "var(--text-secondary)" }}>
            {events.length} events
          </span>
          <button
            type="button"
            onClick={clear}
            style={{
              padding: "4px 12px",
              fontSize: 13,
              background: "var(--bg-tertiary)",
              color: "var(--text-primary)",
              border: "1px solid var(--border)",
              borderRadius: 6,
              cursor: "pointer",
            }}
          >
            Clear
          </button>
        </div>
      </div>
      {error && (
        <div
          style={{
            color: "var(--accent-yellow)",
            fontSize: 13,
            marginBottom: 12,
          }}
        >
          {error}
        </div>
      )}
      <EventStream events={events} connected={connected} />
    </div>
  );
}

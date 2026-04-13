import { useEffect, useRef, useState } from "react";

export interface StreamEvent {
  id: string;
  type: string;
  data: Record<string, unknown>;
  timestamp: string;
}

const MAX_EVENTS = 500;

interface UseEventStreamResult {
  events: StreamEvent[];
  connected: boolean;
  error: string | null;
  clear: () => void;
}

export function useEventStream(path: string): UseEventStreamResult {
  const [events, setEvents] = useState<StreamEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const counterRef = useRef(0);

  useEffect(() => {
    const source = new EventSource(path);

    source.onopen = () => {
      setConnected(true);
      setError(null);
    };

    source.onmessage = (event) => {
      try {
        const parsed = JSON.parse(event.data);
        const streamEvent: StreamEvent = {
          id: String(counterRef.current++),
          type: parsed.type ?? "unknown",
          data: parsed,
          timestamp: parsed.timestamp ?? new Date().toISOString(),
        };
        setEvents((prev) => {
          const next = [...prev, streamEvent];
          return next.length > MAX_EVENTS ? next.slice(-MAX_EVENTS) : next;
        });
      } catch {
        // ignore malformed events
      }
    };

    source.onerror = () => {
      setConnected(false);
      setError("Connection lost. Reconnecting...");
    };

    return () => {
      source.close();
      setConnected(false);
    };
  }, [path]);

  const clear = () => setEvents([]);

  return { events, connected, error, clear };
}

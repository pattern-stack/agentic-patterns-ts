import { useEffect, useRef, useState } from "react";

export interface StreamEvent {
  id: string;
  type: string;
  data: Record<string, unknown>;
  timestamp: string;
}

const MAX_EVENTS = 500;
const INITIAL_RETRY_MS = 1000;
const MAX_RETRY_MS = 30_000;

interface UseEventStreamResult {
  events: StreamEvent[];
  connected: boolean;
  error: string | null;
  clear: () => void;
}

export interface UseEventStreamOptions {
  /**
   * Events to seed `events` with on first render. Pages that hydrate from
   * REST history pass these in so the UI doesn't start empty on cold load.
   */
  initialEvents?: StreamEvent[];
}

export function useEventStream(
  path: string,
  options: UseEventStreamOptions = {},
): UseEventStreamResult {
  const [events, setEvents] = useState<StreamEvent[]>(options.initialEvents ?? []);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const counterRef = useRef(0);
  const retryDelayRef = useRef(INITIAL_RETRY_MS);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    // Allow callers to defer the connection by passing an empty path. Useful
    // when the page is still hydrating from REST and the SSE feed shouldn't
    // start until that's done.
    if (!path) return;

    let cancelled = false;
    let source: EventSource | null = null;

    function connect() {
      if (cancelled) return;

      source = new EventSource(path);

      source.onopen = () => {
        setConnected(true);
        setError(null);
        retryDelayRef.current = INITIAL_RETRY_MS;
      };

      // The raw event-log's subscription list. This is the ONE event-name list
      // that legitimately must exist: EventSource has no wildcard — a NAMED SSE
      // event (`event: X`) only fires a listener registered for X, so this panel
      // must enumerate what it wants to see. (The chat has NO such list — its
      // parser is name-agnostic; the reducer decides rendering. See
      // api/sse-events.ts WireFrame.) A new event type missing here only means
      // the debug log omits it — never a chat regression.
      const NAMED_EVENTS = [
        "claude_code.hook",
        "step.start",
        "step.end",
        "tool.start",
        "tool.end",
        "tool.intent",
        "llm.start",
        "llm.end",
        "iteration.start",
        "iteration.end",
        "agent.reasoning",
        "message.start",
        "message.delta",
        "message.complete",
        "conversation.start",
        "conversation.end",
      ];

      const ingest = (type: string, data: string) => {
        try {
          const parsed = JSON.parse(data);
          const streamEvent: StreamEvent = {
            id: String(counterRef.current++),
            type,
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

      source.onmessage = (e) => ingest(e.type || "message", e.data);
      for (const name of NAMED_EVENTS) {
        source.addEventListener(name, (e) => ingest(name, (e as MessageEvent).data));
      }

      source.onerror = () => {
        setConnected(false);
        setError("Connection lost. Reconnecting...");
        source?.close();
        source = null;

        if (!cancelled) {
          const delay = retryDelayRef.current;
          retryDelayRef.current = Math.min(delay * 2, MAX_RETRY_MS);
          retryTimerRef.current = setTimeout(connect, delay);
        }
      };
    }

    connect();

    return () => {
      cancelled = true;
      source?.close();
      source = null;
      setConnected(false);
      if (retryTimerRef.current) {
        clearTimeout(retryTimerRef.current);
      }
    };
  }, [path]);

  const clear = () => setEvents([]);

  return { events, connected, error, clear };
}

/**
 * GraphPage — Phase-A live constellation.
 *
 * Pick a registered agent, send ONE message, and animate the chain-projection
 * constellation from the streamed SSE events. Reuses api/chat-client directly
 * (NOT useChat — this page only needs the raw event stream for the graph, no
 * chat thread). Each ClientEvent is flattened through toEventLike into a flat
 * EventLike and appended to liveEvents; the growing array reveals nodes in
 * GraphPanel's chain mode. Read-only graph; no sessions, no scrubber (live).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  type AgentSummary,
  createConversation,
  listAgents,
  streamMessage,
} from "../api/chat-client";
import { toEventLike } from "../api/event-adapter";
import { GraphPanel } from "../components/GraphPanel";
import { Badge } from "../components/atoms/Badge";
import { Button } from "../components/atoms/Button";
import { Spinner } from "../components/atoms/Spinner";
import type { EventLite, GraphSource } from "../graph/composition";

export function GraphPage() {
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [input, setInput] = useState("");
  const [liveEvents, setLiveEvents] = useState<EventLite[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [runKey, setRunKey] = useState("idle");

  const convIdRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    let cancelled = false;
    listAgents()
      .then((list) => {
        if (cancelled) return;
        setAgents(list);
        setSelectedId((cur) => cur ?? list[0]?.id ?? null);
      })
      .catch((err) => {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : "Failed to load agents");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // chain-mode GraphSource — rebuilt as the live stream grows (eventCount is the
  // reveal key inside GraphPanel).
  const source = useMemo<GraphSource>(
    () => ({ mode: "chain", arm: "single", toolDefs: [], events: liveEvents }),
    [liveEvents],
  );

  const selectAgent = (id: string) => {
    setSelectedId(id);
    // a new agent → a fresh conversation on the next send.
    convIdRef.current = null;
    abortRef.current?.abort();
    setStreaming(false);
    setLiveEvents([]);
  };

  const send = async (content: string) => {
    if (!selectedId || streaming || !content.trim()) return;
    const conv = convIdRef.current ?? (await createConversation(selectedId)).id;
    convIdRef.current = conv;

    setLiveEvents([]);
    setRunKey(String(Date.now()));
    setStreaming(true);
    setInput("");

    const ac = new AbortController();
    abortRef.current = ac;
    try {
      for await (const ev of streamMessage(conv, content, ac.signal)) {
        setLiveEvents((prev) => [...prev, toEventLike(ev)]);
      }
    } catch (err) {
      if (!ac.signal.aborted) {
        setLoadError(err instanceof Error ? err.message : "Stream failed");
      }
    } finally {
      setStreaming(false);
    }
  };

  const abort = () => {
    abortRef.current?.abort();
    setStreaming(false);
  };

  return (
    <div className="graph-route" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <h1 style={{ fontSize: 20, fontWeight: 600, margin: 0 }}>Graph</h1>
        <select
          value={selectedId ?? ""}
          onChange={(e) => selectAgent(e.target.value)}
          disabled={!agents.length || streaming}
          style={{
            fontFamily: "inherit",
            fontSize: 13,
            background: "var(--bg-inset)",
            color: "var(--fg-default)",
            border: "1px solid var(--border)",
            borderRadius: 6,
            padding: "6px 10px",
            minWidth: 200,
          }}
        >
          {agents.length === 0 && <option value="">No agents registered</option>}
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        <div style={{ flex: 1 }} />
        {streaming && (
          <Badge tone="emerald" variant="outline">
            <Spinner size={9} color="var(--accent-emerald)" /> streaming
          </Badge>
        )}
        {loadError && <span style={{ fontSize: 12, color: "var(--red)" }}>{loadError}</span>}
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send(input);
            }
          }}
          disabled={!selectedId || streaming}
          placeholder={selectedId ? "Ask the agent something…" : "Select an agent to start."}
          style={{
            flex: 1,
            fontFamily: "inherit",
            fontSize: 13,
            background: "var(--bg-inset)",
            color: "var(--fg-default)",
            border: "1px solid var(--border)",
            borderRadius: 6,
            padding: "8px 12px",
          }}
        />
        <Button onClick={() => void send(input)} disabled={!selectedId || streaming}>
          Send
        </Button>
        {streaming && (
          <Button variant="ghost" onClick={abort}>
            Abort
          </Button>
        )}
      </div>

      <div style={{ height: 480 }}>
        <GraphPanel source={source} runKey={runKey} live />
      </div>
    </div>
  );
}

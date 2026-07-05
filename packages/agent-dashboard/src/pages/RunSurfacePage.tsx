/**
 * RunSurfacePage — the integrated Live Run surface.
 *
 * Owns the replay engine and composes every piece around ONE shared cursor: the
 * constellation canvas (HUD overlay + node inspector) on the left, the
 * LiveTracePanel scrubber on the right, an agent picker + message box + a
 * Chain ⇄ Composition toggle up top. Clicking a trace row seeks the graph; Play
 * walks both in lockstep (replay); a live run drains the cursor as SSE arrives.
 *
 * Two trace sources, ONE renderer:
 *   • LIVE — pick an agent, send a message; `streamMessage` events flatten
 *     through `toEventLike` into the fold, and the engine drains the cursor at a
 *     paced cadence as they arrive (`live`). The answer streams into the panel.
 *   • DEMO — before any live run, the deterministic `SAMPLE_EVENTS` play through
 *     the exact same stack (browser-verifiable without a model).
 * The Chain ⇄ Composition toggle swaps the GRAPH (executed chain vs. the agent's
 * full declared surface) while the same trace overlays both.
 *
 * This is the flagship run view; the older split /graph + /chat routes remain for
 * the raw event log + free-form chat.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type AgentCompositionDetail,
  type AgentSummary,
  createConversation,
  fetchAgentCapabilities,
  fetchAgentComposition,
  listAgents,
  streamMessage,
} from "../api/chat-client";
import { toEventLike } from "../api/event-adapter";
import { ConstellationGraph } from "../constellation/ConstellationGraph";
import { LiveTracePanel } from "../constellation/LiveTracePanel";
import { NodeInspector, type RunMeta, buildProvenanceMap } from "../constellation/NodeInspector";
import { RunBarHud } from "../constellation/RunBarHud";
import { prettifySlug } from "../graph/catalog";
import { type EventLite, type GraphSource, buildGraph, buildToolIndex } from "../graph/composition";
import {
  SAMPLE_ANSWER,
  SAMPLE_CAPABILITIES,
  SAMPLE_EVENTS,
  SAMPLE_REQUEST,
  SAMPLE_SYSTEM_PROMPT,
} from "../graph/sample-run-trace";
import { eventsToSteps } from "../graph/trace-from-events";
import type { CapabilityMeta } from "../graph/types";
import { useRunReplay } from "../graph/use-run-replay";
import { Badge, Button } from "../ui/atoms";
import { T } from "../ui/tokens";

const TOOL_INDEX = buildToolIndex();
const DEMO_META: RunMeta = {
  request: SAMPLE_REQUEST,
  answer: SAMPLE_ANSWER,
  systemPrompt: SAMPLE_SYSTEM_PROMPT,
};

type GraphMode = "chain" | "composition";
const MODES: { value: GraphMode; label: string }[] = [
  { value: "chain", label: "Chain" },
  { value: "composition", label: "Composition" },
];

function ModeToggle({ mode, onChange }: { mode: GraphMode; onChange: (m: GraphMode) => void }) {
  return (
    <div
      style={{
        display: "flex",
        gap: 3,
        background: "var(--fill)",
        padding: 3,
        borderRadius: T.radius.md,
      }}
    >
      {MODES.map((m) => (
        <button
          key={m.value}
          type="button"
          onClick={() => onChange(m.value)}
          title={
            m.value === "chain"
              ? "Execution chain — the agents/tools that actually ran"
              : "Declared composition — the agent's full capabilities, lit as used"
          }
          style={{
            border: "none",
            cursor: "pointer",
            fontFamily: "inherit",
            fontSize: T.fz.micro,
            padding: "5px 12px",
            borderRadius: T.radius.sm,
            background: mode === m.value ? "var(--paper)" : "transparent",
            color: mode === m.value ? "var(--ink)" : "var(--mute)",
            fontWeight: mode === m.value ? 600 : 500,
            boxShadow: mode === m.value ? T.shadow.s1 : "none",
          }}
        >
          {m.label}
        </button>
      ))}
    </div>
  );
}

/** Map the API's declared composition to the CapabilityMeta the graph builder wants. */
function toCapabilityMeta(caps: { name: string; tools: { name: string }[] }[]): CapabilityMeta[] {
  return caps.map((c) => ({
    name: c.name,
    title: prettifySlug(c.name),
    surface: "",
    blastRadius: "read",
    tools: c.tools.map((t) => t.name),
  }));
}

const bare = (t: unknown) => String(t).replace(/^(agent|pattern)\./, "");

export function RunSurfacePage() {
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [sentMsg, setSentMsg] = useState("");
  const [liveEvents, setLiveEvents] = useState<EventLite[]>([]);
  const [liveCaps, setLiveCaps] = useState<CapabilityMeta[] | null>(null);
  const [comp, setComp] = useState<AgentCompositionDetail | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [runKey, setRunKey] = useState("demo");
  const [mode, setMode] = useState<GraphMode>("chain");
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const convIdRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const isLive = streaming || liveEvents.length > 0;

  // load agents once
  useEffect(() => {
    let cancelled = false;
    listAgents()
      .then((list) => {
        if (cancelled) return;
        setAgents(list);
        setSelectedId((cur) => cur ?? list[0]?.id ?? null);
      })
      .catch(
        (e) => !cancelled && setError(e instanceof Error ? e.message : "Failed to load agents"),
      );
    return () => {
      cancelled = true;
    };
  }, []);

  // fetch the selected agent's declared composition (for composition mode) + its
  // full introspection with per-slot provenance (for the inspector's Provenance tab)
  useEffect(() => {
    if (!selectedId) return;
    let cancelled = false;
    fetchAgentCapabilities(selectedId)
      .then((c) => !cancelled && setLiveCaps(toCapabilityMeta(c.capabilities)))
      .catch(() => !cancelled && setLiveCaps(null));
    fetchAgentComposition(selectedId)
      .then((c) => !cancelled && setComp(c))
      .catch(() => !cancelled && setComp(null));
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  const events: EventLite[] = isLive ? liveEvents : SAMPLE_EVENTS;
  // stable ref (only changes when live/caps change) so the graph memo doesn't churn.
  const caps = useMemo<CapabilityMeta[]>(
    () => (isLive ? (liveCaps ?? []) : SAMPLE_CAPABILITIES),
    [isLive, liveCaps],
  );
  const agentName = isLive
    ? (agents.find((a) => a.id === selectedId)?.name ?? "agent")
    : "retrieval-analyst";

  const source = useMemo<GraphSource>(
    () =>
      mode === "composition" && caps.length > 0
        ? { mode: "composition", agentName, capabilities: caps }
        : { mode: "chain", arm: "single", toolDefs: [], events },
    [mode, caps, agentName, events],
  );
  const graph = useMemo(() => buildGraph(source), [source]);
  const steps = useMemo(
    () => eventsToSteps(events, TOOL_INDEX, { terminal: !streaming }),
    [events, streaming],
  );
  const replay = useRunReplay(steps, graph, runKey, {
    live: isLive,
    restBase: mode === "composition",
  });

  const liveAnswer = useMemo(() => {
    const complete = [...liveEvents].reverse().find((e) => bare(e.type) === "message.complete");
    if (complete && typeof complete.content === "string") return complete.content;
    return liveEvents
      .filter((e) => bare(e.type) === "message.delta")
      .map((e) => (typeof e.delta === "string" ? e.delta : ""))
      .join("");
  }, [liveEvents]);

  const runMeta: RunMeta = isLive ? { request: sentMsg, answer: liveAnswer } : DEMO_META;
  const selectedNode = selectedNodeId
    ? (graph.nodes.find((n) => n.id === selectedNodeId) ?? null)
    : null;

  // real /composition per-slot provenance, keyed by graph node id (for the
  // inspector) — only in LIVE mode, where the graph IS the selected agent's; the
  // demo graph is a fixed sample unrelated to the picked agent, so it derives.
  const provenance = useMemo(
    () => (isLive ? buildProvenanceMap(graph.nodes, comp?.role) : {}),
    [isLive, comp, graph],
  );

  const send = useCallback(
    async (content: string) => {
      if (!selectedId || streaming || !content.trim()) return;
      setError(null);
      const conv = convIdRef.current ?? (await createConversation(selectedId)).id;
      convIdRef.current = conv;
      setSentMsg(content);
      setLiveEvents([]);
      setRunKey(String(Date.now()));
      setStreaming(true);
      setInput("");
      const ac = new AbortController();
      abortRef.current = ac;
      try {
        for await (const ev of streamMessage(conv, content, undefined, ac.signal)) {
          setLiveEvents((prev) => [...prev, toEventLike(ev)]);
        }
      } catch (e) {
        if (!ac.signal.aborted) setError(e instanceof Error ? e.message : "Stream failed");
      } finally {
        setStreaming(false);
      }
    },
    [selectedId, streaming],
  );

  const selectAgent = (id: string) => {
    setSelectedId(id);
    convIdRef.current = null;
    abortRef.current?.abort();
    setStreaming(false);
    setLiveEvents([]);
    setLiveCaps(null);
    setComp(null);
    setRunKey("demo");
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <h1 style={{ fontSize: 20, fontWeight: 600, margin: 0 }}>Live Run</h1>
        <Badge tone={isLive ? "run" : "mute"}>{isLive ? "live" : "demo · sample trace"}</Badge>
        <div style={{ flex: 1 }} />
        <ModeToggle mode={mode} onChange={setMode} />
        {!isLive && (
          <Button variant="default" onClick={replay.playing ? replay.pause : replay.play}>
            {replay.playing ? "⏸ Pause" : "▶ Play"}
          </Button>
        )}
        {!isLive && (
          <Button variant="ghost" onClick={replay.reset}>
            ↺ Reset
          </Button>
        )}
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <select
          value={selectedId ?? ""}
          onChange={(e) => selectAgent(e.target.value)}
          disabled={!agents.length || streaming}
          style={{
            fontFamily: "inherit",
            fontSize: 13,
            background: "var(--fill)",
            color: "var(--ink)",
            border: "1px solid var(--line)",
            borderRadius: T.radius.sm,
            padding: "7px 10px",
            minWidth: 170,
          }}
        >
          {agents.length === 0 && <option value="">No agents registered</option>}
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
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
            minWidth: 220,
            fontFamily: "inherit",
            fontSize: 13,
            background: "var(--fill)",
            color: "var(--ink)",
            border: "1px solid var(--line)",
            borderRadius: T.radius.sm,
            padding: "8px 12px",
          }}
        />
        <Button onClick={() => void send(input)} disabled={!selectedId || streaming}>
          Send
        </Button>
        {streaming && (
          <Button variant="ghost" onClick={() => abortRef.current?.abort()}>
            Abort
          </Button>
        )}
        {error && <span style={{ fontSize: 12, color: "var(--red)" }}>{error}</span>}
      </div>

      <div style={{ display: "flex", gap: 16, minHeight: 540 }}>
        <div
          style={{
            flex: 1,
            position: "relative",
            minWidth: 0,
            border: "1px solid var(--line)",
            borderRadius: T.radius.lg,
            overflow: "hidden",
            background: "var(--background)",
          }}
        >
          <RunBarHud hud={replay.frame.hud} />
          <ConstellationGraph
            graph={graph}
            frame={replay.frame}
            selectedNodeId={selectedNodeId}
            onNodeClick={(id) => setSelectedNodeId((cur) => (cur === id ? null : id))}
          />
          {selectedNode && (
            <NodeInspector
              node={selectedNode}
              steps={steps}
              runMeta={runMeta}
              provenance={provenance}
              onClose={() => setSelectedNodeId(null)}
            />
          )}
        </div>
        <LiveTracePanel
          steps={steps}
          cursor={replay.cursor}
          onSeek={replay.seek}
          request={runMeta.request}
          answer={runMeta.answer}
        />
      </div>
    </div>
  );
}

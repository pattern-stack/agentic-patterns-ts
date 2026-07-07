/**
 * RunSurfacePage — the integrated Live Run surface.
 *
 * Owns the replay engine and composes every piece around ONE shared cursor: the
 * constellation canvas (HUD overlay + node inspector) on the left, the
 * LiveTracePanel scrubber on the right, an agent picker + message box + a
 * Chain ⇄ Composition toggle up top. Clicking a trace row seeks the graph; Play
 * walks both in lockstep (replay); a live run drains the cursor as SSE arrives.
 *
 * THREE trace sources, ONE renderer (precedence: streaming/live > replay-of-
 * persisted > demo, port-map §3.4):
 *   • LIVE — pick an agent, send a message; `streamMessage` events flatten
 *     through `toEventLike` into the fold, and the engine drains the cursor at a
 *     paced cadence as they arrive (`live`). The answer streams into the panel.
 *   • REPLAY — pick a persisted run from the run picker; its events fetch via
 *     `runsApi` and adapt through `persistedToEventLike` into the SAME fold,
 *     idling at cursor -1 until Play (S6).
 *   • DEMO — before any live/replayed run, the deterministic `SAMPLE_EVENTS`
 *     play through the exact same stack (browser-verifiable without a model).
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
import type { RunRow, RunSummary } from "../api/types";
import { Badge } from "../components/atoms/Badge";
import { Button } from "../components/atoms/Button";
import { DropdownMenu } from "../components/kit/DropdownMenu";
import { inputStyle } from "../components/kit/Field";
import { Segmented } from "../components/kit/Segmented";
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
import { eventsToSteps, persistedToEventLike } from "../graph/trace-from-events";
import type { CapabilityMeta } from "../graph/types";
import { useRunReplay } from "../graph/use-run-replay";
import { relTime, shortId } from "../lib/format";
import {
  MAX_RUN_CHIPS,
  pickOrDeselectRun,
  pinSelectedRun,
  sortRunsNewestFirst,
} from "../lib/runPicker";
import { fetchRun, fetchRunEvents, fetchRuns } from "../lib/runsApi";
import { T } from "../ui/tokens";

const TOOL_INDEX = buildToolIndex();
const DEMO_META: RunMeta = {
  request: SAMPLE_REQUEST,
  answer: SAMPLE_ANSWER,
  systemPrompt: SAMPLE_SYSTEM_PROMPT,
};

/** Honest degradation (port-map §6): neither RunSummary nor RunRow persists
 *  the user's original request text on this runtime version — see
 *  `api/types.ts`'s `RunRow` doc comment. Render this instead of fabricating one. */
const REQUEST_NOT_PERSISTED =
  "(request not available — this server doesn't persist the run's original prompt yet)";
const REQUEST_NOT_PERSISTED_SHORT = "(request not persisted)";

/** A replayed persisted run: the fetched row + its events adapted to the fold's shape. */
interface ReplayRun {
  run: RunRow;
  events: EventLite[];
}

type GraphMode = "chain" | "composition";
const MODES: { value: GraphMode; label: string; title: string }[] = [
  { value: "chain", label: "Chain", title: "Execution chain — the agents/tools that actually ran" },
  {
    value: "composition",
    label: "Composition",
    title: "Declared composition — the agent's full capabilities, lit as used",
  },
];

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

/* ── run picker (port-map §3.4, ported from swe-brain LiveRunSurface.tsx:74-163) ── */

/** One run chip's tooltip/detail line — model · tool calls · status · relative time. */
function runChipTitle(r: RunSummary): string {
  const tools = r.toolCalls ?? 0;
  return `${r.model ?? "model?"} · ${tools} tool call${tools === 1 ? "" : "s"} · ${r.status} · ${relTime(r.tsStart)}`;
}

/** An inline topbar chip for one run — click to replay it. */
function RunChip({
  run,
  active,
  onClick,
}: {
  run: RunSummary;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={runChipTitle(run)}
      aria-label={`Run ${shortId(run.runId, 6)}`}
      style={{
        fontFamily: T.font.mono,
        fontSize: T.fz.micro,
        padding: "3px 9px",
        borderRadius: T.radius.pill,
        border: `1px solid ${active ? "var(--accent)" : "var(--line)"}`,
        background: active ? "var(--accent-soft)" : "var(--fill)",
        color: active ? "var(--accent-ink)" : "var(--ink-2)",
        cursor: "pointer",
        whiteSpace: "nowrap",
      }}
    >
      {shortId(run.runId, 6)} · {run.toolCalls ?? 0}t
    </button>
  );
}

/** One row of the overflow dropdown's run list. */
function RunPickerRow({
  run,
  active,
  onPick,
}: {
  run: RunSummary;
  active: boolean;
  onPick: (id: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onPick(run.runId)}
      style={{
        display: "block",
        width: "100%",
        textAlign: "left",
        padding: "8px 12px",
        background: active ? "var(--accent-soft)" : "transparent",
        border: "none",
        borderBottom: "1px solid var(--line)",
        cursor: "pointer",
      }}
    >
      <div style={{ fontFamily: T.font.mono, fontSize: T.fz.micro, color: "var(--ink-2)" }}>
        {shortId(run.runId)} · {run.toolCalls ?? 0}t · {run.model ?? "model?"} ·{" "}
        {relTime(run.tsStart)}
      </div>
      <div
        style={{
          fontSize: T.fz.micro,
          color: "var(--mute)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {REQUEST_NOT_PERSISTED_SHORT}
      </div>
    </button>
  );
}

/**
 * Run-picker overflow: a compact "N ▾" chip (kit `DropdownMenu`'s backdrop(z25)
 * + right-anchored panel(z30, w300, maxH360, `--shadow-3`) pattern) that opens
 * the full run list, so the topbar stays at `MAX_RUN_CHIPS` inline chips
 * instead of an unbounded strip.
 */
function RunPickerMenu({
  runs,
  activeRunId,
  onPick,
}: {
  runs: RunSummary[];
  activeRunId: string | null;
  onPick: (id: string) => void;
}) {
  return (
    <DropdownMenu
      align="right"
      width={300}
      maxHeight={360}
      trigger={({ toggle }) => (
        <button
          type="button"
          onClick={toggle}
          aria-label={`All runs (${runs.length})`}
          style={{
            fontFamily: T.font.mono,
            fontSize: T.fz.micro,
            padding: "3px 9px",
            borderRadius: T.radius.pill,
            border: "1px solid var(--line)",
            background: "var(--fill)",
            color: "var(--ink-2)",
            cursor: "pointer",
          }}
        >
          {runs.length} ▾
        </button>
      )}
    >
      {runs.map((r) => (
        <RunPickerRow key={r.runId} run={r} active={r.runId === activeRunId} onPick={onPick} />
      ))}
    </DropdownMenu>
  );
}

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

  // run picker + persisted-run replay (S6) — third source state, see module doc.
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [runsUnconfigured, setRunsUnconfigured] = useState(false);
  const [replayRun, setReplayRun] = useState<ReplayRun | null>(null);
  const [replayLoading, setReplayLoading] = useState(false);

  const convIdRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // Monotonic pick-token: rapid-clicking two run chips fires two concurrent
  // `pickRun` calls whose `Promise.all` can resolve in EITHER order — without
  // this, the last one to RETURN wins the state commit, not the last one
  // CLICKED. Each call captures the token at its own start; only the call
  // whose token still matches the ref when it resolves is allowed to commit.
  const pickTokenRef = useRef(0);

  const isLive = streaming || liveEvents.length > 0;
  // Narrowable replay handle (precedence: live > replay > demo) — a separately
  // derived `isReplay` boolean wouldn't let TS narrow `replayRun` at each use
  // site, so this IS the narrowing check everywhere replay fields are read.
  const activeReplay: ReplayRun | null = isLive ? null : replayRun;
  const isReplay = activeReplay !== null;

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

  // run-history list for the picker (S6). Refetched after a live run finishes
  // so the new run appears — never auto-switches into replay (port-map §3.4).
  const refreshRuns = useCallback(() => {
    fetchRuns({ limit: 20 })
      .then((res) => {
        if (res.kind === "unconfigured") {
          setRunsUnconfigured(true);
          setRuns([]);
          return;
        }
        setRunsUnconfigured(false);
        setRuns(sortRunsNewestFirst(res.data));
      })
      .catch(() => {
        // list fetch failures degrade silently — the picker just stays empty;
        // live + demo modes are unaffected (honest-degradation §6).
      });
  }, []);
  useEffect(() => {
    refreshRuns();
  }, [refreshRuns]);

  // Picking a run: abort any active stream, clear live state, fetch the run +
  // its events, adapt through persistedToEventLike, and idle at cursor -1 (the
  // engine resets on runKey change) — Play replays through the untouched
  // buildGraph -> eventsToSteps -> useRunReplay stack.
  const pickRun = useCallback(async (runId: string) => {
    const token = ++pickTokenRef.current;
    abortRef.current?.abort();
    setStreaming(false);
    setLiveEvents([]);
    setError(null);
    setReplayLoading(true);
    try {
      const [runRes, eventsRes] = await Promise.all([fetchRun(runId), fetchRunEvents(runId)]);
      // A newer pickRun call started after this one — its resolution (or a
      // still-pending one) owns the state now; drop this stale result.
      if (token !== pickTokenRef.current) return;
      if (runRes.kind === "unconfigured" || eventsRes.kind === "unconfigured") {
        setError("run history is not configured on this server");
        return;
      }
      if (runRes.kind === "not-found" || eventsRes.kind === "not-found") {
        setError(`run "${shortId(runId)}" was not found (it may have expired)`);
        return;
      }
      const events = eventsRes.data.events.map(persistedToEventLike);
      setReplayRun({ run: runRes.data, events });
      setRunKey(runId);
      setSelectedNodeId(null);
    } catch (e) {
      if (token === pickTokenRef.current) {
        setError(e instanceof Error ? e.message : "Failed to load run");
      }
    } finally {
      if (token === pickTokenRef.current) setReplayLoading(false);
    }
  }, []);

  // Return to the demo sample trace (port-map §3.4 acceptance: "switch back
  // to demo" — there was previously NO way back short of a full reload).
  // Invalidates any in-flight `pickRun` so a stale resolution can't resurrect
  // the replay right after this clears it.
  const returnToDemo = useCallback(() => {
    pickTokenRef.current += 1;
    setReplayLoading(false);
    setReplayRun(null);
    setRunKey("demo");
    setSelectedNodeId(null);
    setError(null);
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

  const events: EventLite[] = isLive
    ? liveEvents
    : activeReplay
      ? activeReplay.events
      : SAMPLE_EVENTS;
  // stable ref (only changes when live/caps change) so the graph memo doesn't churn.
  // Replay has no composition data for the replayed run's (possibly different)
  // agent — caps stays empty, so `source` below falls back to chain mode, same
  // as any other caps-less state; the Composition toggle simply no-ops during
  // replay rather than fabricating a graph for a run that may belong to a
  // different agent than the one currently selected in the dropdown.
  const caps = useMemo<CapabilityMeta[]>(
    () => (isLive ? (liveCaps ?? []) : isReplay ? [] : SAMPLE_CAPABILITIES),
    [isLive, isReplay, liveCaps],
  );
  const agentName = isLive
    ? (agents.find((a) => a.id === selectedId)?.name ?? "agent")
    : activeReplay
      ? (activeReplay.run.agentName ?? "agent")
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

  const runMeta: RunMeta = isLive
    ? { request: sentMsg, answer: liveAnswer }
    : activeReplay
      ? {
          request: REQUEST_NOT_PERSISTED,
          answer: activeReplay.run.finalAnswer ?? "",
          systemPrompt: activeReplay.run.systemPrompt ?? undefined,
        }
      : DEMO_META;
  const selectedNode = selectedNodeId
    ? (graph.nodes.find((n) => n.id === selectedNodeId) ?? null)
    : null;

  // real /composition per-slot provenance, keyed by graph node id (for the
  // inspector) — only in LIVE mode, where the graph IS the selected agent's; the
  // demo/replay graphs aren't necessarily the currently-selected agent's, so
  // they derive no provenance either.
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
      setReplayRun(null); // a fresh send always supersedes any picked replay
      setRunKey(String(Date.now()));
      setStreaming(true);
      setInput("");
      const ac = new AbortController();
      abortRef.current = ac;
      try {
        for await (const ev of streamMessage(conv, content, undefined, ac.signal)) {
          setLiveEvents((prev) => [...prev, toEventLike(ev)]);
        }
        // the run just finished and is now persisted — refresh the picker's
        // list so it appears, but do NOT auto-switch into replay (that would
        // reset the cursor and re-dim the constellation you just watched
        // finish; port-map §3.4, swe-brain-tested behavior).
        refreshRuns();
      } catch (e) {
        if (!ac.signal.aborted) setError(e instanceof Error ? e.message : "Stream failed");
      } finally {
        setStreaming(false);
      }
    },
    [selectedId, streaming, refreshRuns],
  );

  const selectAgent = (id: string) => {
    setSelectedId(id);
    convIdRef.current = null;
    abortRef.current?.abort();
    setStreaming(false);
    setLiveEvents([]);
    setLiveCaps(null);
    setComp(null);
    setReplayRun(null);
    setRunKey("demo");
  };

  const activeRunId = activeReplay ? activeReplay.run.runId : null;
  const visibleRunChips = pinSelectedRun(runs, activeRunId, MAX_RUN_CHIPS);
  const hiddenRunCount = runs.length - visibleRunChips.length;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <h1 style={{ fontSize: 20, fontWeight: 600, margin: 0 }}>Live Run</h1>
        <Badge tone={isLive ? "run" : isReplay ? "accent" : "mute"}>
          {isLive ? "live" : isReplay ? "replay" : "demo · sample trace"}
        </Badge>

        {/* run picker (S6): newest-first inline chips + overflow dropdown. Honest
            degradation when persistence is off — the note replaces the picker,
            live + demo modes are unaffected. */}
        {runsUnconfigured ? (
          <span
            style={{ fontSize: T.fz.micro, color: "var(--mute)" }}
            title="start `ap playground` with AP_PERSISTENCE != 0 to enable run history"
          >
            run history unavailable — persistence not configured
          </span>
        ) : (
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            {runs.length === 0 && (
              <span style={{ fontSize: T.fz.micro, color: "var(--mute)" }}>no runs yet</span>
            )}
            {visibleRunChips.map((r) => (
              <RunChip
                key={r.runId}
                run={r}
                active={r.runId === activeRunId}
                // Clicking the ALREADY-active chip deselects it — the only
                // way back to demo mode before this was a full page reload
                // (port-map §3.4's "switch back to demo" acceptance).
                onClick={() => {
                  const next = pickOrDeselectRun(r.runId, activeRunId);
                  if (next === null) returnToDemo();
                  else void pickRun(next);
                }}
              />
            ))}
            {hiddenRunCount > 0 && (
              <RunPickerMenu
                runs={runs}
                activeRunId={activeRunId}
                onPick={(id) => {
                  const next = pickOrDeselectRun(id, activeRunId);
                  if (next === null) returnToDemo();
                  else void pickRun(next);
                }}
              />
            )}
            {replayLoading && (
              <span style={{ fontSize: T.fz.micro, color: "var(--mute)" }}>loading…</span>
            )}
            {isReplay && (
              <button
                type="button"
                onClick={returnToDemo}
                title="Return to the demo sample trace"
                style={{
                  fontFamily: T.font.mono,
                  fontSize: T.fz.micro,
                  padding: "3px 9px",
                  borderRadius: T.radius.pill,
                  border: "1px solid var(--line)",
                  background: "transparent",
                  color: "var(--mute)",
                  cursor: "pointer",
                }}
              >
                ↺ demo
              </button>
            )}
          </div>
        )}

        <div style={{ flex: 1 }} />
        <Segmented
          options={MODES}
          value={mode}
          onChange={setMode}
          size="sm"
          aria-label="Graph mode"
        />
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
          style={{ ...inputStyle, minWidth: 170 }}
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
          style={{ ...inputStyle, flex: 1, minWidth: 220, padding: "8px 12px" }}
        />
        <Button onClick={() => void send(input)} disabled={!selectedId || streaming}>
          Send
        </Button>
        {streaming && (
          <Button variant="ghost" onClick={() => abortRef.current?.abort()}>
            Abort
          </Button>
        )}
        {error && <span style={{ fontSize: 12, color: "var(--err)" }}>{error}</span>}
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

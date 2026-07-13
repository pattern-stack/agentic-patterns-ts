/**
 * ChatPage / Agent Console — pick a registered agent, converse with it over
 * the framework SSE transport, rendered through the ported cockpit chat
 * organism. S8 grows this into the Console (port-map §4.2):
 *
 *   1. SessionsMenu — `Sessions (N) ▾` (kit `DropdownMenu`) listing
 *      `GET /admin/conversations` filtered to the selected agent
 *      (`lib/sessions.ts sessionsForAgent`).
 *   2. Session replay — picking a session fetches its messages + per-message
 *      parts and maps them onto the chat organism's `Part` union
 *      (`chat/stored-parts.ts`), rendered read-only through the SAME
 *      `ChatPanel` (`onSend` omitted). "New Chat" returns to live.
 *   3. Trace rail — the collapsible side panel gains a second tab alongside
 *      the existing `AgentUniverse` ("what it can do"): `Trace` ("what just
 *      happened"), rendered via `components/TraceRail.tsx` off either the
 *      live turn's event stream or the viewed session's linked run.
 *
 * DO-NOT-REGRESS (hard line): live streaming (`agent_step` nesting via
 * `chat/model.ts`'s `applyParts`, untouched here), `CaptureCasePanel` (stays
 * wired to the LIVE conversation regardless of view mode — merely disabled
 * while viewing a past session), and per-turn abort semantics (`chat.abort`,
 * only reachable in live mode).
 *
 * The chat subtree is wrapped in `.chat-route` so the cockpit design tokens
 * (styles/tokens-base.css + styles/theme-<id>.css) resolve locally (see
 * pages/chat-route.css) without a second global stylesheet.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { type AgentSummary, listAgents } from "../api/chat-client";
import { fetchJSON } from "../api/client";
import type {
  ConversationMessage,
  ConversationMessagePart,
  ConversationSummary,
} from "../api/types";
import { ChatPanel, useChat } from "../chat";
import { CaptureCasePanel } from "../chat/CaptureCasePanel";
import type { ChatMessage } from "../chat/model";
import { storedMessagesToChat } from "../chat/stored-parts";
import "./chat-route.css";
import { AgentUniverse } from "../components/AgentUniverse";
import { TraceRail, type TraceRailSource } from "../components/TraceRail";
import { Badge } from "../components/atoms/Badge";
import { Button } from "../components/atoms/Button";
import { Spinner } from "../components/atoms/Spinner";
import { DropdownMenu } from "../components/kit/DropdownMenu";
import { inputStyle } from "../components/kit/Field";
import { Segmented } from "../components/kit/Segmented";
import { useAdminData } from "../hooks/useAdminData";
import { relTime, shortId, statusTone } from "../lib/format";
import { sessionsForAgent } from "../lib/sessions";
import { T } from "../ui/tokens";

type RailTab = "universe" | "trace";
const RAIL_TAB_OPTIONS: { value: RailTab; label: string }[] = [
  { value: "universe", label: "Universe" },
  { value: "trace", label: "Trace" },
];

/** #226 — how many Backpack/Scratchpad state frames render in the timeline.
 *  Applied as `data-density` on the chat column; chat.css does the rest
 *  (Off hides `.sd` frames, Writes compacts closed reads/innate frames). */
type ScratchpadDensity = "all" | "writes" | "off";
const DENSITY_OPTIONS: { value: ScratchpadDensity; label: string; title: string }[] = [
  { value: "all", label: "All", title: "Every state frame, full size" },
  {
    value: "writes",
    label: "Writes",
    title: "Write frames full size; reads and framework (auto) frames compact",
  },
  { value: "off", label: "Off", title: "Hide state frames (the escape hatch)" },
];

export function ChatPage() {
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [maxIterations, setMaxIterations] = useState(10); // matches the runner default
  const [railOpen, setRailOpen] = useState(true);
  const [railTab, setRailTab] = useState<RailTab>("universe");
  const [density, setDensity] = useState<ScratchpadDensity>("writes"); // #226 default

  // #226: a [#N] cite seek with density Off would scroll to a hidden frame —
  // parts.tsx bubbles `chat:reveal-state-frames` instead, and we honestly flip
  // the toggle back to Writes before the seek lands (never seek to nothing).
  // flushSync is load-bearing: the dispatching seek (parts.tsx seekCite)
  // measures the frame's rect synchronously after dispatchEvent returns, and
  // under React's automatic batching a plain setDensity would commit a frame
  // LATER — the seek would measure a still-display:none frame (zero rect) and
  // scroll to the top of the column instead of the frame. dispatchEvent runs
  // this listener synchronously, so flushSync makes the CSS flip visible
  // before seekCite continues.
  const chatColRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = chatColRef.current;
    if (!el) return;
    const reveal = () => flushSync(() => setDensity((d) => (d === "off" ? "writes" : d)));
    el.addEventListener("chat:reveal-state-frames", reveal);
    return () => el.removeEventListener("chat:reveal-state-frames", reveal);
  }, []);

  // Sessions (S8 Console upgrade): GET /admin/conversations has no per-agent
  // query param — filter + sort client-side (lib/sessions.ts).
  const { data: allSessions, error: sessionsError } =
    useAdminData<ConversationSummary[]>("/admin/conversations");

  // Session replay (read-only): `viewingId` set = replay mode. `viewingMessages`
  // is `null` while loading, `[]` for an empty session. `viewingRunId` is the
  // last message's linked run (`StoredMessage.runId`), if any — feeds the
  // trace rail. `viewTokenRef` guards against a stale fetch resolving after
  // the user has already switched sessions (or backed out to live) — same
  // monotonic-token pattern as `RunSurfacePage.pickRun`.
  const [viewingId, setViewingId] = useState<string | null>(null);
  const [viewingMessages, setViewingMessages] = useState<ChatMessage[] | null>(null);
  const [viewingRunId, setViewingRunId] = useState<string | null>(null);
  const [viewingError, setViewingError] = useState<string | null>(null);
  const viewTokenRef = useRef(0);

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

  const selected = useMemo(
    () => agents.find((a) => a.id === selectedId) ?? null,
    [agents, selectedId],
  );
  const sessions = useMemo(
    () => sessionsForAgent(allSessions ?? [], selected?.name),
    [allSessions, selected],
  );

  const chat = useChat(selectedId, { maxIterations });
  const exchangeCount = useMemo(
    () => chat.messages.filter((m) => m.role === "user").length,
    [chat.messages],
  );

  // GET /conversations/:id/messages + one GET /messages/:id/parts per message
  // (the N+1 `ConversationDetailPage` already accepts — batching is a later
  // server nicety, port-map §10.2) -> map onto the chat Part union.
  const pickSession = useCallback(async (id: string) => {
    const token = ++viewTokenRef.current;
    setViewingId(id);
    setViewingMessages(null);
    setViewingRunId(null);
    setViewingError(null);
    try {
      const msgs = await fetchJSON<ConversationMessage[]>(
        `/conversations/${encodeURIComponent(id)}/messages`,
      );
      const withParts = await Promise.all(
        msgs.map(async (message) => ({
          message,
          parts: await fetchJSON<ConversationMessagePart[]>(
            `/messages/${encodeURIComponent(message.id)}/parts`,
          ),
        })),
      );
      if (token !== viewTokenRef.current) return; // superseded by a newer pick / New Chat
      const sorted = withParts
        .slice()
        .sort((a, b) => Date.parse(a.message.createdAt) - Date.parse(b.message.createdAt));
      const partsById = new Map(sorted.map(({ message, parts }) => [message.id, parts]));
      setViewingMessages(
        storedMessagesToChat(
          sorted.map((s) => s.message),
          partsById,
        ),
      );
      // The trace rail follows the LAST linked run in the session (the most
      // recent turn) — "the current/selected turn's run" (port-map §4.2.3).
      const lastLinked = [...sorted].reverse().find((s) => s.message.runId);
      setViewingRunId(lastLinked?.message.runId ?? null);
    } catch (e) {
      if (token === viewTokenRef.current) {
        setViewingError(e instanceof Error ? e.message : "Failed to load session");
      }
    }
  }, []);

  // Returns to live mode. Also the "start fresh" affordance — resets the live
  // conversation too (matches this button's pre-S8 meaning of "New Chat").
  const newChat = useCallback(() => {
    viewTokenRef.current += 1; // invalidate any in-flight pickSession
    setViewingId(null);
    setViewingMessages(null);
    setViewingRunId(null);
    setViewingError(null);
    chat.reset();
  }, [chat]);

  const viewing = viewingId != null;
  const displayMessages = viewing ? (viewingMessages ?? []) : chat.messages;
  const traceSource: TraceRailSource = viewing
    ? { kind: "replay", runId: viewingRunId }
    : { kind: "live", events: chat.traceEvents, streaming: chat.streaming };

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 16,
        // AppShell's <main> has `padding: 24` (24px top + 24px bottom = 48px)
        // — this fills exactly the remaining viewport height so ChatPanel's
        // own inner scroll (not an outer page scroll) handles a long thread.
        height: "calc(100vh - 48px)",
        minHeight: 0,
      }}
    >
      <Header
        agents={agents}
        selectedId={selectedId}
        onSelect={(id) => {
          setSelectedId(id);
          newChat();
        }}
        onNewChat={newChat}
        conversationId={chat.conversationId}
        messages={chat.messages}
        exchangeCount={exchangeCount}
        streaming={chat.streaming}
        loadError={loadError}
        chatError={chat.error}
        description={selected?.description}
        maxIterations={maxIterations}
        onMaxIterations={setMaxIterations}
        density={density}
        onDensity={setDensity}
        sessions={sessions}
        sessionsError={sessionsError}
        viewingId={viewingId}
        onPickSession={pickSession}
        viewing={viewing}
      />
      <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", gap: 8 }}>
        {viewing && (
          <div style={{ fontSize: T.fz.tiny, fontFamily: T.font.mono, color: "var(--mute)" }}>
            Viewing session <b style={{ color: "var(--ink-2)" }}>{shortId(viewingId)}</b> —
            read-only. "New Chat" returns to live.
          </div>
        )}
        {viewingError && (
          <div style={{ fontSize: T.fz.small, color: "var(--err)" }}>{viewingError}</div>
        )}
        <div style={{ flex: 1, minHeight: 0, display: "flex", gap: 16 }}>
          <div
            ref={chatColRef}
            className="chat-route"
            style={{ flex: 1, minWidth: 0 }}
            data-density={density}
          >
            <ChatPanel
              messages={displayMessages}
              fill
              streaming={viewing ? false : chat.streaming}
              assistantName={selected?.name ?? "agent"}
              onSend={viewing ? undefined : chat.send}
              onAbort={viewing ? undefined : chat.abort}
              disabled={!selected}
              emptyLabel={
                viewing
                  ? viewingMessages === null
                    ? "Loading session…"
                    : "No messages in this session."
                  : selected
                    ? "No messages yet — say hello."
                    : "Select an agent to start chatting."
              }
              placeholder={
                selected ? `Message ${selected.name}…` : "Select an agent to start chatting."
              }
            />
          </div>
          <div style={{ display: "flex", alignItems: "stretch", flex: "none" }}>
            <button
              type="button"
              onClick={() => setRailOpen((v) => !v)}
              title={railOpen ? "Collapse panel" : "Show panel"}
              aria-label={railOpen ? "Collapse panel" : "Show panel"}
              style={{
                flex: "none",
                width: 20,
                border: "1px solid var(--line)",
                borderRight: railOpen ? "none" : "1px solid var(--line)",
                borderRadius: railOpen ? "8px 0 0 8px" : 8,
                background: "var(--paper)",
                color: "var(--mute)",
                cursor: "pointer",
                fontSize: T.fz.small,
                lineHeight: 1,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              {railOpen ? "›" : "‹"}
            </button>
            {railOpen && (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <Segmented
                  options={RAIL_TAB_OPTIONS}
                  value={railTab}
                  onChange={setRailTab}
                  size="sm"
                  aria-label="Side panel"
                />
                {railTab === "universe" ? (
                  <AgentUniverse agentId={selectedId} />
                ) : (
                  <TraceRail source={traceSource} />
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

interface HeaderProps {
  agents: AgentSummary[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onNewChat: () => void;
  conversationId: string | null;
  messages: ChatMessage[];
  exchangeCount: number;
  streaming: boolean;
  loadError: string | null;
  chatError: string | null;
  description?: string;
  maxIterations: number;
  onMaxIterations: (n: number) => void;
  density: ScratchpadDensity;
  onDensity: (d: ScratchpadDensity) => void;
  sessions: ConversationSummary[];
  sessionsError: string | null;
  viewingId: string | null;
  onPickSession: (id: string) => void;
  viewing: boolean;
}

function Header({
  agents,
  selectedId,
  onSelect,
  onNewChat,
  conversationId,
  messages,
  exchangeCount,
  streaming,
  loadError,
  chatError,
  description,
  maxIterations,
  onMaxIterations,
  density,
  onDensity,
  sessions,
  sessionsError,
  viewingId,
  onPickSession,
  viewing,
}: HeaderProps) {
  const selected = agents.find((a) => a.id === selectedId);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <h1 style={{ fontSize: T.fz.xxl, fontWeight: 600, margin: 0 }}>Chat</h1>
        <select
          value={selectedId ?? ""}
          onChange={(e) => onSelect(e.target.value)}
          disabled={!agents.length}
          style={{ ...inputStyle, minWidth: 200 }}
        >
          {agents.length === 0 && <option value="">No agents registered</option>}
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        <SessionsMenu
          sessions={sessions}
          error={sessionsError}
          viewingId={viewingId}
          onPick={onPickSession}
        />
        <Button
          variant="ghost"
          size="sm"
          onClick={onNewChat}
          disabled={!conversationId && !viewingId}
        >
          New Chat
        </Button>
        <label
          title="Cap the agent's tool-loop iterations for each message (the runner stops after this many)."
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            fontSize: T.fz.small,
            color: "var(--ink-2)",
          }}
        >
          max tool calls
          <input
            type="number"
            min={1}
            max={50}
            value={maxIterations}
            onChange={(e) =>
              onMaxIterations(Math.min(50, Math.max(1, Math.trunc(Number(e.target.value)) || 1)))
            }
            style={{ ...inputStyle, width: 56, padding: "6px 8px" }}
          />
        </label>
        <div
          title="How many Backpack/Scratchpad state frames render in the timeline. The run's scratchpad — what it carries between stages — not user memory."
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            fontSize: T.fz.small,
            color: "var(--ink-2)",
          }}
        >
          scratchpad
          <Segmented
            options={DENSITY_OPTIONS}
            value={density}
            onChange={onDensity}
            size="sm"
            aria-label="Scratchpad frame density"
          />
        </div>
        <div style={{ flex: 1 }} />
        {selected && (
          <Badge tone="ok" variant="outline">
            agent: {selected.name}
          </Badge>
        )}
        {exchangeCount > 0 && (
          <Badge tone="mute" variant="outline">
            {exchangeCount} {exchangeCount === 1 ? "exchange" : "exchanges"}
          </Badge>
        )}
        {streaming && (
          <Badge tone="ok" variant="outline">
            <Spinner size={9} /> streaming
          </Badge>
        )}
        {conversationId && (
          <span
            style={{
              fontFamily: T.font.mono,
              fontSize: T.fz.tiny,
              color: "var(--ink-3)",
            }}
          >
            {conversationId.slice(0, 8)}
          </span>
        )}
      </div>
      {description && (
        <div style={{ fontSize: T.fz.small, color: "var(--ink-2)" }}>{description}</div>
      )}
      {loadError && (
        <div style={{ fontSize: T.fz.small, color: "var(--err)" }}>
          Failed to load agents: {loadError}
        </div>
      )}
      {chatError && (
        <div style={{ fontSize: T.fz.small, color: "var(--err)" }}>Stream error: {chatError}</div>
      )}
      <CaptureCasePanel
        conversationId={conversationId}
        messages={messages}
        exchangeCount={exchangeCount}
        disabled={streaming || viewing}
      />
    </div>
  );
}

/**
 * SessionsMenu — `Sessions (N) ▾` dropdown listing this agent's past
 * conversations (port-map §4.2.1). Rows render only what `ConversationSummary`
 * actually carries — no title/first-request field exists in this runtime's
 * protocol (the same honest-degradation call as `RunPickerMenu`'s
 * "request not persisted" note, `api/types.ts` `RunRow`'s doc comment) — so
 * each row is id · message count · status · relative time.
 */
function SessionsMenu({
  sessions,
  error,
  viewingId,
  onPick,
}: {
  sessions: ConversationSummary[];
  error: string | null;
  viewingId: string | null;
  onPick: (id: string) => void;
}) {
  return (
    <DropdownMenu
      align="left"
      width={320}
      trigger={({ toggle }) => (
        <Button variant="ghost" size="sm" onClick={toggle}>
          Sessions ({sessions.length}) ▾
        </Button>
      )}
    >
      {error && (
        <div style={{ padding: "10px 12px", fontSize: T.fz.small, color: "var(--err)" }}>
          Failed to load sessions: {error}
        </div>
      )}
      {!error && sessions.length === 0 && (
        <div style={{ padding: "10px 12px", fontSize: T.fz.small, color: "var(--mute)" }}>
          No sessions yet for this agent.
        </div>
      )}
      {sessions.map((s) => (
        <button
          key={s.conversationId}
          type="button"
          onClick={() => onPick(s.conversationId)}
          style={{
            display: "block",
            width: "100%",
            textAlign: "left",
            padding: "8px 12px",
            background: s.conversationId === viewingId ? "var(--accent-soft)" : "transparent",
            border: "none",
            borderBottom: "1px solid var(--line)",
            cursor: "pointer",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              fontFamily: T.font.mono,
              fontSize: T.fz.small,
              color: "var(--ink-2)",
            }}
          >
            {shortId(s.conversationId)}
            <Badge tone="mute" mono>
              {s.messageCount} msg{s.messageCount === 1 ? "" : "s"}
            </Badge>
            <Badge tone={statusTone(s.status)}>{s.status}</Badge>
          </div>
          <div style={{ fontSize: T.fz.micro, color: "var(--mute)", marginTop: 2 }}>
            {relTime(s.lastMessageAt ?? s.startedAt)}
          </div>
        </button>
      ))}
    </DropdownMenu>
  );
}

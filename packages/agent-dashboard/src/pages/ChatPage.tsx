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
import { type RailSeekRequest, ScratchpadRail } from "../chat/ScratchpadRail";
import { AgentUniverse } from "../components/AgentUniverse";
import { TraceRail, type TraceRailSource } from "../components/TraceRail";
import { Badge } from "../components/atoms/Badge";
import { Button } from "../components/atoms/Button";
import { Spinner } from "../components/atoms/Spinner";
import { DropdownMenu } from "../components/kit/DropdownMenu";
import { Field, inputStyle } from "../components/kit/Field";
import { JsonBlock } from "../components/kit/JsonBlock";
import { Markdown } from "../components/kit/Markdown";
import { Segmented } from "../components/kit/Segmented";
import { useAdminData } from "../hooks/useAdminData";
import { relTime, shortId, statusTone } from "../lib/format";
import { sessionsForAgent } from "../lib/sessions";
import { T } from "../ui/tokens";

type RailTab = "universe" | "trace" | "scratchpad";
const RAIL_TAB_OPTIONS: { value: RailTab; label: string; title?: string }[] = [
  { value: "universe", label: "Universe" },
  { value: "trace", label: "Trace" },
  {
    value: "scratchpad",
    label: "Scratchpad",
    title: "What this run carries between stages — not user memory",
  },
];

/**
 * Parse the scope-context editor's draft text into a request-ready object
 * (#268) — the same "empty → undefined, else must be a JSON object" contract
 * `AgentLensPage`'s delivered-instance composer uses
 * (`pages/build/AgentLensPage.tsx` `compose()`), so the two context editors
 * in this dashboard agree on what "no context" and "bad context" mean.
 * Blocks (never silently drops) invalid JSON — a typed-in draft that gets
 * quietly discarded on Send would misreport the scope the run actually got.
 */
function parseContextJson(text: string): { value?: Record<string, unknown>; error?: string } {
  const trimmed = text.trim();
  if (trimmed.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { error: "Context must be a JSON object" };
    }
    return { value: parsed as Record<string, unknown> };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Invalid JSON" };
  }
}

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
  // Scope-context editor draft (#268) — `null` = untouched, so the editor
  // shows the SELECTED agent's `instantiation.defaults` until the operator
  // types. Reseeded to `null` on agent switch / New Chat (see `newChat`).
  const [contextText, setContextText] = useState<string | null>(null);
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

  // #226: the REVERSE seek — clicking a mono `.d-key` inside any Δ frame
  // bubbles `chat:seek-rail`; we open the side panel on the Scratchpad tab
  // (inside flushSync, so the rail is mounted before the seek request lands)
  // and hand the key to the rail, which scrolls to + flashes the slot's row.
  const [railSeek, setRailSeek] = useState<RailSeekRequest | null>(null);
  const railSeekNonce = useRef(0);
  // The rail consumes the request once handled (or once the replay feed
  // settles without the row) — clearing it here means a tab-switch remount
  // can never replay a stale seek (an unprompted scroll+flash).
  const clearRailSeek = useCallback(() => setRailSeek(null), []);
  useEffect(() => {
    const el = chatColRef.current;
    if (!el) return;
    const onSeekRail = (ev: Event) => {
      const key = (ev as CustomEvent<{ key?: string }>).detail?.key;
      if (!key) return;
      flushSync(() => {
        setRailOpen(true);
        setRailTab("scratchpad");
        setRailSeek({ key, nonce: ++railSeekNonce.current });
      });
    };
    el.addEventListener("chat:seek-rail", onSeekRail);
    return () => el.removeEventListener("chat:seek-rail", onSeekRail);
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

  // Scope context (#268) — `instantiation.available` gates whether the editor
  // + chip exist for this agent at all; `defaultsText` reseeds the editor
  // whenever `contextText` is untouched (`null`). `contextParse` re-derives
  // on every keystroke so Send can block on invalid JSON (never silently
  // drop a draft the operator can see, per `parseContextJson`'s doc).
  const contextAvailable = selected?.instantiation?.available === true;
  const defaultsText = useMemo(
    () => JSON.stringify(selected?.instantiation?.defaults ?? {}, null, 2),
    [selected],
  );
  const contextEditorText = contextText ?? defaultsText;
  const contextParse = useMemo(() => parseContextJson(contextEditorText), [contextEditorText]);

  const chat = useChat(selectedId, { maxIterations, context: contextParse.value });
  // Immutable once the conversation exists (Decision 2, spec §Design decisions) —
  // the editor locks and the panel falls back to the bound (echoed) context.
  const contextLocked = chat.conversationId != null;
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
    // Unlocks the scope editor and reseeds it from the (possibly new)
    // agent's defaults — the "New Chat to change scope" affordance (#268).
    setContextText(null);
    chat.reset();
  }, [chat]);

  const viewing = viewingId != null;
  const displayMessages = viewing ? (viewingMessages ?? []) : chat.messages;
  const traceSource: TraceRailSource = viewing
    ? { kind: "replay", runId: viewingRunId }
    : {
        kind: "live",
        events: chat.traceEvents,
        streaming: chat.streaming,
        runId: chat.lastRunId,
      };

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
        contextAvailable={contextAvailable}
        contextEditorText={contextEditorText}
        onContextEditorText={setContextText}
        contextError={contextParse.error}
        contextLocked={contextLocked}
        boundContext={chat.context}
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
              onRespondInput={viewing ? undefined : chat.respondInput}
              // Block Send while the scope-context draft doesn't parse — a
              // silently dropped edit would misreport what scope the run
              // actually got (#268; harmless once locked, `contextParse`
              // stops mattering the instant `chat.conversationId` is set).
              disabled={!selected || (!contextLocked && contextParse.error != null)}
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
                ) : railTab === "trace" ? (
                  <TraceRail source={traceSource} />
                ) : (
                  <ScratchpadRail
                    source={traceSource}
                    chatRoot={chatColRef}
                    seekKey={railSeek}
                    onSeekConsumed={clearRailSeek}
                  />
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
  /** Whether the selected agent's registration can compose a delivered
   *  instance (#268) — gates the scope editor + chip's very existence. */
  contextAvailable: boolean;
  contextEditorText: string;
  onContextEditorText: (text: string) => void;
  contextError?: string;
  /** Immutable once the conversation exists (Decision 2) — locks the editor. */
  contextLocked: boolean;
  /** The server's echoed context for the live conversation (`useChat.context`) —
   *  `null` until bound, or "(no scope)" once bound with none. Never the
   *  editor's draft text (that would defeat the chip's honesty rule). */
  boundContext: Record<string, unknown> | null;
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
  contextAvailable,
  contextEditorText,
  onContextEditorText,
  contextError,
  contextLocked,
  boundContext,
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
        {/* Scope chip (#268) — hidden entirely for hook-less agents; hidden
            while VIEWING a past session too, since replayed sessions carry no
            context (honest degradation, spec §Dashboard) and the live
            conversation's scope behind it would be the WRONG conversation's
            answer. Shown only once the live conversation is bound — before
            that there is nothing server-confirmed to show yet, not even
            "(no scope)". */}
        {contextAvailable && !viewing && conversationId && <ScopeChip context={boundContext} />}
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
        <div style={{ fontSize: T.fz.small, color: "var(--ink-2)" }}>
          <Markdown content={description} gate />
        </div>
      )}
      {loadError && (
        <div style={{ fontSize: T.fz.small, color: "var(--err)" }}>
          Failed to load agents: {loadError}
        </div>
      )}
      {chatError && (
        <div style={{ fontSize: T.fz.small, color: "var(--err)" }}>Stream error: {chatError}</div>
      )}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <CaptureCasePanel
          conversationId={conversationId}
          messages={messages}
          exchangeCount={exchangeCount}
          disabled={streaming || viewing}
        />
        {contextAvailable && !viewing && (
          <ScopeContextPanel
            editorText={contextEditorText}
            onEditorText={onContextEditorText}
            error={contextError}
            locked={contextLocked}
            boundContext={boundContext}
          />
        )}
      </div>
    </div>
  );
}

/**
 * ScopeContextPanel — the per-conversation context editor (#268), following
 * `AgentLensPage`'s delivered-instance JSON textarea pattern
 * (`pages/build/AgentLensPage.tsx:329`) and `CaptureCasePanel`'s
 * collapsed-button → bordered-panel shape (this file has two "advanced"
 * panels now; they share the same chrome on purpose). Editable until the
 * conversation exists; once `locked`, shows the ACTUAL bound context (the
 * server's echo) instead of the (possibly stale) draft — the same
 * server-is-truth rule the chip follows.
 */
function ScopeContextPanel({
  editorText,
  onEditorText,
  error,
  locked,
  boundContext,
}: {
  editorText: string;
  onEditorText: (text: string) => void;
  error?: string;
  locked: boolean;
  boundContext: Record<string, unknown> | null;
}) {
  const [expanded, setExpanded] = useState(false);

  if (!expanded) {
    return (
      <Button variant="ghost" size="sm" onClick={() => setExpanded(true)}>
        Scope context{locked ? " · locked" : ""}
      </Button>
    );
  }

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 8,
        padding: 10,
        border: "1px solid var(--line)",
        borderRadius: "var(--radius-lg)",
        background: "var(--paper)",
        maxWidth: 420,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: "var(--ink)" }}>Scope context</div>
        <Button variant="ghost" size="sm" onClick={() => setExpanded(false)}>
          Close
        </Button>
      </div>

      {locked ? (
        <>
          <div style={{ fontSize: 12, color: "var(--ink-2)" }}>
            Locked for this conversation — <b>New Chat</b> to change scope.
          </div>
          {boundContext === null ? (
            <div style={{ fontSize: 12, color: "var(--ink-3)" }}>(no scope)</div>
          ) : (
            <JsonBlock value={boundContext} maxHeight={200} />
          )}
        </>
      ) : (
        <Field label="Context (JSON)">
          <textarea
            aria-label="Scope context"
            value={editorText}
            onChange={(e) => onEditorText(e.target.value)}
            spellCheck={false}
            rows={Math.min(8, Math.max(3, editorText.split("\n").length))}
            style={{
              ...inputStyle,
              fontFamily: T.font.mono,
              fontSize: T.fz.tiny,
              lineHeight: 1.5,
              resize: "vertical",
            }}
          />
        </Field>
      )}
      {!locked && error && <div style={{ fontSize: 12, color: "var(--err)" }}>{error}</div>}
    </div>
  );
}

/**
 * ScopeChip — header chip next to the agent badge (#268): the first 1-2
 * scalar top-level context entries, full JSON on click (a `DropdownMenu`
 * popover, the `RunPickerMenu`/`SessionsMenu` precedent). `context` is always
 * the CREATE RESPONSE's echo — never the editor's draft — so the chip can
 * never describe a guess. `null` renders the honest "(no scope)" (a
 * hook-bearing agent whose effective context resolved to nothing), distinct
 * from this component simply not being rendered at all (hook-less agent, or
 * viewing a replayed session — see the call site).
 */
function ScopeChip({ context }: { context: Record<string, unknown> | null }) {
  const scalarEntries =
    context != null
      ? Object.entries(context).filter(
          ([, v]) => v === null || (typeof v !== "object" && typeof v !== "function"),
        )
      : [];
  const keyCount = context != null ? Object.keys(context).length : 0;
  const summary =
    context == null
      ? "(no scope)"
      : scalarEntries.length > 0
        ? scalarEntries
            .slice(0, 2)
            .map(([k, v]) => `${k}: ${String(v)}`)
            .join(", ")
        : keyCount > 0
          ? `${keyCount} key${keyCount === 1 ? "" : "s"}` // all-nested-object context — no scalar to preview
          : "(no scope)";

  return (
    <DropdownMenu
      align="left"
      width={280}
      trigger={({ toggle }) => (
        <button
          type="button"
          onClick={toggle}
          title="Scope this conversation executes under — click for full JSON"
          style={{
            fontFamily: T.font.mono,
            fontSize: T.fz.tiny,
            padding: "2px 8px",
            borderRadius: T.radius.pill,
            border: "1px solid var(--line)",
            background: "var(--fill)",
            color: "var(--ink-2)",
            cursor: "pointer",
          }}
        >
          scope: {summary}
        </button>
      )}
    >
      <div style={{ padding: 10 }}>
        <JsonBlock value={context ?? {}} maxHeight={240} />
      </div>
    </DropdownMenu>
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

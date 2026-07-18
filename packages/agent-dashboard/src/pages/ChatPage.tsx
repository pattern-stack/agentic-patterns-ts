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
 *   3. Trace rail — the collapsible side panel (`components/ConsoleRail.tsx`)
 *      carries tabs alongside the `Tools` tab (`components/ToolsRail.tsx`,
 *      "what it can do"): `Trace` ("what just happened"), rendered via
 *      `components/TraceRail.tsx` off either the live turn's event stream or
 *      the viewed session's linked run.
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

import { Check, ChevronDown } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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
import { type ChatExportFormat, exportChat } from "../chat/export-chat";
import type { ChatMessage } from "../chat/model";
import { storedMessagesToChat } from "../chat/stored-parts";
import "./chat-route.css";
import { type RailSeekRequest, ScratchpadRail } from "../chat/ScratchpadRail";
import { ConsoleRail } from "../components/ConsoleRail";
import { ToolsRail } from "../components/ToolsRail";
import { TraceRail, type TraceRailSource } from "../components/TraceRail";
import { Badge } from "../components/atoms/Badge";
import { Button } from "../components/atoms/Button";
import { Spinner } from "../components/atoms/Spinner";
import { DropdownMenu } from "../components/kit/DropdownMenu";
import { Field, inputStyle } from "../components/kit/Field";
import { JsonBlock } from "../components/kit/JsonBlock";
import { Segmented } from "../components/kit/Segmented";
import { useAdminData } from "../hooks/useAdminData";
import { relTime, shortId, statusTone } from "../lib/format";
import { sessionsForAgent } from "../lib/sessions";
import { T } from "../ui/tokens";

type RailTab = "tools" | "trace" | "scratchpad";
const RAIL_TAB_OPTIONS: { value: RailTab; label: string; title?: string }[] = [
  { value: "tools", label: "Tools", title: "Capabilities & tools this agent can use" },
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

export function ChatPage({
  routeAgentId,
  onSelectAgent,
}: {
  /** The agent id from the URL (`/chat/:agentId`) when mounted via ChatRoute.
   *  Absent (bare `<ChatPage />` in tests) → falls back to local selection. */
  routeAgentId?: string | null;
  /** Navigate to another agent's chat URL. Presence = "routed" mode; absent →
   *  legacy local-state selection (keeps the tests router-free). */
  onSelectAgent?: (id: string, opts?: { replace?: boolean }) => void;
} = {}) {
  // Routed mode: the URL owns the selection. Legacy mode (no `onSelectAgent`):
  // selection is local state, auto-picking the first agent.
  const routed = onSelectAgent != null;
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [maxIterations, setMaxIterations] = useState(10); // matches the runner default
  // Scope-context editor draft (#268) — `null` = untouched, so the editor
  // shows the SELECTED agent's `instantiation.defaults` until the operator
  // types. Reseeded to `null` on agent switch / New Chat (see `newChat`).
  const [contextText, setContextText] = useState<string | null>(null);
  const [railOpen, setRailOpen] = useState(true);
  const [railTab, setRailTab] = useState<RailTab>("tools");
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
        // Legacy mode auto-picks the first agent; routed mode lets the URL-sync
        // effect below own the selection (from `routeAgentId`).
        if (!routed) setSelectedId((cur) => cur ?? list[0]?.id ?? null);
      })
      .catch((err) => {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : "Failed to load agents");
      });
    return () => {
      cancelled = true;
    };
  }, [routed]);

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
  // (DISPLAY only) whenever `contextText` is untouched (`null`).
  const contextAvailable = selected?.instantiation?.available === true;
  const defaultsText = useMemo(
    () => JSON.stringify(selected?.instantiation?.defaults ?? {}, null, 2),
    [selected],
  );
  const contextEditorText = contextText ?? defaultsText;
  // `contextEditorParse` drives the VISIBLE error under the textarea and
  // Send-blocking — it re-derives on every keystroke.
  const contextEditorParse = useMemo(
    () => parseContextJson(contextEditorText),
    [contextEditorText],
  );
  // What actually gets POSTed differs: an untouched editor (`contextText ===
  // null`) is still just DISPLAYING the seeded defaults, not an operator
  // decision — posting it as an explicit `context` would pin a client-side
  // snapshot instead of letting the server resolve its own current
  // `instantiateDefaults` at bind time (the server distinguishes "no context
  // key" from "explicit context", Gate 2.5 review note 4). Only a genuine
  // edit (including a deliberate clear, which also parses to `undefined` —
  // same wire behavior, different reason) is ever sent.
  const contextToSend = contextText === null ? {} : contextEditorParse;

  const chat = useChat(selectedId, { maxIterations, context: contextToSend.value });
  // Locks the moment a create is IN FLIGHT, not just once the id lands
  // (`streaming` flips true synchronously at the top of `send()`, before the
  // `createConversation` await) — otherwise the editor visibly stays
  // "editable" during that gap while any edits are actually silently ignored
  // (the context was already captured at the `send()` call, Gate 2.5 review
  // note 8). Immutable once bound either way (Decision 2).
  const contextLocked = chat.conversationId != null || chat.streaming;
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

  // Routed mode: the URL (`routeAgentId`) is the source of truth for which agent
  // is selected. Sync it into `selectedId`; a bare/unknown `/chat` redirects to
  // the first agent (replace, so Back doesn't bounce).
  useEffect(() => {
    if (!routed || agents.length === 0) return;
    if (routeAgentId && agents.some((a) => a.id === routeAgentId)) {
      setSelectedId(routeAgentId);
    } else {
      onSelectAgent?.(agents[0]?.id ?? "", { replace: true });
    }
  }, [routed, routeAgentId, agents, onSelectAgent]);

  // Switching agents must reset the thread (useChat does NOT auto-reset on
  // agentId change — a stale conversationId would otherwise be reused for the
  // new agent). In routed mode the switch arrives via `selectedId` changing.
  // The ref-guard makes reset fire exactly on a real agent switch, so `newChat`
  // churning identity each render is harmless (the effect runs but no-ops).
  // useLayoutEffect (not useEffect) so the reset lands BEFORE paint — otherwise
  // the new agent's header renders for one frame over the old agent's thread
  // (useChat doesn't clear messages on agentId change).
  const prevSelectedRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (!routed) return;
    if (prevSelectedRef.current !== null && prevSelectedRef.current !== selectedId) {
      newChat();
    }
    prevSelectedRef.current = selectedId;
  }, [routed, selectedId, newChat]);

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
          if (routed) {
            // Navigate; the URL-sync effect selects it and the reset effect
            // clears the thread.
            onSelectAgent?.(id);
          } else {
            setSelectedId(id);
            newChat();
          }
        }}
        onNewChat={newChat}
        conversationId={chat.conversationId}
        messages={chat.messages}
        displayMessages={displayMessages}
        assistantName={selected?.name}
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
        contextError={contextEditorParse.error}
        contextLocked={contextLocked}
        boundContext={chat.context}
        boundContextRedacted={chat.contextRedacted}
      />
      <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", gap: 8 }}>
        {viewing && (
          <div style={{ fontSize: T.fz.tiny, color: "var(--mute)" }}>
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
              // actually got (#268; harmless once locked, `contextEditorParse`
              // stops mattering the instant `contextLocked` flips true).
              disabled={!selected || (!contextLocked && contextEditorParse.error != null)}
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
          <ConsoleRail
            open={railOpen}
            onToggle={() => setRailOpen((v) => !v)}
            tab={railTab}
            onTab={setRailTab}
            tabs={RAIL_TAB_OPTIONS}
          >
            {railTab === "tools" ? (
              <ToolsRail
                agentId={selectedId}
                scope={{
                  available: contextAvailable,
                  // A live conversation exists → the scope is BOUND (even if it
                  // bound to nothing); before that it's still the declared default.
                  committed: !viewing && chat.conversationId != null,
                  // A replayed session's own run scope wasn't captured — the rail
                  // shows an explicit "not recorded" state rather than guessing it
                  // from the declared defaults (which the chip/panel also hide).
                  viewing,
                  defaults: selected?.instantiation?.defaults ?? null,
                  bound: viewing ? null : chat.context,
                  redacted: viewing ? null : chat.contextRedacted,
                }}
              />
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
          </ConsoleRail>
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
  /** The messages currently ON SCREEN (live OR a replayed session) — what the
   *  Copy action serializes, distinct from `messages` (always the live turn,
   *  which CaptureCasePanel needs). */
  displayMessages: ChatMessage[];
  /** The selected agent's display name — the transcript's assistant label. */
  assistantName?: string;
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
  /** Top-level keys the server redacted out of `boundContext`, when any were
   *  (`useChat.contextRedacted`) — surfaced next to `boundContext` wherever it
   *  renders, matching `NodeInspector`'s "redacted: …" line for the same run. */
  boundContextRedacted: string[] | null;
}

function Header({
  agents,
  selectedId,
  onSelect,
  onNewChat,
  conversationId,
  messages,
  displayMessages,
  assistantName,
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
  boundContextRedacted,
}: HeaderProps) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {/* Row 1 — one compact toolbar. Occasional controls live behind the ⚙ menu
          and the redundant agent badge is gone, so the row stays short enough to
          hold the bind-time chips (scope / exchanges) without wrapping — no shift. */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          flexWrap: "wrap",
        }}
      >
        <h1 style={{ fontSize: T.fz.xl, fontWeight: 600, margin: 0 }}>Chat</h1>
        <AgentPickerMenu agents={agents} selectedId={selectedId} onSelect={onSelect} />
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
        <div style={{ flex: 1 }} />
        {/* Scope chip (#268) — hidden for hook-less agents and while VIEWING a
            replayed session (its scope would be the wrong conversation's).
            Shown only once the live conversation is bound. */}
        {contextAvailable && !viewing && conversationId && (
          <ScopeChip context={boundContext} redacted={boundContextRedacted} />
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
        <RunSettingsMenu
          maxIterations={maxIterations}
          onMaxIterations={onMaxIterations}
          density={density}
          onDensity={onDensity}
          conversationId={conversationId}
        />
      </div>
      {/* Row 2 — the agent's one-line description shares a row with the
          occasional actions (Capture / Scope editor), so neither costs its own
          row. The description truncates; hover for the full text. */}
      <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
        <div
          title={description || undefined}
          style={{
            flex: 1,
            minWidth: 0,
            fontSize: T.fz.small,
            color: "var(--ink-2)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            paddingTop: 5,
          }}
        >
          {description}
        </div>
        <CopyChatMenu
          messages={displayMessages}
          agentName={assistantName}
          conversationId={conversationId}
        />
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
            boundContextRedacted={boundContextRedacted}
          />
        )}
      </div>
      {loadError && (
        <div style={{ fontSize: T.fz.small, color: "var(--err)" }}>
          Failed to load agents: {loadError}
        </div>
      )}
      {chatError && (
        <div style={{ fontSize: T.fz.small, color: "var(--err)" }}>Stream error: {chatError}</div>
      )}
    </div>
  );
}

/**
 * AgentPickerMenu — replaces the native `<select>` agent picker (LD4): the
 * chat surface's one holdout from the kit `DropdownMenu` chrome. Trigger
 * mirrors `ThemeToggle`'s bordered "value ▾" idiom (a picker reads as a
 * select-alike, not a ghost action button) so it still looks like the
 * primary control it is.
 */
function AgentPickerMenu({
  agents,
  selectedId,
  onSelect,
}: {
  agents: AgentSummary[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const selected = agents.find((a) => a.id === selectedId) ?? null;

  return (
    <DropdownMenu
      align="left"
      width={240}
      trigger={({ open, toggle }) => (
        <button
          type="button"
          onClick={toggle}
          disabled={!agents.length}
          aria-haspopup="menu"
          aria-expanded={open}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            minWidth: 200,
            padding: "7px 9px",
            fontFamily: "inherit",
            fontSize: T.fz.md,
            color: "var(--ink)",
            background: "var(--fill)",
            border: "1px solid var(--line)",
            borderRadius: T.radius.sm,
            cursor: agents.length ? "pointer" : "not-allowed",
            opacity: agents.length ? 1 : 0.6,
          }}
        >
          <span style={{ flex: 1, textAlign: "left" }}>
            {selected ? selected.name : agents.length ? "Select agent" : "No agents registered"}
          </span>
          <ChevronDown size={12} />
        </button>
      )}
    >
      {({ close }) => (
        <>
          {agents.length === 0 && (
            <div style={{ padding: "10px 12px", fontSize: T.fz.small, color: "var(--mute)" }}>
              No agents registered
            </div>
          )}
          {agents.map((a) => {
            const active = a.id === selectedId;
            return (
              <button
                key={a.id}
                type="button"
                role="menuitemradio"
                aria-checked={active}
                onClick={() => {
                  onSelect(a.id);
                  close();
                }}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 8,
                  width: "100%",
                  padding: "8px 12px",
                  fontFamily: "inherit",
                  fontSize: T.fz.small,
                  border: "none",
                  background: active ? "var(--accent-soft)" : "transparent",
                  color: active ? "var(--accent-ink)" : "var(--ink)",
                  cursor: "pointer",
                  textAlign: "left",
                }}
              >
                {a.name}
                {active && <Check size={12} />}
              </button>
            );
          })}
        </>
      )}
    </DropdownMenu>
  );
}

/**
 * CopyChatMenu — copy the whole (live or replayed) conversation to the
 * clipboard in a chosen format: readable markdown with tools collapsed, the
 * same with each tool call's I/O, or the full structured JSON. Built on the
 * kit `DropdownMenu` (folded back in now that it has a `close` handle — this
 * used to be a hand-rolled popover for exactly that reason, see LD1) so it
 * shares chrome with every other menu and still closes itself on selection.
 */
function CopyChatMenu({
  messages,
  agentName,
  conversationId,
}: {
  messages: ChatMessage[];
  agentName?: string;
  conversationId: string | null;
}) {
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const empty = messages.length === 0;

  // Clear the "Copied ✓" timer on unmount (the Header remounts on agent switch)
  // so it never fires setState on an unmounted component.
  useEffect(
    () => () => {
      if (resetTimer.current) clearTimeout(resetTimer.current);
    },
    [],
  );

  const copy = async (format: ChatExportFormat, close: () => void) => {
    close();
    const text = exportChat(messages, format, { agentName, conversationId });
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      setCopied(false);
    }
    if (resetTimer.current) clearTimeout(resetTimer.current);
    resetTimer.current = setTimeout(() => setCopied(false), 1600);
  };

  return (
    <DropdownMenu
      align="right"
      width={236}
      trigger={({ toggle, open }) => (
        <Button
          variant="ghost"
          size="sm"
          onClick={toggle}
          disabled={empty}
          aria-haspopup="menu"
          aria-expanded={open}
          title={empty ? "Nothing to copy yet" : "Copy the conversation"}
        >
          {copied ? "Copied ✓" : "Copy ▾"}
        </Button>
      )}
    >
      {({ close }) => (
        <div role="menu" style={{ padding: 4 }}>
          <CopyChatItem
            label="Markdown · tools collapsed"
            hint="Readable transcript; tool calls as one line"
            onClick={() => copy("markdown", close)}
          />
          <CopyChatItem
            label="Markdown · with tool I/O"
            hint="Each tool call's input + output"
            onClick={() => copy("markdown-io", close)}
          />
          <CopyChatItem
            label="JSON · full"
            hint="The complete structured thread"
            onClick={() => copy("json", close)}
          />
        </div>
      )}
    </DropdownMenu>
  );
}

function CopyChatItem({
  label,
  hint,
  onClick,
}: {
  label: string;
  hint: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = "hsl(var(--hover-bg))";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = "transparent";
      }}
      style={{
        display: "block",
        width: "100%",
        textAlign: "left",
        padding: "7px 9px",
        border: "none",
        borderRadius: "var(--radius-sm)",
        background: "transparent",
        cursor: "pointer",
        color: "var(--ink)",
      }}
    >
      <div style={{ fontSize: T.fz.small, fontWeight: 500 }}>{label}</div>
      <div style={{ fontSize: T.fz.micro, color: "var(--mute)", marginTop: 1 }}>{hint}</div>
    </button>
  );
}

/**
 * RunSettingsMenu — tucks the occasional run/view controls (tool-call cap,
 * scratchpad frame density) behind one ⚙ trigger with the live conversation id,
 * so the toolbar stays compact and doesn't reflow when a conversation binds.
 */
function RunSettingsMenu({
  maxIterations,
  onMaxIterations,
  density,
  onDensity,
  conversationId,
}: {
  maxIterations: number;
  onMaxIterations: (n: number) => void;
  density: ScratchpadDensity;
  onDensity: (d: ScratchpadDensity) => void;
  conversationId: string | null;
}) {
  return (
    <DropdownMenu
      align="right"
      width={240}
      trigger={({ toggle }) => (
        <Button variant="ghost" size="sm" onClick={toggle} title="Run & view settings">
          ⚙ Settings
        </Button>
      )}
    >
      <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 14 }}>
        <label
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 5,
            fontSize: T.fz.small,
            color: "var(--ink-2)",
          }}
        >
          <span title="Cap the agent's tool-loop iterations per message.">max tool calls</span>
          <input
            type="number"
            min={1}
            max={50}
            value={maxIterations}
            onChange={(e) =>
              onMaxIterations(Math.min(50, Math.max(1, Math.trunc(Number(e.target.value)) || 1)))
            }
            style={{ ...inputStyle, width: 84, padding: "6px 8px" }}
          />
        </label>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 5,
            fontSize: T.fz.small,
            color: "var(--ink-2)",
          }}
        >
          <span title="How many scratchpad state frames render in the timeline — what the run carries between stages, not user memory.">
            scratchpad frames
          </span>
          <Segmented
            options={DENSITY_OPTIONS}
            value={density}
            onChange={onDensity}
            size="sm"
            aria-label="Scratchpad frame density"
          />
        </div>
        {conversationId && (
          <div
            style={{
              fontSize: T.fz.micro,
              color: "var(--ink-3)",
              borderTop: "1px solid var(--line)",
              paddingTop: 9,
            }}
          >
            conversation {conversationId.slice(0, 8)}
          </div>
        )}
      </div>
    </DropdownMenu>
  );
}

/**
 * ScopeContextPanel — the per-conversation context editor (#268), following
 * `AgentLensPage`'s delivered-instance JSON textarea pattern
 * (`pages/build/AgentLensPage.tsx:329`). playground-menus round 1 (LD2):
 * used to be an inline expand — a collapsed button that swapped into a
 * bordered `div` in the header flow, pushing siblings. Now a kit
 * `DropdownMenu` popover, so opening it never reflows the page. Editable
 * until the conversation exists; once `locked`, shows the ACTUAL bound
 * context (the server's echo) instead of the (possibly stale) draft — the
 * same server-is-truth rule the chip follows.
 */
function ScopeContextPanel({
  editorText,
  onEditorText,
  error,
  locked,
  boundContext,
  boundContextRedacted,
}: {
  editorText: string;
  onEditorText: (text: string) => void;
  error?: string;
  locked: boolean;
  boundContext: Record<string, unknown> | null;
  boundContextRedacted: string[] | null;
}) {
  // Send is already blocked on this (ChatPage's `disabled` prop) — the
  // trigger needs its OWN visible cause, or a greyed-out Send with no
  // explanation is the only signal the operator ever sees (Gate 2.5 review
  // note 3).
  const showsInvalid = !locked && error != null;

  return (
    <DropdownMenu
      align="right"
      width={380}
      maxHeight={420}
      trigger={({ toggle, open }) => (
        <Button
          variant="ghost"
          size="sm"
          onClick={toggle}
          aria-expanded={open}
          style={showsInvalid ? { color: "var(--err)" } : undefined}
        >
          Scope context{locked ? " · locked" : showsInvalid ? " · invalid" : ""}
        </Button>
      )}
    >
      {({ close }) => (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: 10 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: "var(--ink)" }}>Scope context</div>
            <Button variant="ghost" size="sm" onClick={close}>
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
                <>
                  <JsonBlock value={boundContext} maxHeight={200} />
                  {boundContextRedacted && boundContextRedacted.length > 0 && (
                    <div style={{ fontSize: T.fz.micro, color: T.tone.warn.ink }}>
                      redacted: {boundContextRedacted.join(", ")}
                    </div>
                  )}
                </>
              )}
            </>
          ) : (
            <>
              <div style={{ fontSize: 12, color: "var(--ink-2)", lineHeight: 1.45 }}>
                Who this conversation acts on behalf of — edit the JSON, then send. The scope binds
                on the first message; <b>New Chat</b> to run as someone else.
              </div>
              <Field label="Context (JSON)">
                <textarea
                  aria-label="Scope context"
                  value={editorText}
                  onChange={(e) => onEditorText(e.target.value)}
                  spellCheck={false}
                  rows={Math.min(8, Math.max(3, editorText.split("\n").length))}
                  style={{
                    ...inputStyle,
                    background: "var(--paper)",
                    fontFamily: T.font.mono,
                    fontSize: T.fz.tiny,
                    lineHeight: 1.5,
                    resize: "vertical",
                  }}
                />
              </Field>
            </>
          )}
          {showsInvalid && <div style={{ fontSize: 12, color: "var(--err)" }}>{error}</div>}
        </div>
      )}
    </DropdownMenu>
  );
}

/** Cap a chip-preview value so one long token/URL can't distort the header's
 *  wrapping row (Gate 2.5 review note 2) — the full value is always still one
 *  click away in the popover. */
const CHIP_VALUE_MAX = 24;
function truncateChipValue(v: unknown): string {
  const s = String(v);
  return s.length > CHIP_VALUE_MAX ? `${s.slice(0, CHIP_VALUE_MAX)}…` : s;
}

/** Shared chip-pill visual (both the interactive and the non-interactive
 *  "(no scope)" cases render this same shape — see `ScopeChip` below). */
const CHIP_STYLE = {
  fontSize: T.fz.tiny,
  padding: "2px 8px",
  borderRadius: T.radius.pill,
  border: "1px solid var(--line)",
  background: "var(--fill)",
  color: "var(--ink-2)",
  maxWidth: 260,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
} as const;

/**
 * ScopeChip — header chip next to the agent badge (#268): the first 1-2
 * scalar top-level context entries (each value capped, see
 * `truncateChipValue`), a "+N" tail when more keys exist than shown, full
 * JSON on click (a `DropdownMenu` popover, the `RunPickerMenu`/`SessionsMenu`
 * precedent). `context` is always the CREATE RESPONSE's echo — never the
 * editor's draft — so the chip can never describe a guess. `null` renders the
 * honest "(no scope)" (a hook-bearing agent whose effective context resolved
 * to nothing) as a plain, NON-interactive pill — there is no JSON behind it
 * worth a popover — distinct from this component simply not being rendered
 * at all (hook-less agent, or viewing a replayed session — see the call
 * site).
 */
function ScopeChip({
  context,
  redacted,
}: {
  context: Record<string, unknown> | null;
  redacted: string[] | null;
}) {
  if (context == null) {
    return (
      <span style={CHIP_STYLE} title="This agent's effective context resolved to nothing">
        scope: (no scope)
      </span>
    );
  }

  const scalarEntries = Object.entries(context).filter(
    ([, v]) => v === null || (typeof v !== "object" && typeof v !== "function"),
  );
  const keyCount = Object.keys(context).length;
  const shown = scalarEntries.slice(0, 2);
  const shownText =
    shown.length > 0
      ? shown.map(([k, v]) => `${k}: ${truncateChipValue(v)}`).join(", ")
      : keyCount > 0
        ? `${keyCount} key${keyCount === 1 ? "" : "s"}` // all-nested-object context — no scalar to preview
        : "(no scope)"; // context is a non-null but empty object
  // Only the scalar-preview branch can under-report — the "N keys" fallback
  // already counts every key, so it never needs a tail.
  const remaining = shown.length > 0 ? keyCount - shown.length : 0;
  const summary = remaining > 0 ? `${shownText} +${remaining}` : shownText;

  return (
    <DropdownMenu
      align="left"
      width={280}
      trigger={({ toggle }) => (
        <button
          type="button"
          onClick={toggle}
          title="Scope this conversation executes under — click for full JSON"
          style={{ ...CHIP_STYLE, cursor: "pointer" }}
        >
          scope: {summary}
        </button>
      )}
    >
      <div style={{ padding: 10 }}>
        <JsonBlock value={context} maxHeight={240} />
        {redacted && redacted.length > 0 && (
          <div style={{ fontSize: T.fz.micro, color: T.tone.warn.ink, marginTop: 6 }}>
            redacted: {redacted.join(", ")}
          </div>
        )}
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
              fontSize: T.fz.small,
              color: "var(--ink-2)",
            }}
          >
            {shortId(s.conversationId)}
            <Badge tone="mute">
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

/**
 * Chat HTTP client — conversation lifecycle + streaming message send.
 *
 * EventSource cannot be used because the server's message endpoint is
 * POST. Instead we use fetch's ReadableStream body, decode as text, and
 * parse the standard SSE frame format (`event: X\ndata: Y\n\n`) ourselves.
 */

import type { WireFrame } from "./sse-events";

export interface AgentSummary {
  id: string;
  name: string;
  description: string;
  /**
   * Delivered-instance capability (#268, widened #308) — same sub-shape `GET
   * /agents/:id/composition` carries (`api/composition.ts`'s
   * `AgentComposition.instantiation`), mirrored onto the roster summary so the
   * chat surface can seed a per-conversation scope editor without an extra
   * round trip. Absent on older servers — treat as unavailable.
   *
   * `schema`/`presets` (#308) are OPTIONAL and additive: an older server that
   * only ever spoke #268 sends `available`/`defaults` alone, and the chat
   * surface falls back to the raw JSON textarea editor exactly as before —
   * including posting under the same `context` wire key that editor always
   * used (see `createConversation`), so the fallback really is byte-identical
   * against a pre-#308 server, not just visually.
   */
  instantiation?: {
    available: boolean;
    defaults: Record<string, unknown> | null;
    /** JSON-schema of the declared scope, when the registration has one
     *  (`SessionScope.toJsonSchema()`) — folds into the typed scope form
     *  (`lib/toolParams.ts` `foldToolParams`). `null`/absent → no typed form,
     *  the JSON textarea is the only editor. */
    schema?: Record<string, unknown> | null;
    /** Named preset value objects declared on the scope, when any exist —
     *  picking one seeds every row of the typed form (materialized
     *  CLIENT-side; the preset name itself is never sent to the server). */
    presets?: Record<string, Record<string, unknown>> | null;
  };
}

export interface ConversationCreated {
  id: string;
  agent_id: string;
  /**
   * The redacted effective context this conversation was bound with (#268) —
   * the server's word, never the editor's draft text. Key OMITTED
   * (`undefined`) for a hook-less registration; `null` for a hook-bearing one
   * with no explicit context and no declared defaults; otherwise the
   * (possibly redacted) object `instantiate` actually received.
   */
  context?: Record<string, unknown> | null;
  /** Top-level context keys the server redacted, when any were (#268). */
  context_redacted?: string[];
}

/** List the agents registered on the server. */
export async function listAgents(): Promise<AgentSummary[]> {
  const res = await fetch("/agents");
  if (!res.ok) throw new Error(`GET /agents failed: ${res.status} ${res.statusText}`);
  return res.json() as Promise<AgentSummary[]>;
}

export interface CapabilityTool {
  name: string;
  description: string;
  /** JSON-schema of the tool's input params (the same shape the Capabilities
   *  page folds) — rendered inline in the Tools rail. Absent on older servers. */
  parameters?: Record<string, unknown>;
}
export interface AgentCapability {
  name: string;
  /** The capability's overarching "what this is" summary (server falls back to
   *  the toolbox description). May be "" on older servers — treat as absent. */
  description?: string;
  toolbox?: string;
  tools: CapabilityTool[];
  plays: string[];
}
export interface AgentComposition {
  id: string;
  name: string;
  description: string;
  model?: string;
  capabilities: AgentCapability[];
}

/** The agent's declared composition — what it CAN do (capabilities → tools/plays). */
export async function fetchAgentCapabilities(agentId: string): Promise<AgentComposition> {
  const res = await fetch(`/agents/${encodeURIComponent(agentId)}/capabilities`);
  if (!res.ok) throw new Error(`GET /agents/${agentId}/capabilities failed: ${res.status}`);
  return res.json() as Promise<AgentComposition>;
}

/** A provenance chip on a role slot: which tier authored it + its source file. */
export interface SlotProvenance {
  tier?: string;
  sourcePath?: string;
}
/** The subset of GET /agents/:id/composition the inspector's Provenance tab reads:
 *  the real per-slot provenance the server attaches to each role slot. */
export interface AgentCompositionDetail {
  role?: {
    persona?: { provenance?: SlotProvenance };
    capabilities?: { name: string; provenance?: SlotProvenance }[];
  };
}

/** Full two-tier introspection incl. per-slot provenance (Role × Mission origin). */
export async function fetchAgentComposition(agentId: string): Promise<AgentCompositionDetail> {
  const res = await fetch(`/agents/${encodeURIComponent(agentId)}/composition`);
  if (!res.ok) throw new Error(`GET /agents/${agentId}/composition failed: ${res.status}`);
  return res.json() as Promise<AgentCompositionDetail>;
}

/**
 * Answer a human-in-the-loop `input.request` — the return leg that unblocks a
 * run stalled on an approval gate (or a tool asking the user to pick / type).
 * `correlationId` echoes the request; a bare-deny or approve/value is posted to
 * `POST /conversations/:id/input`.
 */
export async function sendInputResponse(
  conversationId: string,
  correlationId: string,
  answer: { decision: "approve" | "deny"; value?: string },
): Promise<void> {
  const res = await fetch(`/conversations/${encodeURIComponent(conversationId)}/input`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      correlation_id: correlationId,
      decision: answer.decision,
      ...(answer.value !== undefined ? { value: answer.value } : {}),
    }),
  });
  if (!res.ok) {
    throw new Error(
      `POST /conversations/${conversationId}/input failed: ${res.status} ${res.statusText}`,
    );
  }
}

/** One zod issue from a failed `scope.parse` (#308) — duck-typed the same
 *  way the server detects them (decisions.md D3): `path`/`message` are the
 *  only fields the typed scope form reads (`path[0]` matches a row name). */
export interface ScopeValidationIssue {
  path: Array<string | number>;
  message: string;
}

/**
 * Thrown by `createConversation` when the server's 400 body carries
 * `issues` (`{error: "scope validation failed", issues: [...]}, D3) instead
 * of a bare `{error}` string — lets callers (the typed scope form) map each
 * issue back onto the row that produced it, rather than only showing a flat
 * error string.
 */
export class ScopeValidationError extends Error {
  readonly issues: ScopeValidationIssue[];
  constructor(message: string, issues: ScopeValidationIssue[]) {
    super(message);
    this.name = "ScopeValidationError";
    this.issues = issues;
  }
}

/**
 * Create a new conversation with a given agent. `scope` is posted only when
 * provided (#268) — omitting it entirely for a hook-less agent, or when the
 * caller has no draft, keeps the request byte-identical to pre-#268 behavior.
 * Posted under the `context` body key. The #308 server also accepts a
 * `scope` key (aliased to `context`, decisions.md D5/D10), but a dashboard
 * build is deployed independently of the server it talks to — a published
 * pre-#308 server reads ONLY `context` and would silently ignore an unknown
 * `scope` key (201, no error, operator's edit discarded). Sending `context`
 * keeps every server generation, old and new, actually bound to the value
 * the operator typed. Surfaces the server's `{error}` body on failure (the
 * `compositionApi.deliveredComposition` precedent) so a bad scope object or a
 * rejecting `instantiate` hook reads as its actual reason, not just an HTTP
 * status; a `scope.parse` 400 (carrying `issues`) throws a
 * `ScopeValidationError` instead of the plain `Error` so per-field mapping is
 * possible upstream.
 */
export async function createConversation(
  agentId: string,
  scope?: Record<string, unknown>,
): Promise<ConversationCreated> {
  const res = await fetch("/conversations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(
      scope !== undefined ? { agent_id: agentId, context: scope } : { agent_id: agentId },
    ),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      error?: string;
      issues?: ScopeValidationIssue[];
    } | null;
    if (body && Array.isArray(body.issues)) {
      throw new ScopeValidationError(body.error ?? "scope validation failed", body.issues);
    }
    throw new Error(body?.error ?? `POST /conversations failed: ${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<ConversationCreated>;
}

/**
 * Send a message and stream the response as typed ClientEvents.
 *
 * Yields events as they arrive. The server always emits a `done` event
 * when streaming completes; the generator returns after that frame.
 * Aborting the passed-in AbortSignal terminates the fetch and stops the
 * generator.
 */
export interface SendOptions {
  /** Per-message cap on the agent tool-loop (server clamps 1–50). Omit → server default. */
  maxIterations?: number;
}

export async function* streamMessage(
  conversationId: string,
  content: string,
  opts?: SendOptions,
  signal?: AbortSignal,
): AsyncGenerator<WireFrame, void, void> {
  const res = await fetch(`/conversations/${encodeURIComponent(conversationId)}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      content,
      ...(opts?.maxIterations != null ? { maxIterations: opts.maxIterations } : {}),
    }),
    signal,
  });

  if (!res.ok || !res.body) {
    const detail = !res.ok ? `${res.status} ${res.statusText}` : "empty response body";
    throw new Error(`POST /conversations/${conversationId}/messages failed: ${detail}`);
  }

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += value;

      // SSE frames are separated by blank lines — either "\n\n" or "\r\n\r\n".
      let idx = findFrameBoundary(buffer);
      while (idx !== -1) {
        const frame = buffer.slice(0, idx.start);
        buffer = buffer.slice(idx.end);
        const event = parseFrame(frame);
        if (event) {
          yield event;
          if (event.name === "done") return;
        }
        idx = findFrameBoundary(buffer);
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// Frame parser — handles one `event: X\ndata: {json}` block
// ---------------------------------------------------------------------------

interface FrameBoundary {
  start: number;
  end: number;
}

function findFrameBoundary(buffer: string): FrameBoundary | -1 {
  const lf = buffer.indexOf("\n\n");
  const crlf = buffer.indexOf("\r\n\r\n");
  if (lf === -1 && crlf === -1) return -1;
  if (lf === -1) return { start: crlf, end: crlf + 4 };
  if (crlf === -1) return { start: lf, end: lf + 2 };
  return lf < crlf ? { start: lf, end: lf + 2 } : { start: crlf, end: crlf + 4 };
}

function parseFrame(frame: string): WireFrame | null {
  let eventName: string | null = null;
  let dataJson = "";
  for (const rawLine of frame.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const field = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trimStart();
    if (field === "event") eventName = value;
    else if (field === "data") dataJson += (dataJson ? "\n" : "") + value;
  }
  // Drop only MALFORMED frames (no event name / unparseable data) — NEVER by
  // event name. The reducer (chat/model.applyParts) decides what renders; a
  // name allowlist here silently ate `agent.step.*`. See WireFrame in sse-events.ts.
  if (!eventName) return null;
  try {
    const data = dataJson ? JSON.parse(dataJson) : {};
    const obj =
      data && typeof data === "object" && !Array.isArray(data)
        ? (data as Record<string, unknown>)
        : {};
    return { name: eventName, data: obj };
  } catch {
    return null;
  }
}

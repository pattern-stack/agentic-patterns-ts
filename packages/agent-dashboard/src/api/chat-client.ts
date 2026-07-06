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
}

export interface ConversationCreated {
  id: string;
  agent_id: string;
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
}
export interface AgentCapability {
  name: string;
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

/** Create a new conversation with a given agent. */
export async function createConversation(agentId: string): Promise<ConversationCreated> {
  const res = await fetch("/conversations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agent_id: agentId }),
  });
  if (!res.ok) throw new Error(`POST /conversations failed: ${res.status} ${res.statusText}`);
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
    const obj = data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
    return { name: eventName, data: obj };
  } catch {
    return null;
  }
}

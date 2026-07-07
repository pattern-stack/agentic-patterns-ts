/**
 * Typed client for the composition introspection routes (agent-server
 * `routes/composition.ts`) — the read-only spine behind the Playground's three
 * BUILD doors: Roles (identities), Agents (situated instances), Capabilities
 * (substrate). Shapes mirror the server payloads exactly.
 */

import { fetchJSON } from "./client";

// --------------------------------------------------------------------------
// Shared slot shapes
// --------------------------------------------------------------------------

/** Provenance tier for a slot — where it came from (docs/playground-redesign.md §5). */
export type ProvenanceTier = "preset" | "preset?" | "library" | "local" | "inline";

export interface ProvenanceChip {
  tier: string;
  sourcePath?: string;
}

export interface PromptSection {
  name: string;
  source: "role" | "instance" | "unknown";
  text: string;
}

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  returns?: Record<string, unknown>;
}

export interface CapabilityBlock {
  id?: string;
  name: string;
  description: string;
  provenance?: ProvenanceChip;
  toolbox: { name: string; description: string; tools: ToolDef[] };
  manual: { text: string } | null;
  playbook: { plays: string[] } | null;
  usedBy?: UsedBy;
  sharesToolboxWith?: string[];
}

export interface Slot {
  name: string;
  text: string;
  provenance?: ProvenanceChip;
}

export interface UsedBy {
  roles: string[];
  agents: string[];
}

export interface CoherenceWarning {
  kind: "domain-unreachable" | "capability-undescribed";
  subject: string;
  detail: string;
}

// --------------------------------------------------------------------------
// Agent composition (the lens)
// --------------------------------------------------------------------------

export interface AgentComposition {
  id: string;
  name: string;
  description: string;
  model?: string;
  role: {
    name: string;
    defaultModel: string;
    persona: Slot;
    judgments: Slot[];
    responsibilities: Slot[];
    capabilities: CapabilityBlock[];
  };
  instance: {
    background: Record<string, unknown> | null;
    awareness: Record<string, unknown> | null;
    mission: Record<string, unknown> | null;
    modelOverride: string | null;
  };
  prompt: { renderPath: "sections" | "joined"; sections: PromptSection[] };
  coherence: { heuristic: boolean; warnings: CoherenceWarning[] };
  /** Whether the registration can compose its DELIVERED instance (and the seed context). */
  instantiation?: { available: boolean; defaults: Record<string, unknown> | null };
  /** Declared eval↔agent mapping: the eval sets that grade this agent (or a step of it). */
  evals?: AgentEvalRef[];
}

/** One declared grading link (registration-declared; mirrors server config.ts). */
export interface AgentEvalRef {
  setId: string;
  grades?: string;
  step?: string;
  scorer?: string;
}

/** The delivered-instance payload — the same composition, composed live via the
 *  registration's `instantiate(context)` hook (POST …/composition/delivered). */
export interface DeliveredComposition extends AgentComposition {
  delivered: true;
  /** The context `instantiate` actually received (explicit, else the defaults). */
  context: Record<string, unknown> | null;
}

// --------------------------------------------------------------------------
// Roles (identity catalog)
// --------------------------------------------------------------------------

export interface RoleAgentRef {
  id: string;
  name: string;
}

export interface RoleSummary {
  id: string;
  name: string;
  defaultModel: string;
  similarTo: string[];
  agents: RoleAgentRef[];
}

/** One agent row of the instantiation matrix. */
export interface RoleInstance {
  id: string;
  name: string;
  model?: string;
  background: Record<string, unknown> | null;
  awareness: Record<string, unknown> | null;
  mission: Record<string, unknown> | null;
}

export interface SlotEdges {
  usedBy: UsedBy;
  similar: { roleId: string; name: string }[];
}

export interface RoleDetail extends RoleSummary {
  persona: Slot;
  judgments: (Slot & SlotEdges)[];
  responsibilities: (Slot & SlotEdges)[];
  capabilities: CapabilityBlock[];
  agents: RoleInstance[];
}

// --------------------------------------------------------------------------
// Capabilities (substrate catalog)
// --------------------------------------------------------------------------

export interface CapabilitySummary {
  id: string;
  name: string;
  description: string;
  toolbox: { name: string; description: string; toolCount: number };
  usedBy: UsedBy;
  sharesToolboxWith: string[];
}

export type CapabilityDetail = CapabilityBlock & {
  id: string;
  usedBy: UsedBy;
  sharesToolboxWith: string[];
};

/** Uniform envelope `POST /capabilities/:id/tools/:tool/invoke` returns (S3,
 *  port-map §2.2) — mirrors the server response shape exactly. */
export interface ToolRunResult {
  ok: boolean;
  result?: unknown;
  error?: string;
  /** server-side execution time in ms (excludes network). */
  ms: number;
}

// --------------------------------------------------------------------------
// Client methods
// --------------------------------------------------------------------------

/** GET /agents roster row (§6): instance list with role ref + readiness. */
export interface RosterAgent {
  id: string;
  name: string;
  description: string;
  role: { id: string; name: string } | null;
  readiness: { ready: boolean; missing: string[] };
}

export const compositionApi = {
  agentComposition: (id: string) =>
    fetchJSON<AgentComposition>(`/agents/${encodeURIComponent(id)}/composition`),
  /** POST the context and compose the delivered instance. Unlike fetchJSON, this
   *  surfaces the server's `{error}` body — an instantiate failure (dead tenant
   *  DB, bad context) carries its reason, not just "HTTP 502". */
  deliveredComposition: async (id: string, context?: Record<string, unknown>) => {
    const response = await fetch(`/agents/${encodeURIComponent(id)}/composition/delivered`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(context === undefined ? {} : { context }),
    });
    const body = (await response.json().catch(() => null)) as
      | (DeliveredComposition & { error?: string })
      | null;
    if (!response.ok) {
      throw new Error(body?.error ?? `HTTP ${response.status}: ${response.statusText}`);
    }
    if (!body) throw new Error("Empty delivered-composition response");
    return body as DeliveredComposition;
  },
  roles: () => fetchJSON<RoleSummary[]>("/roles"),
  role: (id: string) => fetchJSON<RoleDetail>(`/roles/${encodeURIComponent(id)}`),
  capabilities: () => fetchJSON<CapabilitySummary[]>("/capabilities"),
  capability: (id: string) =>
    fetchJSON<CapabilityDetail>(`/capabilities/${encodeURIComponent(id)}`),
  /** Direct tool invoke (S3, Tool Workbench) — bypasses the agent loop and the
   *  model entirely: the server calls `toolbox.execute()` straight. A 404
   *  (unknown capability/tool — a wiring error, never a normal outcome) is
   *  folded into the same `ToolRunResult` envelope as a failed run instead of
   *  throwing, matching swe-brain's `run-tool.ts` semantics. */
  invokeTool: async (
    capId: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<ToolRunResult> => {
    // `fetch` itself can REJECT (server down, network drop, CORS failure) —
    // distinct from a resolved-but-non-2xx Response (handled below). Without
    // this try/catch, that rejection propagated out of the async function
    // as an unhandled promise rejection: `ToolRunner.run()`'s bare
    // `try { setResult(await …) } finally { … }` has no `catch`, so no error
    // ever reached `result` — the button silently re-enabled with no error
    // box. Folding it into the same envelope here fixes every caller at the
    // one seam, matching the non-2xx branch's existing behavior.
    try {
      const response = await fetch(
        `/capabilities/${encodeURIComponent(capId)}/tools/${encodeURIComponent(toolName)}/invoke`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ args }),
        },
      );
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        return {
          ok: false,
          error: body?.error ?? `HTTP ${response.status}: ${response.statusText}`,
          ms: 0,
        };
      }
      return (await response.json()) as ToolRunResult;
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e), ms: 0 };
    }
  },
};

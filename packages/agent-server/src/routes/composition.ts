/**
 * Composition introspection routes — the data spine of the playground's
 * three BUILD doors (docs/playground-redesign.md §3, §6).
 *
 * - GET /agents/:id/composition — full two-tier introspection of one agent:
 *   role slots, instantiation delta, provenance, rendered prompt sections,
 *   coherence-check results.
 * - GET /roles + /roles/:id — identity catalog, derived by grouping
 *   registrations by role reference identity (never merged structurally).
 * - GET /capabilities + /capabilities/:id — capability-keyed substrate
 *   catalog with used-by edges and JSON-schema tool definitions.
 *
 * All routes are read-only and token-free. Like agents.ts, everything reads
 * the live registrations through structural duck-typing — core classes are
 * never imported, so any AgentLike introspects safely.
 */

import { Hono } from "hono";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { AgentRegistration } from "../config.js";

/* ------------------------------------------------------------------------ */
/* Structural views (duck-typed — never import core classes)                 */
/* ------------------------------------------------------------------------ */

interface ToolSchemaLike {
  name?: string;
  description?: string;
  parameters?: Record<string, unknown>;
  returns?: Record<string, unknown>;
}
interface ToolboxLike {
  name?: string;
  description?: string;
  tools?: Record<string, unknown>;
  getToolSchemas?: () => ToolSchemaLike[];
}
interface ManualLike {
  toPrompt?: () => string;
}
interface PlaybookLike {
  plays?: Record<string, unknown>;
}
interface CapabilityLike {
  name?: string;
  description?: string;
  toolbox?: ToolboxLike;
  manual?: ManualLike;
  playbook?: PlaybookLike;
}
/* Judgments/responsibilities: judgments key on `domain` (their schema has no
 * name field) while responsibilities key on `name` — read both, name first. */
interface SlotLike {
  data?: { name?: string; domain?: string };
  toPrompt?: () => string;
}
interface PersonaLike {
  toPrompt?: () => string;
}
interface RoleLike {
  name?: string;
  defaultModel?: string;
  persona?: PersonaLike;
  judgments?: ReadonlyArray<SlotLike>;
  responsibilities?: ReadonlyArray<SlotLike>;
  capabilities?: ReadonlyArray<CapabilityLike>;
}
interface AgentIntrospect {
  role?: RoleLike;
  background?: { data?: unknown };
  awareness?: { data?: { domains?: ReadonlyArray<AwarenessDomainLike> } };
  mission?: { data?: unknown };
  data?: { model?: string | null };
  getModel?: () => string;
  renderSections?: () => Array<{ name: string; source: "role" | "instance"; text: string }>;
  renderInitialPrompt?: () => string;
}
interface AwarenessDomainLike {
  name?: string;
  description?: string;
  // Accept both schema spellings so introspection is agnostic to the atom's
  // field casing (snake_case `access_method` and camelCase `accessMethod`).
  accessMethod?: string;
  access_method?: string;
}

interface ProvenanceChip {
  tier: string;
  sourcePath?: string;
}
interface CoherenceWarning {
  kind: "domain-unreachable" | "capability-undescribed";
  subject: string;
  detail: string;
}

/* ------------------------------------------------------------------------ */
/* Helpers                                                                   */
/* ------------------------------------------------------------------------ */

/** Lowercase and strip everything but [a-z0-9] — the matching normal form. */
function slugNorm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** URL-safe slug: lowercase, non-alphanumerics collapsed to single dashes. */
function slugId(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "unnamed"
  );
}

/** Slug-normalized substring match, either direction. Empty slugs never match. */
function mentions(a: string, b: string): boolean {
  const sa = slugNorm(a);
  const sb = slugNorm(b);
  if (sa === "" || sb === "") return false;
  return sa.includes(sb) || sb.includes(sa);
}

function slotName(slot: SlotLike): string {
  return slot.data?.name ?? slot.data?.domain ?? "unnamed";
}

/**
 * Join a provenance chip from the registration blob by slotType + index (the
 * slot's array position). A name join is only a fallback for blobs from older
 * CLIs that lack `index` — names may collide (a preset judgment and a modified
 * fork in the same domain), and a name join would render the fork with the
 * true preset's confident chip, exactly the confident-but-wrong chip §5
 * forbids.
 */
function provenanceFor(
  reg: AgentRegistration,
  slotType: string,
  index: number,
  name: string,
): ProvenanceChip | undefined {
  const slots = reg.provenance?.slots ?? [];
  const slot =
    slots.find((s) => s.slotType === slotType && s.index === index) ??
    slots.find((s) => s.slotType === slotType && s.index === undefined && s.name === name);
  if (!slot) return undefined;
  return { tier: slot.tier, ...(slot.sourcePath ? { sourcePath: slot.sourcePath } : {}) };
}

function toolSchemasOf(toolbox: ToolboxLike | undefined): ToolSchemaLike[] {
  if (typeof toolbox?.getToolSchemas === "function") return toolbox.getToolSchemas();
  return [];
}

/** Serialize one capability slot — toolbox tools carry JSON-schema params. */
function capabilityBlock(cap: CapabilityLike, provenance?: ProvenanceChip) {
  return {
    name: cap.name ?? "capability",
    description: cap.description ?? "",
    ...(provenance ? { provenance } : {}),
    toolbox: {
      name: cap.toolbox?.name ?? "",
      description: cap.toolbox?.description ?? "",
      tools: toolSchemasOf(cap.toolbox).map((t) => ({
        name: t.name ?? "",
        description: t.description ?? "",
        parameters: t.parameters ?? {},
        ...(t.returns !== undefined ? { returns: t.returns } : {}),
      })),
    },
    manual: typeof cap.manual?.toPrompt === "function" ? { text: cap.manual.toPrompt() } : null,
    playbook: cap.playbook ? { plays: Object.keys(cap.playbook.plays ?? {}) } : null,
  };
}

/** Serialize the full role slot stack, joining provenance from `reg`. */
function roleSlots(role: RoleLike, reg?: AgentRegistration) {
  const prov = (slotType: string, index: number, name: string) =>
    reg ? provenanceFor(reg, slotType, index, name) : undefined;
  // The persona blob entry is keyed by the ROLE's name (it has no name of its
  // own — see the CLI's matchNameOf), at index 0.
  const personaProvenance = prov("persona", 0, role.name ?? "persona");
  return {
    persona: {
      text: role.persona?.toPrompt?.() ?? "",
      ...(personaProvenance ? { provenance: personaProvenance } : {}),
    },
    judgments: (role.judgments ?? []).map((j, i) => {
      const name = slotName(j);
      const provenance = prov("judgment", i, name);
      return { name, text: j.toPrompt?.() ?? "", ...(provenance ? { provenance } : {}) };
    }),
    responsibilities: (role.responsibilities ?? []).map((r, i) => {
      const name = slotName(r);
      const provenance = prov("responsibility", i, name);
      return { name, text: r.toPrompt?.() ?? "", ...(provenance ? { provenance } : {}) };
    }),
    capabilities: (role.capabilities ?? []).map((cap, i) =>
      capabilityBlock(cap, prov("capability", i, cap.name ?? "capability")),
    ),
  };
}

/**
 * Sanitize an instance mission for JSON transport. `outputSchema` may be a
 * LIVE Zod schema (core's documented usage) — serialized verbatim it leaks
 * the raw `_def` internals while dropping the functions, a bloated blob no
 * client can reconstruct. Zod schemas are converted to their JSON-schema
 * form; anything else JSON-serializes as-is.
 */
function sanitizeMission(mission: unknown): unknown {
  if (!mission || typeof mission !== "object") return mission ?? null;
  const m = mission as Record<string, unknown>;
  const schema = m.outputSchema;
  const isZodLike =
    !!schema &&
    typeof schema === "object" &&
    "_def" in schema &&
    typeof (schema as { parse?: unknown }).parse === "function";
  if (!isZodLike) return m;
  try {
    // biome-ignore lint/suspicious/noExplicitAny: duck-typed Zod schema from user code
    return { ...m, outputSchema: zodToJsonSchema(schema as any) };
  } catch {
    const { outputSchema: _dropped, ...rest } = m;
    return rest;
  }
}

/* ------------------------------------------------------------------------ */
/* Coherence check (v1 heuristic, per §3)                                    */
/* ------------------------------------------------------------------------ */

/**
 * Cross-reference awareness domains against capability/toolbox/tool names.
 *
 * - A domain no capability name reaches → `domain-unreachable`.
 * - A capability no domain describes (only when domains exist) →
 *   `capability-undescribed`.
 *
 * Agents with zero domains produce zero warnings — nothing to drift from.
 */
function coherenceWarnings(agent: AgentIntrospect): CoherenceWarning[] {
  const domains = agent.awareness?.data?.domains ?? [];
  if (domains.length === 0) return [];

  // Name sets per capability: the capability's own name, its toolbox name,
  // and every tool name — any of these "reaching" a domain counts.
  const capabilities = (agent.role?.capabilities ?? []).map((cap) => {
    const names = [cap.name ?? "", cap.toolbox?.name ?? ""];
    for (const t of toolSchemasOf(cap.toolbox)) names.push(t.name ?? "");
    return { name: cap.name ?? "capability", names: names.filter((n) => n !== "") };
  });

  const domainText = (d: AwarenessDomainLike): string[] =>
    [d.name ?? "", d.description ?? "", d.accessMethod ?? d.access_method ?? ""].filter(
      (t) => t !== "",
    );

  const warnings: CoherenceWarning[] = [];

  for (const domain of domains) {
    const covered = capabilities.some((cap) =>
      cap.names.some((n) => domainText(domain).some((t) => mentions(t, n))),
    );
    if (!covered) {
      warnings.push({
        kind: "domain-unreachable",
        subject: domain.name ?? "unnamed",
        detail: `No capability, toolbox, or tool name matches awareness domain "${
          domain.name ?? "unnamed"
        }" — the agent is told about a source no tool reaches.`,
      });
    }
  }

  for (const cap of capabilities) {
    const described = domains.some((domain) =>
      cap.names.some((n) => domainText(domain).some((t) => mentions(t, n))),
    );
    if (!described) {
      warnings.push({
        kind: "capability-undescribed",
        subject: cap.name,
        detail: `No awareness domain mentions capability "${cap.name}" (or its toolbox/tools) — the agent has tools its awareness never describes.`,
      });
    }
  }

  return warnings;
}

/* ------------------------------------------------------------------------ */
/* Role catalog (grouped by reference identity — never merged structurally)  */
/* ------------------------------------------------------------------------ */

export interface RoleEntry {
  id: string;
  role: RoleLike;
  members: AgentRegistration[];
  structuralKey: string;
  similarTo: string[];
}

/** Structural fingerprint: name + persona text + judgment + capability names. */
function structuralKey(role: RoleLike): string {
  return JSON.stringify([
    role.name ?? "",
    role.persona?.toPrompt?.() ?? "",
    (role.judgments ?? []).map(slotName),
    (role.capabilities ?? []).map((c) => c.name ?? ""),
  ]);
}

/**
 * Group registrations by role REFERENCE identity. Structurally-equal roles
 * with different references stay separate entries, cross-flagged via
 * `similarTo` — never silently merged (doc §10). Ids are role-name slugs,
 * disambiguated deterministically in registration order (-2, -3, …).
 */
export function buildRoleEntries(agents: AgentRegistration[]): RoleEntry[] {
  const byRef = new Map<object, RoleEntry>();
  const entries: RoleEntry[] = [];
  const takenIds = new Set<string>();

  for (const reg of agents) {
    const role = (reg.agent as unknown as AgentIntrospect).role;
    if (!role || typeof role !== "object") continue;
    const existing = byRef.get(role);
    if (existing) {
      existing.members.push(reg);
      continue;
    }
    // Bump the suffix until unused — counting the base slug alone would let a
    // role literally named "review-2" collide with the second "review".
    const base = slugId(role.name ?? "role");
    let id = base;
    for (let n = 2; takenIds.has(id); n++) id = `${base}-${n}`;
    takenIds.add(id);
    const entry: RoleEntry = {
      id,
      role,
      members: [reg],
      structuralKey: structuralKey(role),
      similarTo: [],
    };
    byRef.set(role, entry);
    entries.push(entry);
  }

  // Cross-flag structural twins.
  for (const a of entries) {
    for (const b of entries) {
      if (a !== b && a.structuralKey === b.structuralKey) a.similarTo.push(b.id);
    }
  }

  return entries;
}

function roleSummary(entry: RoleEntry) {
  return {
    id: entry.id,
    name: entry.role.name ?? "role",
    defaultModel: entry.role.defaultModel ?? "",
    similarTo: entry.similarTo,
    agents: entry.members.map((m) => ({ id: m.id, name: m.name })),
  };
}

/* ------------------------------------------------------------------------ */
/* Capability catalog (capability-keyed: name + toolbox name, slugged)       */
/* ------------------------------------------------------------------------ */

interface CapabilityEntry {
  id: string;
  /** Raw composite key — see capabilityKey. Distinct keys never share an id. */
  key: string;
  cap: CapabilityLike;
  roleIds: Set<string>;
  agentIds: Set<string>;
}

/**
 * Raw catalog key: the (capability name, toolbox name) pair, JSON-encoded so
 * the two parts can never bleed into each other the way a slugged join does
 * ("web" + "search-tools" vs "web-search" + "tools" both slug to
 * `web-search-tools`).
 */
function capabilityKey(cap: CapabilityLike): string {
  return JSON.stringify([cap.name ?? "capability", cap.toolbox?.name ?? ""]);
}

/**
 * Build the capability-keyed catalog across all registrations. Key is
 * capability name + toolbox name (a shared toolbox under two capabilities is
 * two entries — Manual/Playbook bind at the Capability layer, per §3). Ids are
 * slugs of that key, suffix-disambiguated in registration order when two
 * DIFFERENT keys slug identically.
 */
function buildCapabilityEntries(roleEntries: RoleEntry[]): CapabilityEntry[] {
  const byKey = new Map<string, CapabilityEntry>();
  const takenIds = new Set<string>();
  for (const entry of roleEntries) {
    for (const cap of entry.role.capabilities ?? []) {
      const key = capabilityKey(cap);
      let ce = byKey.get(key);
      if (!ce) {
        const base = slugId(`${cap.name ?? "capability"} ${cap.toolbox?.name ?? ""}`);
        let id = base;
        for (let n = 2; takenIds.has(id); n++) id = `${base}-${n}`;
        takenIds.add(id);
        ce = { id, key, cap, roleIds: new Set(), agentIds: new Set() };
        byKey.set(key, ce);
      }
      ce.roleIds.add(entry.id);
      for (const m of entry.members) ce.agentIds.add(m.id);
    }
  }
  // Registration order is preserved by Map insertion order via roleEntries.
  return [...byKey.values()];
}

/** Other catalog entries sharing this entry's toolbox (reference or name). */
function sharesToolboxWith(entry: CapabilityEntry, all: CapabilityEntry[]): string[] {
  return all
    .filter(
      (other) =>
        other.id !== entry.id &&
        (other.cap.toolbox === entry.cap.toolbox ||
          (other.cap.toolbox?.name !== undefined &&
            other.cap.toolbox.name === entry.cap.toolbox?.name)),
    )
    .map((other) => other.id);
}

/* ------------------------------------------------------------------------ */
/* Per-slot edges (§6 — the slot drawer's data on GET /roles/:id)            */
/* ------------------------------------------------------------------------ */

interface SlotEdges {
  usedBy: { roles: string[]; agents: string[] };
  similar: { roleId: string; name: string }[];
}

/**
 * Cross-role edges for one judgment/responsibility slot: which roles (and
 * their agents) carry a structurally identical slot — same name AND rendered
 * text (used-by: the promotion evidence) — and which slots elsewhere share
 * the name but differ in content (similar: the variant/fork view). Same-name
 * different-content slots are never folded into usedBy (§10's never-merge
 * discipline); they surface side by side as `similar`.
 */
function slotEdgesFor(
  entries: RoleEntry[],
  slotKind: "judgments" | "responsibilities",
  name: string,
  text: string,
): SlotEdges {
  const roles: string[] = [];
  const agentIds: string[] = [];
  const similar: { roleId: string; name: string }[] = [];
  for (const entry of entries) {
    let identical = false;
    let namedVariant = false;
    for (const slot of entry.role[slotKind] ?? []) {
      if (slotName(slot) !== name) continue;
      if ((slot.toPrompt?.() ?? "") === text) identical = true;
      else namedVariant = true;
    }
    if (identical) {
      roles.push(entry.id);
      for (const m of entry.members) agentIds.push(m.id);
    }
    if (namedVariant) similar.push({ roleId: entry.id, name });
  }
  return { usedBy: { roles, agents: agentIds }, similar };
}

/* ------------------------------------------------------------------------ */
/* Routes                                                                    */
/* ------------------------------------------------------------------------ */

/**
 * Serialize one agent instance into the full composition payload: role slots,
 * instantiation delta, provenance, rendered prompt sections, coherence. The
 * GET route feeds it the DECLARED instance (`reg.agent`); the delivered route
 * feeds it the instance `reg.instantiate(context)` composed live.
 */
function agentCompositionPayload(reg: AgentRegistration, agent: unknown) {
  const a = agent as AgentIntrospect;
  const role = a.role ?? {};

  // Render path caveat (§6): report which prompt path the payload carries.
  // Newer cores expose renderSections(); older ones only the joined string —
  // that blob mixes role AND instance content, so its source is honestly
  // "unknown" (§5: never a confident-but-wrong attribution).
  const prompt =
    typeof a.renderSections === "function"
      ? { renderPath: "sections" as const, sections: a.renderSections() }
      : {
          renderPath: "joined" as const,
          sections: [
            {
              name: "system",
              source: "unknown" as const,
              text: a.renderInitialPrompt?.() ?? "",
            },
          ],
        };

  return {
    id: reg.id,
    name: reg.name,
    description: reg.description ?? "",
    model: typeof a.getModel === "function" ? a.getModel() : undefined,
    role: {
      name: role.name ?? "role",
      defaultModel: role.defaultModel ?? "",
      ...roleSlots(role, reg),
    },
    instance: {
      background: a.background?.data ?? null,
      awareness: a.awareness?.data ?? null,
      mission: sanitizeMission(a.mission?.data),
      modelOverride: a.data?.model ?? null,
    },
    prompt,
    coherence: { heuristic: true, warnings: coherenceWarnings(a) },
    instantiation: {
      available: typeof reg.instantiate === "function",
      defaults: reg.instantiateDefaults ?? null,
    },
    evals: reg.evals ?? [],
  };
}

export function compositionRoutes(agents: AgentRegistration[]): Hono {
  const app = new Hono();

  // GET /agents/:id/composition — the DECLARED instance's introspection (what
  // the registration statically exports).
  app.get("/agents/:id/composition", (c) => {
    const reg = agents.find((a) => a.id === c.req.param("id"));
    if (!reg) return c.json({ error: "Agent not found" }, 404);
    return c.json(agentCompositionPayload(reg, reg.agent));
  });

  // POST /agents/:id/composition/delivered — compose the DELIVERED instance
  // via the registration's `instantiate(context)` hook and introspect THAT:
  // the actual Background/prompt an entrypoint would hand the model for this
  // context. May hit live sources (a tenant DB, an engine), so it's a POST,
  // never cached, and absent hooks answer 501 honestly.
  app.post("/agents/:id/composition/delivered", async (c) => {
    const reg = agents.find((a) => a.id === c.req.param("id"));
    if (!reg) return c.json({ error: "Agent not found" }, 404);
    if (typeof reg.instantiate !== "function") {
      return c.json({ error: "Agent has no instantiate hook — declared composition only" }, 501);
    }

    let context: Record<string, unknown> | undefined;
    try {
      const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
      const raw = body.context;
      if (raw !== undefined && (typeof raw !== "object" || raw === null || Array.isArray(raw))) {
        return c.json({ error: "`context` must be a JSON object" }, 400);
      }
      context = raw as Record<string, unknown> | undefined;
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    // No explicit context → compose with the registration's declared defaults,
    // so the echoed `context` always states what instantiate actually received.
    const effectiveContext = context ?? reg.instantiateDefaults;

    try {
      const delivered = await reg.instantiate(effectiveContext);
      return c.json({
        ...agentCompositionPayload(reg, delivered),
        delivered: true,
        context: effectiveContext ?? null,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: `instantiate failed: ${message}` }, 502);
    }
  });

  // GET /roles — identity catalog grouped by role reference identity.
  app.get("/roles", (c) => {
    return c.json(buildRoleEntries(agents).map(roleSummary));
  });

  // GET /roles/:id — summary + slot stack (with per-slot used-by/similar
  // edges — the slot drawer's data, §6) + instantiation-matrix data.
  app.get("/roles/:id", (c) => {
    const entries = buildRoleEntries(agents);
    const entry = entries.find((e) => e.id === c.req.param("id"));
    if (!entry) return c.json({ error: "Role not found" }, 404);

    // Provenance can come from ANY member registration — first with a blob.
    const provReg = entry.members.find((m) => m.provenance !== undefined) ?? entry.members[0];

    const slots = roleSlots(entry.role, provReg);
    const capEntries = buildCapabilityEntries(entries);

    return c.json({
      ...roleSummary(entry),
      ...slots,
      judgments: slots.judgments.map((j) => ({
        ...j,
        ...slotEdgesFor(entries, "judgments", j.name, j.text),
      })),
      responsibilities: slots.responsibilities.map((r) => ({
        ...r,
        ...slotEdgesFor(entries, "responsibilities", r.name, r.text),
      })),
      // Capability slots link into the capability catalog for their edges.
      capabilities: slots.capabilities.map((block, i) => {
        const cap = (entry.role.capabilities ?? [])[i];
        const ce = cap ? capEntries.find((e) => e.key === capabilityKey(cap)) : undefined;
        return {
          ...block,
          ...(ce
            ? {
                id: ce.id,
                usedBy: { roles: [...ce.roleIds], agents: [...ce.agentIds] },
                sharesToolboxWith: sharesToolboxWith(ce, capEntries),
              }
            : {}),
        };
      }),
      agents: entry.members.map((m) => {
        const a = m.agent as unknown as AgentIntrospect;
        return {
          id: m.id,
          name: m.name,
          model: typeof a.getModel === "function" ? a.getModel() : undefined,
          background: a.background?.data ?? null,
          awareness: a.awareness?.data ?? null,
          mission: sanitizeMission(a.mission?.data),
        };
      }),
    });
  });

  // GET /capabilities — capability-keyed substrate catalog with usage edges.
  app.get("/capabilities", (c) => {
    const entries = buildCapabilityEntries(buildRoleEntries(agents));
    return c.json(
      entries.map((entry) => ({
        id: entry.id,
        name: entry.cap.name ?? "capability",
        description: entry.cap.description ?? "",
        toolbox: {
          name: entry.cap.toolbox?.name ?? "",
          description: entry.cap.toolbox?.description ?? "",
          toolCount: Object.keys(entry.cap.toolbox?.tools ?? {}).length,
        },
        usedBy: { roles: [...entry.roleIds], agents: [...entry.agentIds] },
        sharesToolboxWith: sharesToolboxWith(entry, entries),
      })),
    );
  });

  // GET /capabilities/:id — full detail: tool schemas, manual, playbook, edges.
  app.get("/capabilities/:id", (c) => {
    const entries = buildCapabilityEntries(buildRoleEntries(agents));
    const entry = entries.find((e) => e.id === c.req.param("id"));
    if (!entry) return c.json({ error: "Capability not found" }, 404);

    return c.json({
      id: entry.id,
      ...capabilityBlock(entry.cap),
      usedBy: { roles: [...entry.roleIds], agents: [...entry.agentIds] },
      sharesToolboxWith: sharesToolboxWith(entry, entries),
    });
  });

  return app;
}

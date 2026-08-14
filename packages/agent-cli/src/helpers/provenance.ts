/**
 * Slot provenance — attribute each slot of a discovered agent's role
 * (persona, judgments, responsibilities, capabilities) to WHERE it came from.
 *
 * Tier vocabulary (docs/playground-redesign.md §5):
 *   preset   — matches a @pattern-stack/agentic-runtime preset by reference, or by
 *              name + structural content across the dual-package boundary
 *   preset?  — matches a preset's NAME only (content differs) — honest uncertainty,
 *              never silently rendered as `preset`
 *   library  — matched an export of a `roles/` library module under the project
 *   local    — matched an export of a module sitting next to the agent file
 *   inline   — nothing matched; constructed inline (or unattributable)
 *
 * The mechanism is a lookup against ENUMERATED known sets, never a bare
 * heuristic. Three registries are built once per computeProvenance() call:
 *
 *   • PRESET  — every Judgment/Responsibility-shaped const exported by the
 *     runtime barrel, plus the persona/judgments/responsibilities of each role
 *     FACTORY (`analystRole()` returns a fresh instance per call, so factories
 *     are invoked once and their built slots registered as preset content).
 *   • LIBRARY — every slot-shaped export (and arrays of them) of modules
 *     matching the configured library glob (default `**\/roles/**`, override
 *     via `ProvenanceOptions.libraryGlobs` / package.json `agentic.roles`)
 *     under the project root, dynamic-imported once.
 *   • LOCAL   — per agent, the slot-shaped exports of modules in the agent
 *     file's own directory (the agent file's own exports count as local).
 *
 * Matching order per slot: reference equality (===) preset → library → local;
 * then name + deep-equal `.data` content (capabilities compare name +
 * toolbox name + tool names) preset → library → local; then name-only against
 * presets → `preset?`; else `inline`. Reference identity alone is unreliable
 * across the src-vs-dist dual-package boundary discover.ts documents — hence
 * the content fallback; and a name-only hit is deliberately rendered as
 * uncertain rather than confident-but-wrong.
 *
 * All shape checks are structural (duck-typed) like discover.ts's
 * `isAgentShape` — never `instanceof`, for the same bundle-proofing reason.
 */

import path from "node:path";
import { pathToFileURL } from "node:url";
import * as runtimePresets from "@pattern-stack/agentic-runtime";
import { glob } from "tinyglobby";
import { ensureTsxRegistered } from "./discover.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ProvenanceTier = "preset" | "preset?" | "library" | "local" | "inline";

export type SlotType = "persona" | "judgment" | "responsibility" | "capability";

export interface SlotProvenance {
  slotType: SlotType;
  /** Slot's own name (judgment domain, capability name; persona uses role name or "persona"). */
  name: string;
  /**
   * Position of the slot in its role array (persona is always 0). The join key
   * consumers use is slotType + index — names may collide (two judgments in
   * one domain: exactly the preset-vs-fork collision the lens exists to show),
   * so a name join could render a fork with the true preset's chip.
   */
  index: number;
  tier: ProvenanceTier;
  /** Module path the slot matched in (library/local), or "@pattern-stack/agentic-runtime" for presets. */
  sourcePath?: string;
}

/** Options for computeProvenance/attachProvenance. */
export interface ProvenanceOptions {
  /**
   * Glob(s) enumerating the project's role LIBRARY modules (§5: "a configured
   * glob"), relative to the project root. Defaults to `**\/roles/**`.
   */
  readonly libraryGlobs?: readonly string[];
}

const DEFAULT_LIBRARY_GLOBS = ["**/roles/**/*.{ts,js,mjs}"];

export interface AgentProvenance {
  file: string;
  slots: SlotProvenance[];
}

/** The minimal DiscoveredAgent surface provenance needs (id + file + agent). */
export interface DiscoveredAgentLike {
  readonly id: string;
  readonly file: string;
  // biome-ignore lint/suspicious/noExplicitAny: agent shape comes from user code, kept loose at the discovery boundary
  readonly agent: any;
}

// ---------------------------------------------------------------------------
// Structural shape checks (duck-typed — see header)
// ---------------------------------------------------------------------------

const PRESET_SOURCE = "@pattern-stack/agentic-runtime";

function dataOf(x: unknown): Record<string, unknown> | null {
  if (!x || typeof x !== "object") return null;
  const d = (x as { data?: unknown }).data;
  return d && typeof d === "object" ? (d as Record<string, unknown>) : null;
}

function isJudgmentShape(x: unknown): boolean {
  const d = dataOf(x);
  return d !== null && typeof d.domain === "string" && Array.isArray(d.heuristics);
}

function isResponsibilityShape(x: unknown): boolean {
  const d = dataOf(x);
  return (
    d !== null &&
    typeof d.key === "string" &&
    typeof d.name === "string" &&
    typeof d.description === "string"
  );
}

function isPersonaShape(x: unknown): boolean {
  const d = dataOf(x);
  return d !== null && typeof d.identity === "string" && typeof d.tone === "string";
}

function isCapabilityShape(x: unknown): boolean {
  if (!x || typeof x !== "object") return false;
  const c = x as Record<string, unknown>;
  if (typeof c.name !== "string" || !c.toolbox || typeof c.toolbox !== "object") return false;
  return typeof (c.toolbox as Record<string, unknown>).name === "string";
}

/** Role-shaped: persona + judgments/responsibilities/capabilities arrays. */
function isRoleShape(x: unknown): boolean {
  if (!x || typeof x !== "object") return false;
  const r = x as Record<string, unknown>;
  return (
    isPersonaShape(r.persona) &&
    Array.isArray(r.judgments) &&
    Array.isArray(r.responsibilities) &&
    Array.isArray(r.capabilities)
  );
}

/** Which slot type a value IS, or null when it is not slot-shaped at all. */
function classifySlot(x: unknown): SlotType | null {
  if (isJudgmentShape(x)) return "judgment";
  if (isResponsibilityShape(x)) return "responsibility";
  if (isPersonaShape(x)) return "persona";
  if (isCapabilityShape(x)) return "capability";
  return null;
}

// ---------------------------------------------------------------------------
// Match keys — name + structural content
// ---------------------------------------------------------------------------

/**
 * A slot's matchable NAME. Personas carry no name of their own, so they match
 * on the constant "persona" + content (the reported display name is the role's).
 */
function matchNameOf(slotType: SlotType, value: unknown): string {
  const d = dataOf(value);
  switch (slotType) {
    case "judgment":
      return typeof d?.domain === "string" ? d.domain : "";
    case "responsibility":
      return typeof d?.name === "string" ? d.name : "";
    case "persona":
      return "persona";
    case "capability": {
      const name = (value as Record<string, unknown>).name;
      return typeof name === "string" ? name : "";
    }
  }
}

/**
 * A slot's structural CONTENT key. Atoms serialize their frozen `.data`;
 * capabilities (class-composed, no `.data`) compare name + toolbox name +
 * tool names.
 */
function contentKeyOf(slotType: SlotType, value: unknown): string {
  if (slotType === "capability") {
    const c = value as Record<string, unknown>;
    const toolbox = c.toolbox as Record<string, unknown>;
    const tools = toolbox.tools;
    const toolNames = tools && typeof tools === "object" ? Object.keys(tools as object).sort() : [];
    return JSON.stringify({ name: c.name, toolbox: toolbox.name, tools: toolNames });
  }
  return JSON.stringify(dataOf(value));
}

// ---------------------------------------------------------------------------
// Registries
// ---------------------------------------------------------------------------

interface RegistryEntry {
  readonly value: unknown;
  readonly slotType: SlotType;
  readonly name: string;
  readonly contentKey: string;
  readonly sourcePath: string;
}

function addValue(value: unknown, sourcePath: string, into: RegistryEntry[]): void {
  const slotType = classifySlot(value);
  if (!slotType) return;
  into.push({
    value,
    slotType,
    name: matchNameOf(slotType, value),
    contentKey: contentKeyOf(slotType, value),
    sourcePath,
  });
}

/** Slot-shaped exports of a module — direct values and arrays of them. */
function collectFromModule(
  mod: Record<string, unknown>,
  sourcePath: string,
  into: RegistryEntry[],
): void {
  for (const value of Object.values(mod)) {
    if (Array.isArray(value)) {
      for (const item of value) addValue(item, sourcePath, into);
    } else {
      addValue(value, sourcePath, into);
    }
  }
}

/**
 * PRESET registry — const Judgment/Responsibility exports collected directly;
 * role FACTORIES (`*Role()` — the documented preset convention) invoked once
 * (no args, try/catch) and their built persona/judgments/responsibilities/
 * capabilities registered as preset instances. Only `*Role`-named functions
 * are invoked: the runtime barrel also exports unrelated functions with side
 * effects (e.g. `createRunner` probes env + spawns processes), so blind
 * invocation of every export is off the table.
 */
function buildPresetRegistry(): RegistryEntry[] {
  const entries: RegistryEntry[] = [];
  for (const [key, value] of Object.entries(runtimePresets as Record<string, unknown>)) {
    addValue(value, PRESET_SOURCE, entries);

    if (typeof value === "function" && /Role$/.test(key)) {
      try {
        const role: unknown = (value as () => unknown)();
        if (isRoleShape(role)) {
          const r = role as Record<string, unknown>;
          addValue(r.persona, PRESET_SOURCE, entries);
          for (const j of r.judgments as unknown[]) addValue(j, PRESET_SOURCE, entries);
          for (const resp of r.responsibilities as unknown[])
            addValue(resp, PRESET_SOURCE, entries);
          for (const cap of r.capabilities as unknown[]) addValue(cap, PRESET_SOURCE, entries);
        }
      } catch {
        // A factory that throws when called bare is simply not registered.
      }
    }
  }
  return entries;
}

/**
 * Import each file and collect its slot-shaped exports. A broken module must
 * not kill discovery — failures are recorded (stderr warning) and skipped.
 * `moduleCache` dedupes imports when a file appears in both the library glob
 * and an agent's local directory.
 */
async function registryFromFiles(
  files: readonly string[],
  projectRoot: string,
  moduleCache: Map<string, Record<string, unknown> | null>,
): Promise<RegistryEntry[]> {
  const entries: RegistryEntry[] = [];
  for (const file of files) {
    let mod = moduleCache.get(file);
    if (mod === undefined) {
      const isTs = file.endsWith(".ts") || file.endsWith(".tsx") || file.endsWith(".mts");
      if (isTs) ensureTsxRegistered();
      try {
        mod = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
      } catch (e) {
        mod = null;
        const msg = e instanceof Error ? e.message : String(e);
        process.stderr.write(
          `[provenance] warning: skipped ${path.relative(projectRoot, file)} — ${msg}\n`,
        );
      }
      moduleCache.set(file, mod);
    }
    if (mod) collectFromModule(mod, path.relative(projectRoot, file), entries);
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

interface TieredRegistry {
  readonly tier: "preset" | "library" | "local";
  readonly entries: readonly RegistryEntry[];
}

function matchSlot(
  slotType: SlotType,
  value: unknown,
  registries: readonly TieredRegistry[],
): { tier: ProvenanceTier; sourcePath?: string } {
  // 1. Reference identity — strongest signal where module identity holds.
  for (const { tier, entries } of registries) {
    const hit = entries.find((e) => e.slotType === slotType && e.value === value);
    if (hit) return { tier, sourcePath: hit.sourcePath };
  }

  // 2. Name + structural content — survives the src-vs-dist boundary.
  const name = matchNameOf(slotType, value);
  const contentKey = contentKeyOf(slotType, value);
  for (const { tier, entries } of registries) {
    const hit = entries.find(
      (e) => e.slotType === slotType && e.name === name && e.contentKey === contentKey,
    );
    if (hit) return { tier, sourcePath: hit.sourcePath };
  }

  // 3. Name-only against presets — uncertain, rendered as uncertain.
  // Personas are excluded: they carry no name of their own (matchName is the
  // constant "persona"), so a name-only hit would flag EVERY persona.
  if (slotType === "persona") return { tier: "inline" };
  const presets = registries.find((r) => r.tier === "preset");
  if (presets?.entries.some((e) => e.slotType === slotType && e.name === name)) {
    return { tier: "preset?", sourcePath: PRESET_SOURCE };
  }

  return { tier: "inline" };
}

/** Attribute every slot of one agent's role against the three registries. */
function slotsFor(agent: unknown, registries: readonly TieredRegistry[]): SlotProvenance[] {
  const role = (agent as Record<string, unknown> | null)?.role;
  if (!role || typeof role !== "object") return [];
  const r = role as Record<string, unknown>;

  const slots: SlotProvenance[] = [];

  if (isPersonaShape(r.persona)) {
    const roleName = typeof r.name === "string" && r.name.length > 0 ? r.name : "persona";
    slots.push({
      slotType: "persona",
      name: roleName,
      index: 0,
      ...matchSlot("persona", r.persona, registries),
    });
  }

  const collections: readonly [SlotType, unknown][] = [
    ["judgment", r.judgments],
    ["responsibility", r.responsibilities],
    ["capability", r.capabilities],
  ];
  for (const [slotType, values] of collections) {
    if (!Array.isArray(values)) continue;
    // `index` is the RAW array position (skipped values leave a hole), so it
    // lines up with consumers that iterate the role arrays directly.
    for (const [index, value] of values.entries()) {
      if (classifySlot(value) !== slotType) continue; // not the shape it claims — skip
      slots.push({
        slotType,
        name: matchNameOf(slotType, value),
        index,
        ...matchSlot(slotType, value, registries),
      });
    }
  }
  return slots;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compute per-slot provenance for every discovered agent. Returns a map keyed
 * by agent id. Builds the preset registry in-process, the library registry
 * from modules matching `options.libraryGlobs` (default `**\/roles/**`) under
 * `projectRoot`, and a local registry from each agent file's own directory.
 * Test files are never imported — they are not slot sources, and importing
 * them can fail loudly (vitest module state) on every CLI invocation.
 */
export async function computeProvenance(
  agents: readonly DiscoveredAgentLike[],
  projectRoot: string,
  options: ProvenanceOptions = {},
): Promise<Map<string, AgentProvenance>> {
  const presetRegistry: TieredRegistry = { tier: "preset", entries: buildPresetRegistry() };

  const moduleCache = new Map<string, Record<string, unknown> | null>();

  const libraryFiles = await glob([...(options.libraryGlobs ?? DEFAULT_LIBRARY_GLOBS)], {
    cwd: projectRoot,
    absolute: true,
    onlyFiles: true,
    ignore: ["**/node_modules/**", "**/dist/**", "**/__tests__/**", "**/*.test.*", "**/*.spec.*"],
  });
  const libraryRegistry: TieredRegistry = {
    tier: "library",
    entries: await registryFromFiles(libraryFiles.sort(), projectRoot, moduleCache),
  };

  // Local registries are per-directory (agents in one folder share theirs).
  const localByDir = new Map<string, TieredRegistry>();

  const out = new Map<string, AgentProvenance>();
  for (const agent of agents) {
    const dir = path.dirname(agent.file);
    let local = localByDir.get(dir);
    if (!local) {
      const localFiles = await glob(["*.{ts,js,mjs}"], {
        cwd: dir,
        absolute: true,
        onlyFiles: true,
        ignore: ["**/*.test.*", "**/*.spec.*"],
      });
      local = {
        tier: "local",
        entries: await registryFromFiles(localFiles.sort(), projectRoot, moduleCache),
      };
      localByDir.set(dir, local);
    }

    const registries: readonly TieredRegistry[] = [presetRegistry, libraryRegistry, local];
    out.set(agent.id, { file: agent.file, slots: slotsFor(agent.agent, registries) });
  }
  return out;
}

/**
 * Failure-isolated enrichment: attach an `AgentProvenance` to each agent.
 * If provenance computation throws, warn and return the agents untouched —
 * provenance must never break discovery.
 */
export async function attachProvenance<T extends DiscoveredAgentLike>(
  agents: readonly T[],
  projectRoot: string,
  options: ProvenanceOptions = {},
): Promise<(T & { readonly provenance?: AgentProvenance })[]> {
  try {
    const provenance = await computeProvenance(agents, projectRoot, options);
    return agents.map((a) => {
      const p = provenance.get(a.id);
      return p ? { ...a, provenance: p } : a;
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(
      `[provenance] warning: provenance computation failed — continuing without it (${msg})\n`,
    );
    return [...agents];
  }
}

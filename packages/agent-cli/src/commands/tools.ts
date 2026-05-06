/**
 * `ap tools list <agent-id>`     — list every tool exposed by an agent's toolboxes.
 * `ap tools call <agent-id> <tool-name> [--field=value ...]`
 *                                 — invoke a single tool from the terminal,
 *                                   bypassing the LLM entirely.
 *
 * The toolbox stays the single source of truth: we walk
 * `agent.role.capabilities[].toolbox.tools`, and dispatch via
 * `toolbox.execute(name, args)` (which performs the boundary Zod parse
 * — we deliberately do NOT re-validate here).
 *
 * Argument parsing: for each top-level field of the tool's Zod object
 * schema we accept `--<field>=<value>`, coerced per primitive type.
 * Anything we can't classify is passed through as a string and Zod's
 * boundary parse decides — this keeps the CLI honest about who owns
 * validation.
 */

import type { Capability, ToolDefinition, Toolbox } from "@agentic-patterns/core";
import type { DiscoveredAgent } from "../helpers/discover.js";

/**
 * Loose Zod schema shape — duck-typed to avoid a direct zod dep.
 * Zod 3's runtime tags every schema with `_def.typeName` (e.g.
 * "ZodString"), and ZodObject's `.shape` is the field map. Both are
 * stable public-ish surface used widely; this lets the CLI introspect
 * tool param schemas without taking on zod as a peer dep.
 */
type ZodSchemaLike = {
  _def?: { typeName?: string; innerType?: ZodSchemaLike };
  shape?: Record<string, ZodSchemaLike>;
  element?: ZodSchemaLike;
};

// ---------------------------------------------------------------------------
// ANSI helpers (no chalk dep — same convention as agents.ts/run.ts)
// ---------------------------------------------------------------------------

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const RED = "\x1b[31m";

function bold(s: string): string {
  return `${BOLD}${s}${RESET}`;
}
function dim(s: string): string {
  return `${DIM}${s}${RESET}`;
}
function red(s: string): string {
  return `${RED}${s}${RESET}`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ToolsCommandInput {
  agents: DiscoveredAgent[];
  /** "list" | "call" — the subcommand after `ap tools`. */
  subcommand: string | undefined;
  /** Remaining positional args AFTER the subcommand. */
  positionals: string[];
  /** Raw argv from process.argv.slice(2) so we can re-parse tool flags. */
  argv: string[];
}

export async function runToolsCommand(input: ToolsCommandInput): Promise<void> {
  const { subcommand } = input;

  if (subcommand === "list") {
    runToolsListCommand(input);
    return;
  }

  if (subcommand === "call") {
    await runToolsCallCommand(input);
    return;
  }

  process.stderr.write(
    `${red("error:")} unknown tools subcommand "${subcommand ?? ""}"\n  usage: ap tools list <agent-id>\n         ap tools call <agent-id> <tool-name> [--field=value ...]\n`,
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

function runToolsListCommand(input: ToolsCommandInput): void {
  const agentId = input.positionals[0];
  if (!agentId) {
    process.stderr.write(`${red("error:")} ap tools list requires an agent id\n`);
    process.exit(1);
  }

  const reg = findAgentOrExit(input.agents, agentId);
  const entries = collectTools(reg);

  process.stdout.write("\n");
  if (entries.length === 0) {
    process.stdout.write(`  ${dim(`agent "${agentId}" has no capabilities with tools`)}\n\n`);
    return;
  }

  process.stdout.write(
    `  ${bold(`${entries.length} tool${entries.length === 1 ? "" : "s"}`)} ${dim(
      `on ${reg.id}`,
    )}\n\n`,
  );

  const nameCol = Math.max(...entries.map((e) => e.toolName.length), 4);
  const capCol = Math.max(...entries.map((e) => e.capabilityName.length), 10);

  for (const e of entries) {
    process.stdout.write(
      `  ${e.toolName.padEnd(nameCol)}  ${dim(e.capabilityName.padEnd(capCol))}  ${e.description}\n`,
    );
  }
  process.stdout.write("\n");
}

// ---------------------------------------------------------------------------
// call
// ---------------------------------------------------------------------------

async function runToolsCallCommand(input: ToolsCommandInput): Promise<void> {
  const agentId = input.positionals[0];
  const toolName = input.positionals[1];
  if (!agentId || !toolName) {
    process.stderr.write(`${red("error:")} ap tools call requires <agent-id> <tool-name>\n`);
    process.exit(1);
  }

  const reg = findAgentOrExit(input.agents, agentId);
  const entries = collectTools(reg);
  const entry = entries.find((e) => e.toolName === toolName);
  if (!entry) {
    const available = entries.map((e) => e.toolName).join(", ") || "(none)";
    process.stderr.write(
      `${red(`tool "${toolName}" not found on agent "${agentId}"`)}\n  available: ${available}\n`,
    );
    process.exit(1);
  }

  const args = parseToolArgs(entry.definition.parameters, input.argv);

  try {
    const result = await entry.toolbox.execute(toolName, args);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${red("error:")} ${msg}\n`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ToolEntry {
  toolName: string;
  capabilityName: string;
  description: string;
  toolbox: Toolbox;
  definition: ToolDefinition;
}

function findAgentOrExit(agents: DiscoveredAgent[], agentId: string): DiscoveredAgent {
  const reg = agents.find((a) => a.id === agentId);
  if (!reg) {
    const available = agents.map((a) => a.id).join(", ") || "(none)";
    process.stderr.write(`${red(`agent "${agentId}" not found`)}\n  available: ${available}\n`);
    process.exit(1);
    // appease TS — process.exit returns `never`, but the typedef varies
    throw new Error("unreachable");
  }
  return reg;
}

/**
 * Walk the agent's role → capabilities → toolbox → tools. Tool names are
 * NOT deduplicated across capabilities — if two capabilities expose the
 * same name, both are listed; `call` resolves by first match (which is
 * also the order the framework's CapabilitiesSection renders to the LLM,
 * so behavior is consistent).
 */
function collectTools(reg: DiscoveredAgent): ToolEntry[] {
  const entries: ToolEntry[] = [];
  const capabilities = (reg.agent?.role?.capabilities ?? []) as readonly Capability[];
  for (const cap of capabilities) {
    const toolbox = cap.toolbox;
    if (!toolbox) continue;
    for (const [toolName, def] of Object.entries(toolbox.tools)) {
      entries.push({
        toolName,
        capabilityName: cap.name,
        description: def.description,
        toolbox,
        definition: def,
      });
    }
  }
  return entries;
}

/**
 * Parse `--field=value` (or `--field value`, or boolean `--field`) flags
 * out of `argv` for the given Zod object schema. We unwrap optionals/
 * defaults/nullables one level so `z.string().optional()` is still seen
 * as a string field. Unknown flags are still parsed (as strings) and
 * passed through — Zod's boundary parse will reject them with a clear
 * error.
 */
function parseToolArgs(schema: ZodSchemaLike, argv: string[]): Record<string, unknown> {
  const shape = unwrapObjectShape(schema);
  const out: Record<string, unknown> = {};

  // Skip the leading positionals: ["tools", "call", "<agent>", "<tool>"].
  // `argv` is the raw process.argv.slice(2), and we just need the flag
  // tail. parseArgs would balk on unknown options; do it ourselves.
  const flags = collectFlagPairs(argv);

  for (const [rawKey, rawValues] of flags.entries()) {
    const fieldSchema = shape?.[rawKey];
    const kind = classify(fieldSchema);

    if (kind === "boolean") {
      // No-value form (`--flag`) → true; value form coerces.
      const v = rawValues[rawValues.length - 1];
      out[rawKey] = v === undefined ? true : v === "true";
      continue;
    }

    if (kind === "number") {
      const v = rawValues[rawValues.length - 1];
      out[rawKey] = v === undefined ? Number.NaN : Number(v);
      continue;
    }

    if (kind === "array-string") {
      // Either `--label=a,b,c` once, or `--label=a --label=b` repeated.
      const all: string[] = [];
      for (const v of rawValues) {
        if (v === undefined) continue;
        if (v.includes(",")) {
          for (const part of v.split(",")) all.push(part);
        } else {
          all.push(v);
        }
      }
      out[rawKey] = all;
      continue;
    }

    // string / enum / unknown: take the last value verbatim.
    const v = rawValues[rawValues.length - 1];
    out[rawKey] = v ?? "";
  }

  return out;
}

/**
 * Collect every `--key=value`, `--key value`, and bare `--key` from
 * `argv`. We deliberately ignore positionals — the caller has already
 * consumed them.
 *
 * Returns a Map<key, values[]> so repeated flags are preserved.
 */
function collectFlagPairs(argv: string[]): Map<string, (string | undefined)[]> {
  const out = new Map<string, (string | undefined)[]>();
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (!tok || !tok.startsWith("--")) continue;
    const body = tok.slice(2);
    let key: string;
    let value: string | undefined;
    const eq = body.indexOf("=");
    if (eq >= 0) {
      key = body.slice(0, eq);
      value = body.slice(eq + 1);
    } else {
      key = body;
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        value = next;
        i += 1;
      } else {
        value = undefined;
      }
    }
    const list = out.get(key) ?? [];
    list.push(value);
    out.set(key, list);
  }
  return out;
}

/**
 * Pull the inner `.shape` off a Zod object schema, looking through one
 * level of `.optional()` / `.default()` / `.nullable()` wrappers (which
 * is what `z.object({...}).optional()` would produce — uncommon for top
 * level tool params, but cheap to handle).
 */
function unwrapObjectShape(
  schema: ZodSchemaLike | undefined,
): Record<string, ZodSchemaLike> | undefined {
  let cur: ZodSchemaLike | undefined = schema;
  for (let i = 0; i < 4 && cur; i++) {
    if (cur._def?.typeName === "ZodObject" && cur.shape) {
      return cur.shape;
    }
    const inner = cur._def?.innerType;
    if (inner) {
      cur = inner;
      continue;
    }
    break;
  }
  return undefined;
}

type FieldKind = "string" | "number" | "boolean" | "array-string" | "unknown";

/**
 * Classify a top-level field schema for CLI coercion. Walks through
 * optional/default/nullable wrappers; we only care about the primitive
 * leaf for arg-parsing purposes — Zod's parse at execute() handles
 * everything else.
 */
function classify(schema: ZodSchemaLike | undefined): FieldKind {
  let cur: ZodSchemaLike | undefined = schema;
  for (let i = 0; i < 4 && cur; i++) {
    const tn = cur._def?.typeName;
    if (tn === "ZodString") return "string";
    if (tn === "ZodNumber") return "number";
    if (tn === "ZodBoolean") return "boolean";
    if (tn === "ZodEnum" || tn === "ZodNativeEnum") return "string";
    if (tn === "ZodArray") {
      // Special-case arrays-of-string; anything else passes through as
      // a single string and Zod's parse rejects if mismatched.
      return cur.element?._def?.typeName === "ZodString" ? "array-string" : "unknown";
    }
    const inner = cur._def?.innerType;
    if (inner) {
      cur = inner;
      continue;
    }
    break;
  }
  return "unknown";
}

// Exported only for tests.
export const __test = { parseToolArgs, collectFlagPairs, classify, unwrapObjectShape };

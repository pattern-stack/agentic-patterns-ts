/**
 * State-delta event accessors (#226) — the ONE tolerant reader for every
 * surface that consumes `backpack.*` / `scratchpad.*` events.
 *
 * Three wire shapes reach the dashboard, and every field must be readable
 * from ALL of them (the same tolerance contract as `graph/trace-from-events`):
 *
 *   (a) LIVE playground SSE — the runtime's `toSSEMapping` payload, flattened
 *       by `toEventLike`: SNAKE_CASE keys (`size_before`, `tool_call_id`,
 *       `memo_hit`, `appended_indexes`, …).
 *   (b) PERSISTED run-history rows (`GET /admin/runs/:id/events`) — the raw
 *       camelCase `AgentEvent` body (`sizeBefore`, `toolCallId`, `memoHit`).
 *   (c) STORED `state_delta` conversation parts (session replay) — the wire
 *       event name under `event` plus the snake_case SSE payload verbatim
 *       (runtime `conversation.ts` `toStateDeltaPart`; persisted bytes ==
 *       streamed bytes), with `preview_redacted` marking the innate
 *       scratchpad-read redaction.
 *
 * Both the chat timeline fold (`chat/model.ts` `applyParts`) and the
 * Scratchpad rail fold (`chat/fold-inventory.ts`, WI-4) consume THIS module,
 * so the two surfaces can never drift on how a field is read.
 *
 * Browser-bundled and dependency-free — no runtime/server imports.
 */

/* ── model types (the `state_delta` Part sub-union) ─────────────────────────*/

/** Who initiated the mutation: the framework's own machinery vs agent code. */
export type StateOrigin = "innate" | "explicit";

/** One byte-capped row preview in a drop frame ([#N] handle + rendered line). */
export interface StateRowPreview {
  /** Canonical 1-based [#N] index (append-only, never renumbered). */
  index: number;
  /** Net-new identity vs folded into an existing one. */
  op: "added" | "merged";
  preview: string;
}

/** Per-BackpackSpec display metadata (caption/attribution for the rail). */
export interface StateDisplay {
  caption?: string;
  attribution?: string;
}

/** One manifest-strip segment on a UI-derived travel frame. */
export interface TravelRecord {
  /** 0-based per-pack DropRecord ordinal (drops + absorbs, arrival order). */
  drop: number;
  /** Entries this record covers ([#N] handles touched). */
  covered: number;
}

interface StateDeltaBase {
  kind: "state_delta";
  origin: StateOrigin;
  /**
   * Monotonic per-run write ordinal — ONE stream across backpack +
   * scratchpad, minted at the emission layer. Absent only on UI-derived
   * travel frames (which mirror no runtime event).
   */
  ordinal?: number;
  /** The causing tool call, when the mutation happened inside a tool dispatch. */
  toolCallId?: string;
  /** Name of the causing tool — resolved at insertion from the anchor tool part. */
  via?: string;
}

export type StateDeltaPart =
  | (StateDeltaBase & {
      op: "drop";
      key: string;
      accepted: number;
      merged: number;
      skipped: number;
      indexes: number[];
      sizeBefore: number;
      sizeAfter: number;
      previews: StateRowPreview[];
      /** Rows left out of `previews` by the frame preview budget — never silently clipped. */
      previewsOmitted: number;
      tag?: string;
      display?: StateDisplay;
      /** 0-based per-pack DropRecord ordinal, resolved at insertion (fold order). */
      dropSeq?: number;
    })
  | (StateDeltaBase & {
      op: "absorb";
      key: string;
      childSize: number;
      accepted: number;
      merged: number;
      sizeBefore: number;
      sizeAfter: number;
      appendedIndexes: number[];
      display?: StateDisplay;
      dropSeq?: number;
    })
  | (StateDeltaBase & {
      op: "read";
      key: string;
      scope: "backpack" | "scratchpad";
      /** backpack only: `finalized()` served from the per-write-generation memo. */
      memoHit?: boolean;
      /** backpack only: pack size at read time. */
      size?: number;
      preview?: string;
      /** Replay of an innate prompt read — the text streamed live, never stored. */
      previewRedacted?: boolean;
      display?: StateDisplay;
    })
  | (StateDeltaBase & {
      op: "write";
      key: string;
      writeOp: "set" | "update";
      hadValue: boolean;
      before?: string;
      after: string;
    })
  | (StateDeltaBase & { op: "fork"; sharedKeys: string[] })
  | (StateDeltaBase & { op: "join"; mergedKeys: string[]; discardedKeys: string[] })
  | (StateDeltaBase & {
      /** UI-DERIVED in v1 (drop events + step boundaries) — no runtime emitter. */
      op: "travel";
      key: string;
      derived: true;
      /** The stage the pack travels INTO (`step.start`'s stepName). */
      toStep: string;
      /** Pack size at the boundary. */
      items: number;
      records: TravelRecord[];
      /** Latest preview per [#N] index, accumulated from the drop frames. */
      previews: StateRowPreview[];
      /** No new drops since the previous travel frame for this key. */
      quiet?: boolean;
      /** Stage that produced the last drop (quiet frames: "no new drops since X"). */
      sinceStep?: string;
    });

/* ── wire vocabulary ────────────────────────────────────────────────────────*/

/** Bare wire names of the 7 runtime state-delta events (no `agent.` prefix). */
export const STATE_DELTA_EVENT_NAMES = [
  "backpack.drop",
  "backpack.read",
  "backpack.absorb",
  "scratchpad.write",
  "scratchpad.read",
  "scratchpad.fork",
  "scratchpad.join",
] as const;

const STATE_DELTA_NAME_SET: ReadonlySet<string> = new Set(STATE_DELTA_EVENT_NAMES);

/** Is this bare event type one of the 7 state-delta events? */
export function isStateDeltaEvent(bareType: string): boolean {
  return STATE_DELTA_NAME_SET.has(bareType);
}

/* ── tolerant field readers (snake_case AND camelCase) ─────────────────────*/

type Fields = Record<string, unknown>;

const rec = (v: unknown): Fields =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Fields) : {};
const asStr = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const asNum = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;
const asBool = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined);

/** Read `camel` first (persisted AgentEvent bodies), then `snake` (SSE wire). */
const pick = (r: Fields, camel: string, snake: string): unknown => r[camel] ?? r[snake];

export const stateKey = (r: Fields): string | undefined => asStr(r.key);
export const stateOrigin = (r: Fields): StateOrigin =>
  r.origin === "innate" ? "innate" : "explicit";
export const stateOrdinal = (r: Fields): number | undefined => asNum(r.ordinal);
export const stateToolCallId = (r: Fields): string | undefined =>
  asStr(pick(r, "toolCallId", "tool_call_id"));
export const stateNum = (r: Fields, camel: string, snake: string): number | undefined =>
  asNum(pick(r, camel, snake));
export const stateStr = (r: Fields, camel: string, snake: string): string | undefined =>
  asStr(pick(r, camel, snake));
export const stateBool = (r: Fields, camel: string, snake: string): boolean | undefined =>
  asBool(pick(r, camel, snake));

export function stateNumArray(r: Fields, camel: string, snake: string): number[] {
  const raw = pick(r, camel, snake);
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
}

export function stateStrArray(r: Fields, camel: string, snake: string): string[] {
  const raw = pick(r, camel, snake);
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is string => typeof v === "string");
}

/** Parse the byte-capped row previews of a drop frame (shape-checked per row). */
export function statePreviews(r: Fields): StateRowPreview[] {
  const raw = r.previews;
  if (!Array.isArray(raw)) return [];
  const out: StateRowPreview[] = [];
  for (const item of raw) {
    const row = rec(item);
    const index = asNum(row.index);
    if (index == null) continue;
    out.push({
      index,
      op: row.op === "merged" ? "merged" : "added",
      preview: asStr(row.preview) ?? "",
    });
  }
  return out;
}

/** Parse the per-BackpackSpec display metadata, dropping empty shells. */
export function stateDisplay(r: Fields): StateDisplay | undefined {
  const d = rec(r.display);
  const caption = asStr(d.caption);
  const attribution = asStr(d.attribution);
  if (!caption && !attribution) return undefined;
  const out: StateDisplay = {};
  if (caption) out.caption = caption;
  if (attribution) out.attribution = attribution;
  return out;
}

/* ── the builder both folds share ───────────────────────────────────────────*/

/**
 * Build the `state_delta` Part for one state event. `bareType` is the wire
 * name without the `agent.` prefix (`backpack.drop`, `scratchpad.write`, …);
 * `r` is the flat field record in ANY of the three tolerated shapes. Returns
 * `null` for non-state types or events missing their identity (`key`).
 */
export function stateDeltaFromFields(bareType: string, r: Fields): StateDeltaPart | null {
  const origin = stateOrigin(r);
  const ordinal = stateOrdinal(r);
  const toolCallId = stateToolCallId(r);
  const base = {
    kind: "state_delta" as const,
    origin,
    ...(ordinal != null ? { ordinal } : {}),
    ...(toolCallId != null ? { toolCallId } : {}),
  };

  switch (bareType) {
    case "backpack.drop": {
      const key = stateKey(r);
      if (!key) return null;
      const display = stateDisplay(r);
      const tag = asStr(r.tag);
      return {
        ...base,
        op: "drop",
        key,
        accepted: stateNum(r, "accepted", "accepted") ?? 0,
        merged: stateNum(r, "merged", "merged") ?? 0,
        skipped: stateNum(r, "skipped", "skipped") ?? 0,
        indexes: stateNumArray(r, "indexes", "indexes"),
        sizeBefore: stateNum(r, "sizeBefore", "size_before") ?? 0,
        sizeAfter: stateNum(r, "sizeAfter", "size_after") ?? 0,
        previews: statePreviews(r),
        previewsOmitted: stateNum(r, "previewsOmitted", "previews_omitted") ?? 0,
        ...(tag != null ? { tag } : {}),
        ...(display ? { display } : {}),
      };
    }
    case "backpack.read": {
      const key = stateKey(r);
      if (!key) return null;
      const display = stateDisplay(r);
      const size = stateNum(r, "size", "size");
      const preview = asStr(r.preview);
      return {
        ...base,
        op: "read",
        key,
        scope: "backpack",
        memoHit: stateBool(r, "memoHit", "memo_hit") ?? false,
        ...(size != null ? { size } : {}),
        ...(preview != null ? { preview } : {}),
        ...(display ? { display } : {}),
      };
    }
    case "backpack.absorb": {
      const key = stateKey(r);
      if (!key) return null;
      const display = stateDisplay(r);
      return {
        ...base,
        op: "absorb",
        key,
        childSize: stateNum(r, "childSize", "child_size") ?? 0,
        accepted: stateNum(r, "accepted", "accepted") ?? 0,
        merged: stateNum(r, "merged", "merged") ?? 0,
        sizeBefore: stateNum(r, "sizeBefore", "size_before") ?? 0,
        sizeAfter: stateNum(r, "sizeAfter", "size_after") ?? 0,
        appendedIndexes: stateNumArray(r, "appendedIndexes", "appended_indexes"),
        ...(display ? { display } : {}),
      };
    }
    case "scratchpad.write": {
      const key = stateKey(r);
      if (!key) return null;
      const before = asStr(r.before);
      return {
        ...base,
        op: "write",
        key,
        writeOp: r.op === "update" ? "update" : "set",
        hadValue: stateBool(r, "hadValue", "had_value") ?? false,
        ...(before != null ? { before } : {}),
        after: asStr(r.after) ?? "",
      };
    }
    case "scratchpad.read": {
      const key = stateKey(r);
      if (!key) return null;
      const preview = asStr(r.preview);
      const redacted = stateBool(r, "previewRedacted", "preview_redacted");
      return {
        ...base,
        op: "read",
        key,
        scope: "scratchpad",
        ...(preview != null ? { preview } : {}),
        ...(redacted ? { previewRedacted: true } : {}),
      };
    }
    case "scratchpad.fork":
      return { ...base, op: "fork", sharedKeys: stateStrArray(r, "sharedKeys", "shared_keys") };
    case "scratchpad.join":
      return {
        ...base,
        op: "join",
        mergedKeys: stateStrArray(r, "mergedKeys", "merged_keys"),
        discardedKeys: stateStrArray(r, "discardedKeys", "discarded_keys"),
      };
    default:
      return null;
  }
}

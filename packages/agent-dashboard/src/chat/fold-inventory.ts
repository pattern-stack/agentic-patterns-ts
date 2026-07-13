/**
 * foldInventory (#226) — the Scratchpad rail's pure fold.
 *
 * `foldInventory(events, cursor)` folds `events[0..cursor)` into the rail's
 * cumulative inventory snapshot: what the run carries right now (packs, stage
 * outputs, kept values), plus receipt reconciliation for the health footer.
 * Pure and stateless — scrubbing re-materializes state at any cursor, and the
 * RailDelta motion contract is a function of
 * `diff(fold(0..cursor-1), fold(0..cursor))`, never rail-local state.
 *
 * Field reading goes through the SHARED accessor module (`state-accessors.ts`,
 * also consumed by `chat/model.ts`'s `applyParts`) so the rail and the
 * timeline can never drift on how a wire field is read. Tolerates all three
 * wire shapes (live SSE snake_case, persisted camelCase bodies, run-history
 * rows with `payload_json`) exactly like `graph/trace-from-events.ts`.
 *
 * Browser-bundled and dependency-free — no runtime/server imports.
 */
import type { EventLike } from "../graph/trace-from-events";
import { type StateDeltaPart, type StateDisplay, stateDeltaFromFields } from "./state-accessors";

/* ── snapshot model ─────────────────────────────────────────────────────────*/

/** One canonical [#N] entry in a pack's ledger (known via drop previews). */
export interface EvidenceEntry {
  index: number;
  /** Latest rendered line for this entry (absent when the preview budget cut it). */
  preview?: string;
  /** 0-based per-pack DropRecord ordinal that minted this index. */
  mintedDrop: number;
  /** Tool that minted it, when the drop happened inside a tool dispatch. */
  mintedVia?: string;
  mintedTag?: string;
  /** Merge history — one line per later drop that folded into this index. */
  merges: string[];
}

/** One DropRecord (a `drop()` or branch `absorb()`) in arrival order. */
export interface DropRecordSummary {
  /** 0-based per-pack ordinal — the mono `drop #N` join key with the timeline. */
  seq: number;
  kind: "drop" | "absorb";
  /** Indexes this record covers (touched by a drop / appended by an absorb). */
  covered: number;
  accepted: number;
  merged: number;
  skipped: number;
  sizeBefore: number;
  sizeAfter: number;
  via?: string;
  tag?: string;
  ordinal?: number;
}

/** A backpack's cumulative state — one hero row on the rail. */
export interface PackSnapshot {
  key: string;
  /** Current pack size — the focal numeral. */
  size: number;
  records: DropRecordSummary[];
  merged: number;
  skipped: number;
  entries: EvidenceEntry[];
  display?: StateDisplay;
  lastWriteOrdinal?: number;
  /** Every receipt reconciles (per-record size math + record chaining). */
  reconciled: boolean;
  /** Final size the receipts add up to (== `size` when reconciled). */
  expectedSize: number;
  /** First record whose receipt math breaks — the mismatch seek target. */
  divergence?: { seq: number; expected: number; actual: number };
}

/** One pipeline stage — chain segment + (behind the chevron) stage row. */
export interface StageSnapshot {
  name: string;
  status: "done" | "current" | "failed";
  /** The framework saved `agents.<name>` (the innate stage emission landed). */
  saved: boolean;
  /** The saved output was injected into a later stage's prompt. */
  promptRead: boolean;
  ordinal?: number;
}

/** One explicitly-kept value (agent-code scratchpad write) — a quiet slot row. */
export interface SlotSnapshot {
  key: string;
  value: string;
  writeOp: "set" | "update";
  ordinal?: number;
}

export type RailSection = "evidence" | "stages" | "kept";

export interface InventorySnapshot {
  packs: PackSnapshot[];
  /** Latest event-carried display metadata (per-BackpackSpec caption override). */
  packsDisplay?: StateDisplay;
  stages: StageSnapshot[];
  /** Stages whose innate emission landed — the "N/M saved" numerator. */
  savedCount: number;
  slots: SlotSnapshot[];
  /** Total DropRecords across packs — "rebuilt from N drop receipts". */
  dropReceipts: number;
  /** State WRITE events folded (drop/absorb/scratchpad.write). */
  writeCount: number;
  /** Any state event folded at all? False → the teaching empty state. */
  empty: boolean;
  health: {
    ok: boolean;
    /** First diverging pack, when !ok — feeds the loud footer + its seek. */
    mismatch?: { key: string; recordSeq: number; expected: number; actual: number };
  };
  /** The most recent write — the recency tick's target. */
  lastWrite?: { section: RailSection; key: string; ordinal: number };
}

/* ── tolerant field plumbing (same discrimination as chat/model.ts) ─────────*/

type Fields = Record<string, unknown>;

const rec = (v: unknown): Fields =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Fields) : {};
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const safeJson = (s: unknown): unknown => {
  try {
    return typeof s === "string" ? JSON.parse(s) : undefined;
  } catch {
    return undefined;
  }
};

/** Strip the `agent.` / `pattern.` namespace so live + persisted types unify. */
const bare = (t: string): string => t.replace(/^(agent|pattern)\./, "");

/** Merge both wire shapes into one flat field record (col ∪ payload). */
function flatFields(e: EventLike): Fields {
  const isRow = typeof e.payload_json === "string" || "run_id" in e;
  const col = e as Fields;
  const p = isRow ? rec(safeJson(e.payload_json) ?? {}) : col;
  return isRow ? { ...col, ...p } : col;
}

const stepNameOf = (r: Fields): string | undefined => str(r.step_name) ?? str(r.stepName);
const parentSpanOf = (r: Fields): string | undefined =>
  str(r.parent_span_id) ?? str(r.parentSpanId);
const toolCallIdOf = (r: Fields): string | undefined => str(r.tool_call_id) ?? str(r.toolCallId);
const toolNameOf = (r: Fields): string | undefined => str(r.tool_name) ?? str(r.toolName);

/* ── the fold ───────────────────────────────────────────────────────────────*/

interface PackAcc {
  key: string;
  size: number;
  records: DropRecordSummary[];
  merged: number;
  skipped: number;
  entries: Map<number, EvidenceEntry>;
  display?: StateDisplay;
  lastWriteOrdinal?: number;
  reconciled: boolean;
  expectedSize: number;
  divergence?: { seq: number; expected: number; actual: number };
}

/**
 * Fold `events[0..cursor)` into the rail's inventory snapshot. `cursor`
 * defaults to the full stream (the live edge). Non-state events contribute
 * only stage boundaries (`step.start/end`) and tool-name resolution
 * (`tool.start/intent`) — everything else is ignored.
 */
export function foldInventory(events: EventLike[], cursor?: number): InventorySnapshot {
  const upTo = Math.max(0, Math.min(cursor ?? events.length, events.length));

  // ── pre-pass: which packs fan in via absorb (branch-scoped under FanOut)? ──
  // Branch drops carry NO pad/branch discriminator on the wire (WI-1), yet a
  // branch-scoped `backpackSlot(spec, { scope: "branch" })` gives every FanOut
  // branch a FRESH pack emitting drops on the SAME key, each restarting at
  // sizeBefore=0. Folding those into the parent chain would clobber the ledger
  // and trip a false "receipts disagree" (the rail's only loud state) on every
  // healthy parallel run. Only a branch fan-in ever emits `backpack.absorb`,
  // so an absorb anywhere in the folded window marks its key as fanning in.
  const fanInKeys = new Set<string>();
  for (let i = 0; i < upTo; i += 1) {
    const e = events[i];
    if (!e || bare(String(e.type)) !== "backpack.absorb") continue;
    const key = str(flatFields(e).key);
    if (key) fanInKeys.add(key);
  }

  const packs = new Map<string, PackAcc>();
  let packsDisplay: StateDisplay | undefined;
  const stages: StageSnapshot[] = [];
  const stageByName = new Map<string, StageSnapshot>();
  const slots = new Map<string, SlotSnapshot>();
  const toolNames = new Map<string, string>();
  let writeCount = 0;
  let sawStateEvent = false;
  let lastWrite: InventorySnapshot["lastWrite"];
  let syntheticOrdinal = 0; // fallback when an event carries no ordinal
  let forkDepth = 0; // scratchpad.fork/join nesting — drops inside may be branch-pad writes

  const pack = (key: string): PackAcc => {
    let acc = packs.get(key);
    if (!acc) {
      acc = {
        key,
        size: 0,
        records: [],
        merged: 0,
        skipped: 0,
        entries: new Map(),
        reconciled: true,
        expectedSize: 0,
      };
      packs.set(key, acc);
    }
    return acc;
  };

  const stage = (name: string): StageSnapshot => {
    let s = stageByName.get(name);
    if (!s) {
      s = { name, status: "done", saved: false, promptRead: false };
      stageByName.set(name, s);
      stages.push(s);
    }
    return s;
  };

  const markWrite = (section: RailSection, key: string, ordinal: number | undefined): number => {
    writeCount += 1;
    const ord = ordinal ?? ++syntheticOrdinal;
    syntheticOrdinal = Math.max(syntheticOrdinal, ord);
    if (!lastWrite || ord >= lastWrite.ordinal) lastWrite = { section, key, ordinal: ord };
    return ord;
  };

  /** Receipt reconciliation: per-record size math + record chaining. */
  const reconcile = (acc: PackAcc, record: DropRecordSummary): void => {
    const prev = acc.records[acc.records.length - 2];
    const chainedBefore = prev ? prev.sizeAfter : record.sizeBefore;
    const expected = chainedBefore + record.accepted;
    acc.expectedSize = expected;
    if (
      acc.reconciled &&
      (record.sizeAfter !== record.sizeBefore + record.accepted ||
        record.sizeBefore !== chainedBefore)
    ) {
      acc.reconciled = false;
      acc.divergence = { seq: record.seq, expected, actual: record.sizeAfter };
    }
  };

  const foldFrame = (frame: StateDeltaPart, via: string | undefined): void => {
    sawStateEvent = true;
    switch (frame.op) {
      case "drop": {
        // Branch-pad drops (FanOut fan-out) fold OUT of the parent pack: the
        // join's absorb records are the authoritative fan-in, and the branch's
        // local [#N] indexes don't map onto the parent's. Two signals, either
        // sufficient inside a fork window: the key is known to fan in via
        // absorb (pre-pass above), or the drop's sizeBefore breaks the parent
        // chain (a fresh branch pack restarting at 0). Mid-stream (cursor
        // before the joins) only the chain-break heuristic fires — the first
        // branch's drop may fold transiently as the parent, which self-corrects
        // once the absorbs land, without ever tripping a false mismatch.
        const prior = packs.get(frame.key);
        const tail = prior?.records[prior.records.length - 1];
        if (
          forkDepth > 0 &&
          (fanInKeys.has(frame.key) || (tail !== undefined && frame.sizeBefore !== tail.sizeAfter))
        ) {
          // Still a real state write (counted, recency-ticked) — just not a
          // parent-pack record/ledger entry.
          markWrite("evidence", frame.key, frame.ordinal);
          return;
        }
        const acc = pack(frame.key);
        const seq = acc.records.length;
        const record: DropRecordSummary = {
          seq,
          kind: "drop",
          covered: frame.indexes.length,
          accepted: frame.accepted,
          merged: frame.merged,
          skipped: frame.skipped,
          sizeBefore: frame.sizeBefore,
          sizeAfter: frame.sizeAfter,
          ...(via !== undefined ? { via } : {}),
          ...(frame.tag !== undefined ? { tag: frame.tag } : {}),
          ...(frame.ordinal !== undefined ? { ordinal: frame.ordinal } : {}),
        };
        acc.records.push(record);
        acc.size = frame.sizeAfter;
        acc.merged += frame.merged;
        acc.skipped += frame.skipped;
        if (frame.display) {
          acc.display = frame.display;
          packsDisplay = frame.display;
        }
        for (const row of frame.previews) {
          const existing = acc.entries.get(row.index);
          if (row.op === "added" || !existing) {
            acc.entries.set(row.index, {
              index: row.index,
              ...(row.preview ? { preview: row.preview } : {}),
              mintedDrop: existing?.mintedDrop ?? seq,
              ...(existing?.mintedVia !== undefined
                ? { mintedVia: existing.mintedVia }
                : via !== undefined
                  ? { mintedVia: via }
                  : {}),
              ...(existing?.mintedTag !== undefined
                ? { mintedTag: existing.mintedTag }
                : frame.tag !== undefined
                  ? { mintedTag: frame.tag }
                  : {}),
              merges: existing?.merges ?? [],
            });
          } else {
            existing.merges.push(
              `×1 — re-surfaced${via ? ` by ${via}` : ""} (drop #${seq})${
                row.preview ? ` · ${row.preview}` : ""
              }`,
            );
          }
        }
        // Indexes minted without a preview still get a ledger row (honest,
        // preview-less) so the ledger count matches the receipt.
        for (const index of frame.indexes) {
          if (index > frame.sizeBefore && !acc.entries.has(index)) {
            acc.entries.set(index, {
              index,
              mintedDrop: seq,
              ...(via !== undefined ? { mintedVia: via } : {}),
              ...(frame.tag !== undefined ? { mintedTag: frame.tag } : {}),
              merges: [],
            });
          }
        }
        acc.lastWriteOrdinal = markWrite("evidence", frame.key, frame.ordinal);
        reconcile(acc, record);
        return;
      }
      case "absorb": {
        const acc = pack(frame.key);
        const seq = acc.records.length;
        const record: DropRecordSummary = {
          seq,
          kind: "absorb",
          covered: frame.appendedIndexes.length,
          accepted: frame.accepted,
          merged: frame.merged,
          skipped: 0,
          sizeBefore: frame.sizeBefore,
          sizeAfter: frame.sizeAfter,
          ...(via !== undefined ? { via } : {}),
          ...(frame.ordinal !== undefined ? { ordinal: frame.ordinal } : {}),
        };
        acc.records.push(record);
        acc.size = frame.sizeAfter;
        acc.merged += frame.merged;
        if (frame.display) {
          acc.display = frame.display;
          packsDisplay = frame.display;
        }
        for (const index of frame.appendedIndexes) {
          if (!acc.entries.has(index)) {
            acc.entries.set(index, {
              index,
              mintedDrop: seq,
              ...(via !== undefined ? { mintedVia: via } : {}),
              merges: [],
            });
          }
        }
        acc.lastWriteOrdinal = markWrite("evidence", frame.key, frame.ordinal);
        reconcile(acc, record);
        return;
      }
      case "write": {
        if (frame.origin === "innate" && frame.key.startsWith("agents.")) {
          const s = stage(frame.key.slice("agents.".length));
          s.saved = true;
          if (frame.ordinal !== undefined) s.ordinal = frame.ordinal;
          markWrite("stages", frame.key, frame.ordinal);
        } else {
          slots.set(frame.key, {
            key: frame.key,
            value: frame.after,
            writeOp: frame.writeOp,
            ...(frame.ordinal !== undefined ? { ordinal: frame.ordinal } : {}),
          });
          markWrite("kept", frame.key, frame.ordinal);
        }
        return;
      }
      case "read": {
        if (
          frame.scope === "scratchpad" &&
          frame.origin === "innate" &&
          frame.key.startsWith("agents.")
        ) {
          stage(frame.key.slice("agents.".length)).promptRead = true;
        }
        return;
      }
      // fork/join move nothing themselves, but they bound the branch windows
      // the drop case above needs to fold branch-pad records out of the
      // parent chain (both are relayed live AND persisted — see
      // RELAYED_STREAM_EVENTS / conversation.ts).
      case "fork":
        forkDepth += 1;
        return;
      case "join":
        forkDepth = Math.max(0, forkDepth - 1);
        return;
      // travel is UI-derived (model.ts) — it never arrives on the wire.
      default:
        return;
    }
  };

  for (let i = 0; i < upTo; i += 1) {
    const e = events[i];
    if (!e) continue;
    const type = bare(String(e.type));
    const r = flatFields(e);

    if (type === "tool.start" || type === "tool.intent") {
      const id = toolCallIdOf(r);
      const name = toolNameOf(r);
      if (id && name) toolNames.set(id, name);
      continue;
    }
    if (type === "step.start") {
      // Only TOP-LEVEL stages form the chain (nested sub-steps carry a parent).
      if (parentSpanOf(r) == null) {
        const name = stepNameOf(r);
        if (name) {
          for (const s of stages) if (s.status === "current") s.status = "done";
          stage(name).status = "current";
        }
      }
      continue;
    }
    if (type === "step.end") {
      if (parentSpanOf(r) == null) {
        const name = stepNameOf(r);
        if (name) stage(name).status = str(r.error) ? "failed" : "done";
      }
      continue;
    }

    const frame = stateDeltaFromFields(type, r);
    if (!frame) continue;
    const via = frame.toolCallId !== undefined ? toolNames.get(frame.toolCallId) : undefined;
    foldFrame(frame, via);
  }

  const packList = [...packs.values()].map(
    (acc): PackSnapshot => ({
      key: acc.key,
      size: acc.size,
      records: acc.records,
      merged: acc.merged,
      skipped: acc.skipped,
      entries: [...acc.entries.values()].sort((a, b) => a.index - b.index),
      ...(acc.display ? { display: acc.display } : {}),
      ...(acc.lastWriteOrdinal !== undefined ? { lastWriteOrdinal: acc.lastWriteOrdinal } : {}),
      reconciled: acc.reconciled,
      expectedSize: acc.expectedSize,
      ...(acc.divergence ? { divergence: acc.divergence } : {}),
    }),
  );

  const firstBad = packList.find((p) => !p.reconciled);
  return {
    packs: packList,
    ...(packsDisplay ? { packsDisplay } : {}),
    stages,
    savedCount: stages.filter((s) => s.saved).length,
    slots: [...slots.values()],
    dropReceipts: packList.reduce((n, p) => n + p.records.length, 0),
    writeCount,
    empty: !sawStateEvent,
    health: {
      ok: !firstBad,
      ...(firstBad?.divergence
        ? {
            mismatch: {
              key: firstBad.key,
              recordSeq: firstBad.divergence.seq,
              expected: firstBad.divergence.expected,
              actual: firstBad.divergence.actual,
            },
          }
        : {}),
    },
    ...(lastWrite ? { lastWrite } : {}),
  };
}

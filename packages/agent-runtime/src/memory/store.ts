/**
 * MemoryStore — cross-session memory persistence protocol + in-memory impl.
 *
 * Implements [ADR-0007](../../../../docs/adr/0007-memory-store.md) Decisions
 * 3–6: subset-match scope filtering, invalidation chains (curation, not
 * destruction), relevance-ordered search with declared capabilities, and the
 * structural store protocol. Modeled on the ConversationStore pattern
 * (`conversation/store.ts`): structural protocol interface with the in-memory
 * reference implementation beside it in one file.
 *
 * Promotion ops (`promote`/`demote`/`corroborate`) are ADR-0008 Phase B and
 * deliberately absent from this protocol.
 */

import {
  type MemoryHit,
  MemoryKindSchema,
  type MemoryRecord,
  type MemoryScope,
  MemoryScopeSchema,
  type MemorySearchQueryInput,
  MemorySearchQuerySchema,
  type MemoryStoreCapabilities,
  MemoryTargetSchema,
  ProvenanceSchema,
  memoryRecord,
} from "@agentic-patterns/core";
import { z } from "zod";
import { tokenize } from "./tokenize.js";

// ---------------------------------------------------------------------------
// ID generation (local copy of the conversation/store.ts pattern)
// ---------------------------------------------------------------------------

let _counter = 0;
function generateId(): string {
  if (typeof globalThis !== "undefined" && "crypto" in globalThis) {
    return (globalThis as unknown as { crypto: { randomUUID(): string } }).crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${(++_counter).toString(36)}`;
}

// ---------------------------------------------------------------------------
// Write input
// ---------------------------------------------------------------------------

/**
 * What a caller may supply on write — the issue-pinned shape. The store
 * assigns `id`, `createdAt`, `updatedAt`; everything lifecycle-owned
 * (invalidAt, supersededBy, expiresAt, supports) is NOT writable here.
 */
export const MemoryWriteInputSchema = z.object({
  scope: MemoryScopeSchema,
  kind: MemoryKindSchema,
  content: z.string().min(1),
  tags: z.array(z.string().min(1)).optional(),
  provenance: ProvenanceSchema.optional(),
  target: MemoryTargetSchema.optional(),
  payload: z.unknown().optional(),
  /** Id of the record this write corrects — atomically invalidated (ADR-0007 D4). */
  supersedes: z.string().min(1).optional(),
});
export type MemoryWriteInput = z.infer<typeof MemoryWriteInputSchema>;

// ---------------------------------------------------------------------------
// Protocol
// ---------------------------------------------------------------------------

/** Cross-session memory persistence protocol — ADR-0007 D6. All methods async (issue pin). */
export interface MemoryStore {
  /**
   * Batch write; returns the created records in input order. The store assigns
   * id + createdAt/updatedAt (equal at birth). All-or-nothing: any invalid
   * input or unknown `supersedes` id rejects the whole batch with no mutation.
   *
   * A `supersedes` write invalidates the old record atomically with the new
   * one (ADR-0007 D4): the old record gets `invalidAt = now`,
   * `supersededBy = <new record id>`, `updatedAt = now` — the same instant as
   * the new record's `createdAt`.
   */
  write(inputs: MemoryWriteInput[]): Promise<MemoryRecord[]>;

  /**
   * Relevance-ordered search (ADR-0007 D5). Accepts the pre-parse query shape;
   * implementations MUST apply MemorySearchQuerySchema defaults
   * (limit 10, includeInvalidated false). `query` absent ⇒ filtered,
   * recency-ordered listing (createdAt descending). A present-but-blank `query`
   * (e.g. `" "`) is a query, not an absence — it is not the recency listing, and
   * a keyword backend that tokenizes it to nothing matches nothing. Ordering is
   * the contract; `score` is backend-advisory and never part of it.
   *
   * Scope filtering is subset-match (ADR-0007 D3): a record matches when
   * `record.scope[k] === filter[k]` for EVERY key in the filter. The empty
   * filter `{}` matches every record — legal and deliberate, but powerful and
   * easy to misuse (ADR-0007 consequences); the agent toolbox never exposes
   * it. `tags` is symmetric subset semantics: a record must carry every
   * queried tag. Invalidated records are excluded unless
   * `includeInvalidated: true`; expired records (`expiresAt <= now`) are
   * excluded unconditionally. `limit: 0` returns `[]` — zero means zero.
   */
  search(query: MemorySearchQueryInput): Promise<MemoryHit[]>;

  /** By id; null if unknown. Returns invalidated and expired records (host management). */
  get(id: string): Promise<MemoryRecord | null>;

  /**
   * Curation, not destruction (ADR-0007 D4): sets invalidAt (+ bumps updatedAt —
   * the ONLY operation that touches updatedAt). Rejects if id unknown.
   * Idempotent: already-invalidated ⇒ no-op (updatedAt unchanged).
   * `reason` is accepted and unrecorded in v1 — reserved for the memory
   * events issue; backends may audit-log it.
   */
  invalidate(id: string, reason?: string): Promise<void>;

  /** True forgetting (privacy/host cleanup) — never exposed to the agent toolbox. Idempotent: unknown id resolves silently. */
  delete(id: string): Promise<void>;

  /** What this backend can do — declared, not probed (ADR-0007 D5). */
  capabilities(): Promise<MemoryStoreCapabilities>;
}

// ---------------------------------------------------------------------------
// InMemoryMemoryStore
// ---------------------------------------------------------------------------

/** True when `record.scope[k] === filter[k]` for every key in the filter (ADR-0007 D3). */
function scopeMatches(scope: MemoryScope, filter: MemoryScope): boolean {
  return Object.entries(filter).every(([key, value]) => scope[key] === value);
}

/** Descending ISO-string compare — store-assigned timestamps are `toISOString()` (UTC, fixed width), so plain string comparison is chronological. */
function byCreatedAtDesc(a: MemoryRecord, b: MemoryRecord): number {
  return a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0;
}

/**
 * In-memory reference implementation — dev/CI/tests. Keyword search only.
 *
 * Match semantics are {@link tokenize}'s, shared verbatim with
 * {@link SqliteMemoryStore} (ADR-0009 D-3 / Decision 13). This store used to
 * score with `haystack.includes(token)`, which made `"am"` hit `"name"` and
 * `"prefer"` hit `"Prefers"` here and nowhere else; that divergence is gone and
 * the conformance kit's Tier 2 keeps it gone.
 */
export class InMemoryMemoryStore implements MemoryStore {
  /**
   * Insertion-ordered. Insertion position is this backend's `seq` — the
   * batch-tie discriminator, pinned by conformance Tier 1: both stores assign
   * ONE `now` per batch, so `write([a,b,c])` produces three records with
   * identical `createdAt`, and the tie resolves by insertion position
   * DESCENDING (last written is newest) to match `sqlite-store.ts`'s
   * `ORDER BY … m.seq DESC`. `Map.set` on an existing key preserves the
   * original position, so a supersede-update keeps its seq exactly as SQLite's
   * `UPDATE` does.
   */
  private records = new Map<string, MemoryRecord>();

  async write(inputs: MemoryWriteInput[]): Promise<MemoryRecord[]> {
    const now = new Date().toISOString(); // one `now` per batch

    // Phase 1 — validate everything: parse each input, construct each record
    // via core's memoryRecord() (canonical scope + payload-vs-target
    // validation + deep-freeze), resolve each supersedes id. Any failure
    // throws here, before any mutation.
    const staged: Array<{ record: MemoryRecord; supersedes?: string }> = [];
    for (const input of inputs) {
      const parsed = MemoryWriteInputSchema.parse(input);
      const record = memoryRecord({
        id: generateId(),
        scope: parsed.scope,
        kind: parsed.kind,
        content: parsed.content,
        ...(parsed.tags !== undefined ? { tags: parsed.tags } : {}),
        ...(parsed.provenance !== undefined ? { provenance: parsed.provenance } : {}),
        ...(parsed.target !== undefined ? { target: parsed.target } : {}),
        ...(parsed.payload !== undefined ? { payload: parsed.payload } : {}),
        createdAt: now,
        updatedAt: now,
      });
      if (parsed.supersedes !== undefined && !this.records.has(parsed.supersedes)) {
        throw new Error(`Memory record not found: ${parsed.supersedes}`);
      }
      staged.push(
        parsed.supersedes !== undefined ? { record, supersedes: parsed.supersedes } : { record },
      );
    }

    // Phase 2 — commit: store new records, then invalidate superseded ones
    // atomically with the write (ADR-0007 D4).
    const created: MemoryRecord[] = [];
    for (const { record, supersedes } of staged) {
      this.records.set(record.id, record);
      created.push(record);
      if (supersedes !== undefined) {
        const old = this.records.get(supersedes);
        if (old !== undefined) {
          // Already-invalidated old record: keep its original invalidAt,
          // set/overwrite supersededBy, bump updatedAt (impl note — the
          // conformance kit does not pin this edge).
          this.records.set(
            old.id,
            memoryRecord({
              ...old,
              invalidAt: old.invalidAt ?? now,
              supersededBy: record.id,
              updatedAt: now,
            }),
          );
        }
      }
    }
    return created;
  }

  async search(query: MemorySearchQueryInput): Promise<MemoryHit[]> {
    const q = MemorySearchQuerySchema.parse(query);
    const now = new Date().toISOString();

    // `.reverse()` FIRST, then a stable sort: every ordering below falls back
    // to insertion position DESCENDING, which is this backend's `seq DESC`
    // (see the `records` docblock). Reversing the base array and relying on
    // ES2019's stable sort is equivalent to carrying a seq column and cannot
    // desync from it.
    const filtered = [...this.records.values()].reverse().filter((record) => {
      if (!scopeMatches(record.scope, q.scope)) return false;
      if (q.kinds !== undefined && !q.kinds.includes(record.kind)) return false;
      // Tags are subset semantics, symmetric with scope: the record must carry
      // every queried tag (an untagged record matches only an absent/empty filter).
      if (q.tags !== undefined && !q.tags.every((tag) => (record.tags ?? []).includes(tag)))
        return false;
      if (!q.includeInvalidated && record.invalidAt !== undefined) return false;
      // Expired records are excluded unconditionally (ADR-0007 known limits:
      // "stored and filtered on read"). Untestable through this protocol —
      // MemoryWriteInput cannot set expiresAt — but implemented for forward
      // parity with backends whose rows can be written by host SQL.
      if (record.expiresAt !== undefined && record.expiresAt <= now) return false;
      return true;
    });

    let hits: MemoryHit[];
    if (q.query === undefined) {
      // Recency listing: createdAt descending; ties resolve by insertion
      // position descending (the reversed base array + stable sort).
      hits = [...filtered].sort(byCreatedAtDesc).map((record) => ({ record }));
    } else {
      // WHOLE-TOKEN matching over the shared tokenizer (ADR-0009 D-3) — never
      // `haystack.includes(token)`, which made this backend the only one where
      // `"am"` hit `"name"`. A blank-but-present query tokenizes to `[]` ⇒
      // every score is 0 ⇒ no hits, which is the pinned semantics.
      const tokens = tokenize(q.query);
      hits = filtered
        .map((record) => {
          const haystack = new Set(tokenize(`${record.content} ${(record.tags ?? []).join(" ")}`));
          const score = tokens.filter((token) => haystack.has(token)).length;
          return { record, score };
        })
        .filter((hit) => hit.score > 0)
        .sort((a, b) =>
          a.score !== b.score ? b.score - a.score : byCreatedAtDesc(a.record, b.record),
        );
    }

    // Limit applies after filtering + ordering. `limit: 0` ⇒ `[]` — zero means
    // zero (falls out of slice, kept explicit here as the pinned semantics).
    return hits.slice(0, q.limit);
  }

  async get(id: string): Promise<MemoryRecord | null> {
    return this.records.get(id) ?? null;
  }

  async invalidate(id: string, _reason?: string): Promise<void> {
    const old = this.records.get(id);
    if (old === undefined) {
      throw new Error(`Memory record not found: ${id}`);
    }
    if (old.invalidAt !== undefined) return; // idempotent — updatedAt unchanged
    const now = new Date().toISOString();
    this.records.set(id, memoryRecord({ ...old, invalidAt: now, updatedAt: now }));
  }

  async delete(id: string): Promise<void> {
    this.records.delete(id); // idempotent — unknown id resolves silently
  }

  async capabilities(): Promise<MemoryStoreCapabilities> {
    return { search: "keyword" };
  }
}

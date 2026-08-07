/**
 * Memory record molecules — the memory **data contract** described by
 * [ADR-0007](../../../../docs/adr/0007-memory-store.md) (Decisions 2, 3, 5, 7)
 * and [ADR-0008](../../../../docs/adr/0008-compositional-memory.md)
 * (Decision 1, target union shape only).
 *
 * Pure data: Zod schemas, inferred types, one deep-freezing factory, and
 * payload-shape validation for structured targets. Zero I/O, zero runtime
 * imports, zero behavior beyond validation and freezing. Runtime stores
 * (`MemoryStore` and friends) and external backends type against
 * `MemoryRecord` without importing runtime.
 *
 * All timestamps in this module are ISO 8601 **plain strings** — validated as
 * non-empty strings, not parsed. Deliberately absent (ADR-0007 D7,
 * field-consensus regret): confidence, salience, decay, embedding fields.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

/** Flat string map partition key; subset-match semantics live in the store (ADR-0007 D3). */
export const MemoryScopeSchema = z.record(z.string(), z.string());

export type MemoryScope = z.infer<typeof MemoryScopeSchema>;

/** Frozen copy with keys sorted lexicographically — ADR-0007 D3 "stored canonically". */
export function canonicalMemoryScope(scope: MemoryScope): MemoryScope {
  return Object.freeze(
    Object.fromEntries(Object.entries(scope).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
  );
}

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

/**
 * Where a memory came from. Every field optional — provenance is best-effort.
 *
 * `at` is an ISO 8601 timestamp string. It is present on corroboration
 * entries (`supports`, ADR-0008 D4) and optional on record provenance.
 */
export const ProvenanceSchema = z.object({
  conversationId: z.string().optional(),
  runId: z.string().optional(),
  author: z.string().optional(),
  /** ISO 8601. Present on corroboration entries (`supports`); optional on record provenance. */
  at: z.string().optional(),
});

export type Provenance = z.infer<typeof ProvenanceSchema>;

// ---------------------------------------------------------------------------
// MemoryTarget (ADR-0008 Decision 1 — full union, including guarded arms)
// ---------------------------------------------------------------------------

/** Targets a keyed entry in a Background section (open tier). */
export const BackgroundTargetSchema = z.object({
  primitive: z.literal("background"),
  section: z.enum(["teamContext", "projectContext", "conventions", "currentState"]),
  key: z.string().min(1),
});

/** Targets a Judgment slot; `constraints`/`escalationTriggers` are guarded-tier. */
export const JudgmentTargetSchema = z.object({
  primitive: z.literal("judgment"),
  domain: z.string().min(1),
  slot: z.enum(["heuristics", "constraints", "escalationTriggers"]),
});

/** Targets a new Example under a judgment domain (structured payload required to promote). */
export const ExampleTargetSchema = z.object({
  primitive: z.literal("example"),
  judgmentDomain: z.string().min(1),
});

/** Targets a new AwarenessDomain (structured payload required to promote). */
export const AwarenessTargetSchema = z.object({ primitive: z.literal("awareness") });

/** Targets recovery guidance — guarded-tier (human-gated, later phase). */
export const RecoveryTargetSchema = z.object({ primitive: z.literal("recovery") });

/** Targets a capability Manual's workflows section — later phase. */
export const ManualTargetSchema = z.object({
  primitive: z.literal("manual"),
  capability: z.string().min(1),
  section: z.literal("workflows"),
});

/**
 * Where a memory *could* land in the agent composition — a **proposal**, not a
 * promotion (ADR-0008 D1). In ADR-0007 v1 the target is stored and returned
 * untouched; nothing acts on it. `constraints`/`escalationTriggers`/`recovery`
 * are guarded-tier (human-gated, later phase) and `manual` is later-phase —
 * the schema carries the full union now because it is breaking to widen the
 * stored record later.
 */
export const MemoryTargetSchema = z.discriminatedUnion("primitive", [
  BackgroundTargetSchema,
  JudgmentTargetSchema,
  ExampleTargetSchema,
  AwarenessTargetSchema,
  RecoveryTargetSchema,
  ManualTargetSchema,
]);

export type MemoryTarget = z.infer<typeof MemoryTargetSchema>;

// ---------------------------------------------------------------------------
// Structured-target payload schemas
// ---------------------------------------------------------------------------
// Structured targets (`example`, `awareness`) declare their required payload
// shapes here as Zod schemas so `applyMemoryOverlay` (ADR-0008, later phase)
// never parses prose. `content` stays prompt-ready prose alongside. Shapes
// mirror the atoms they compile into (`atoms/example.ts` ExampleSchema,
// `atoms/awareness.ts` AwarenessDomainSchema) as *input* shapes — optional
// where the atom defaults — declared here, not imported, to keep the data
// contract free of atom coupling.

/** Payload an `example`-targeted record must carry to ever promote (compiles to an Example atom). */
export const ExampleTargetPayloadSchema = z.object({
  scenario: z.string().min(1),
  good: z.string().min(1),
  bad: z.string().optional(),
  reasoning: z.string().optional(),
});

export type ExampleTargetPayload = z.infer<typeof ExampleTargetPayloadSchema>;

/** Payload an `awareness`-targeted record must carry (compiles to an AwarenessDomain atom). */
export const AwarenessTargetPayloadSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  accessMethod: z.string().min(1),
});

export type AwarenessTargetPayload = z.infer<typeof AwarenessTargetPayloadSchema>;

/**
 * The payload schema a target's arm requires, or undefined for prose arms
 * (background/judgment/recovery/manual carry their learning in `content`).
 */
export function targetPayloadSchema(
  target: MemoryTarget,
): typeof ExampleTargetPayloadSchema | typeof AwarenessTargetPayloadSchema | undefined {
  switch (target.primitive) {
    case "example":
      return ExampleTargetPayloadSchema;
    case "awareness":
      return AwarenessTargetPayloadSchema;
    case "background":
    case "judgment":
    case "recovery":
    case "manual":
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// MemoryRecord
// ---------------------------------------------------------------------------

/** The four memory kinds — ADR-0007 D2. */
export const MemoryKindSchema = z.enum(["fact", "preference", "episode", "profile"]);

export type MemoryKind = z.infer<typeof MemoryKindSchema>;

/**
 * The stored memory record — ADR-0007 D2/D4/D7, ADR-0008 D1/D4.
 *
 * Payload-shape validation per target arm:
 * - target absent, or a prose arm → payload is opaque, never validated
 * - structured arm (example/awareness) with `payload === undefined` → VALID
 *   (a candidate may lack its payload; it merely cannot promote — ADR-0008 D1)
 * - structured arm with payload present → must parse against that arm's
 *   payload schema
 */
export const MemoryRecordSchema = z
  .object({
    id: z.string().min(1),
    scope: MemoryScopeSchema,
    kind: MemoryKindSchema,
    /** Natural-language, prompt-ready prose — ADR-0007 D7. */
    content: z.string().min(1),
    tags: z.array(z.string().min(1)).optional(),
    provenance: ProvenanceSchema.optional(),
    createdAt: z.string().min(1), // ISO 8601
    updatedAt: z.string().min(1), // ISO 8601
    invalidAt: z.string().min(1).optional(), // invalidation chain (ADR-0007 D4)
    supersededBy: z.string().min(1).optional(),
    expiresAt: z.string().min(1).optional(), // host-enforced TTL
    target: MemoryTargetSchema.optional(), // reserved pointer — ADR-0008 D1
    payload: z.unknown().optional(), // structured form for structured targets
    supports: z.array(ProvenanceSchema).optional(), // corroboration evidence — ADR-0008 D4
  })
  .superRefine((record, ctx) => {
    if (record.target === undefined || record.payload === undefined) return;
    const schema = targetPayloadSchema(record.target);
    if (!schema) return;
    const result = schema.safeParse(record.payload);
    if (!result.success) {
      const first = result.error.issues[0];
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["payload"],
        message: `payload does not match required shape for "${record.target.primitive}" target${
          first ? `: ${first.path.join(".")} — ${first.message}` : ""
        }`,
      });
    }
  });

export type MemoryRecord = z.infer<typeof MemoryRecordSchema>;

// ---------------------------------------------------------------------------
// Frozen factory
// ---------------------------------------------------------------------------

export type MemoryRecordInput = z.input<typeof MemoryRecordSchema>;

/** Recursively freeze plain objects and arrays; primitives and functions pass through. */
function deepFreeze(value: unknown): void {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return;
  Object.freeze(value);
  for (const inner of Object.values(value)) {
    deepFreeze(inner);
  }
}

/**
 * Validate + canonicalize + deep-freeze. Throws ZodError on invalid input.
 * Scope is stored with sorted keys ({@link canonicalMemoryScope}). The
 * returned record and every nested container (scope, tags, provenance,
 * target, supports and each entry, and payload when it is an object/array)
 * are frozen.
 */
export function memoryRecord(input: MemoryRecordInput): MemoryRecord {
  // Parse first, THEN freeze the parse result — never freeze before parsing.
  const parsed = MemoryRecordSchema.parse(input);
  const record: MemoryRecord = { ...parsed, scope: canonicalMemoryScope(parsed.scope) };
  deepFreeze(record);
  return record;
}

// ---------------------------------------------------------------------------
// Search + hit + capabilities
// ---------------------------------------------------------------------------

/**
 * A store search query — ADR-0007 D5.
 *
 * `limit` allows `0` at the schema level; what a store does with `limit: 0`
 * is pinned by the conformance kit in a later issue (the ConversationStore
 * `limit === 0` parity trap is the documented precedent, ADR-0007 context §4).
 */
export const MemorySearchQuerySchema = z.object({
  /** Absent ⇒ filtered, recency-ordered listing (ADR-0007 D5). */
  query: z.string().min(1).optional(),
  /** Required — the toolbox never exposes an unscoped search (ADR-0007 consequences). {} is legal but must be deliberate. */
  scope: MemoryScopeSchema,
  kinds: z.array(MemoryKindSchema).optional(),
  tags: z.array(z.string().min(1)).optional(),
  limit: z.number().int().nonnegative().default(10),
  includeInvalidated: z.boolean().default(false),
});

export type MemorySearchQuery = z.infer<typeof MemorySearchQuerySchema>;
/** Pre-parse shape: `limit`/`includeInvalidated` optional (defaults applied on parse). */
export type MemorySearchQueryInput = z.input<typeof MemorySearchQuerySchema>;

/** A search result — ordering is the contract, scores are advisory (ADR-0007 D5). */
export const MemoryHitSchema = z.object({
  record: MemoryRecordSchema,
  /** Backend-specific relevance score; ordering is the contract, scores are advisory (ADR-0007 D5). */
  score: z.number().optional(),
});

export type MemoryHit = z.infer<typeof MemoryHitSchema>;

/** What a store implementation can do — ADR-0007 D5. */
export const MemoryStoreCapabilitiesSchema = z.object({
  search: z.enum(["keyword", "semantic", "hybrid"]),
});

export type MemoryStoreCapabilities = z.infer<typeof MemoryStoreCapabilitiesSchema>;

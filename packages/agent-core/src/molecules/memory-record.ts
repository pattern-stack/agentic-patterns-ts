/**
 * Memory record molecules — the memory **data contract** described by
 * [ADR-0007](../../../../docs/adr/0007-memory-store.md) (Decisions 2, 3, 5, 7)
 * and [ADR-0008](../../../../docs/adr/0008-compositional-memory.md)
 * (Decision 1, target union shape only), with the tolerant stored-`target` read
 * from [ADR-0009](../../../../docs/adr/0009-memory-routing-and-background-composition.md)
 * Decision 14.
 *
 * Pure data: Zod schemas, inferred types, two freezing factories (one strict
 * for records this process AUTHORS, one tolerant for records it READS back out
 * of storage), and payload-shape validation for structured targets. Zero I/O,
 * zero runtime imports, zero behavior beyond validation and freezing — a
 * degradation is REPORTED as a return value, never logged from here. Runtime
 * stores (`MemoryStore` and friends) and external backends type against
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
// Tolerant STORED target (ADR-0009 Decision 14)
// ---------------------------------------------------------------------------
// `target` is persisted, and every read path reconstructs the record through
// `MemoryRecordSchema.parse`. A row whose `target` no longer parses — a row
// written by a NEWER version of this package, a hand-edited row, a vocabulary
// the reader has not learned yet — therefore made the parse THROW, and because
// a store's search maps over ALL matching rows, ONE such row killed the whole
// partition's recall. The agent did not degrade; it went blind. That listing is
// exactly recall's always-injected profile tier.
//
// The fix is asymmetric by design, and the asymmetry is the point:
//
//   READ  (`MemoryRecordSchema.target`) is TOLERANT — a `{ primitive: string }`
//         object passes through with every extra key PRESERVED. Nothing is
//         lost and nothing is invented; the value is simply not recognised.
//   WRITE (`MemoryWriteInputSchema.target`, `SaveParamsSchema.target`) stays
//         STRICT — `MemoryTargetSchema`. Tolerance is a read-path property, so
//         no caller can introduce an unknown vocabulary through the protocol.
//
// Readers must therefore never assume `record.target` is a known arm. Narrow
// with {@link isKnownTarget} before switching on it — that keeps the compiler's
// exhaustiveness check (the `never` guard in {@link targetPayloadSchema}) doing
// its job instead of loosening it away.

/**
 * A stored `target` this reader does not recognise — `{ primitive: string }`
 * with every other key carried through untouched (`.catchall(z.unknown())`,
 * which behaves identically on zod 3 and zod 4; `.passthrough()` is deprecated
 * on 4 and this package's peer range spans both).
 *
 * Deliberately NOT a widening of {@link MemoryTargetSchema}: the known union is
 * still the only thing that can be WRITTEN, and an exhaustive switch over
 * `MemoryTarget` is still exhaustive.
 */
export const UnknownMemoryTargetSchema = z
  .object({ primitive: z.string().min(1) })
  .catchall(z.unknown());

export type UnknownMemoryTarget = z.infer<typeof UnknownMemoryTargetSchema>;

/**
 * What a `target` may look like coming BACK OUT of storage — a known arm, or an
 * unrecognised-but-readable one. Arm order matters: {@link MemoryTargetSchema}
 * is tried first, so a recognised target keeps its exact discriminated-union
 * type and only genuinely unknown values reach the tolerant arm.
 */
export const StoredMemoryTargetSchema = z.union([MemoryTargetSchema, UnknownMemoryTargetSchema]);

export type StoredMemoryTarget = z.infer<typeof StoredMemoryTargetSchema>;

/**
 * Narrow a stored target to a known {@link MemoryTarget} arm. The ONE sanctioned
 * way to switch on `record.target`: it preserves exhaustiveness at every call
 * site instead of forcing a `default:` that silently absorbs new arms.
 *
 * `undefined` in ⇒ `false` out, so `isKnownTarget(record.target)` reads
 * naturally on the optional field.
 */
export function isKnownTarget(target: StoredMemoryTarget | undefined): target is MemoryTarget {
  return target !== undefined && MemoryTargetSchema.safeParse(target).success;
}

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
 *
 * Accepts a {@link StoredMemoryTarget} because a READ record's target may be an
 * unrecognised arm (ADR-0009 Decision 14). Unrecognised ⇒ `undefined`: this
 * reader cannot know what payload a vocabulary it has never seen requires, so
 * it validates nothing rather than guessing. The known arms keep their
 * compile-time exhaustiveness via {@link isKnownTarget} — the `never` guard
 * below is NOT loosened.
 */
export function targetPayloadSchema(
  target: StoredMemoryTarget,
): typeof ExampleTargetPayloadSchema | typeof AwarenessTargetPayloadSchema | undefined {
  if (!isKnownTarget(target)) return undefined;
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
    default: {
      // Compile-time exhaustiveness: a new MemoryTarget arm must declare its
      // payload schema here (or explicitly opt out as a prose arm).
      const _exhaustive: never = target;
      void _exhaustive;
      return undefined;
    }
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
 * - UNRECOGNISED arm → payload is opaque, never validated (ADR-0009 D14: this
 *   reader cannot know what a vocabulary it has never seen requires)
 *
 * Use {@link memoryRecord} to build a record you own. Use
 * {@link readStoredMemoryRecord} to rebuild one that came back out of a
 * database — it is the only entry point that will not detonate on a `target`
 * too broken even for the tolerant arm.
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
    // Reserved pointer — ADR-0008 D1. TOLERANT on read (ADR-0009 D14): an
    // unrecognised-but-readable target passes through preserved, because one
    // unreadable row must not kill a whole partition's recall. The WRITE side
    // (`MemoryWriteInputSchema`) stays strict.
    target: StoredMemoryTargetSchema.optional(),
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

/**
 * Recursively freeze plain objects and arrays; primitives and functions pass
 * through. `seen` is the cycle guard — it replaces an `Object.isFrozen` early
 * return, which also skipped the unfrozen descendants of an already-frozen
 * container.
 */
function deepFreeze(value: unknown, seen: WeakSet<object> = new WeakSet()): void {
  if (value === null || typeof value !== "object") return;
  if (seen.has(value)) return;
  seen.add(value);
  Object.freeze(value);
  for (const inner of Object.values(value)) {
    deepFreeze(inner, seen);
  }
}

/**
 * Validate + canonicalize + deep-freeze. Throws ZodError on invalid input.
 * Scope is stored with sorted keys ({@link canonicalMemoryScope}). The
 * returned record and every nested container (scope, tags, provenance,
 * target, supports and each entry, and payload when it is an object/array)
 * are frozen.
 *
 * `payload` is the one field parse carries through **by reference**
 * (`z.unknown()` does not copy), so freezing the record freezes the caller's
 * own payload object in place. Pass a copy if you intend to keep mutating it.
 */
export function memoryRecord(input: MemoryRecordInput): MemoryRecord {
  // Parse first, THEN freeze the parse result — never freeze before parsing.
  const parsed = MemoryRecordSchema.parse(input);
  const record: MemoryRecord = { ...parsed, scope: canonicalMemoryScope(parsed.scope) };
  deepFreeze(record);
  return record;
}

// ---------------------------------------------------------------------------
// Tolerant read path (ADR-0009 Decision 14)
// ---------------------------------------------------------------------------

/**
 * What a store had to drop to return a record at all. Reported as DATA, never
 * only logged: a backend that wants to warn, count or emit needs the facts, and
 * a caller that wants to alert on corruption should not have to scrape a
 * console.
 */
export interface MemoryRecordDegradation {
  /** Id of the single record affected — degradation is always per record. */
  readonly id: string;
  /** The field that was dropped. Only `"target"` in v1 (ADR-0009 D14). */
  readonly field: "target";
  /** Why the stored value could not be read, from the first Zod issue. */
  readonly reason: string;
}

/** {@link readStoredMemoryRecord}'s result — the record, plus what it cost. */
export interface StoredMemoryRecordRead {
  readonly record: MemoryRecord;
  /** Present ONLY when a field had to be dropped. Absent is the happy path. */
  readonly degraded?: MemoryRecordDegradation;
}

/**
 * Rebuild a {@link MemoryRecord} from a row that came back out of storage.
 *
 * The strict {@link memoryRecord} factory is right for records this process
 * constructs; it is wrong for records this process merely *reads*, because a
 * store's search maps over every matching row and a single throw takes the
 * whole result set with it (ADR-0009 Decision 14 — the reproduction is one
 * hand-edited `target.section`, and the casualty is the always-injected profile
 * tier of recall).
 *
 * Three outcomes, in order of how much they cost:
 *
 * 1. `target` is a known arm, or an unrecognised-but-readable
 *    `{ primitive: string }` object → parsed and PRESERVED verbatim. Nothing is
 *    degraded and nothing is reported: a reader meeting a row written by a
 *    newer version is the expected steady state, not an incident, and warning
 *    on it would be pure noise.
 * 2. `target` is unreadable even by the tolerant arm (`42`, `"background"`,
 *    `null`, `[]`, `{}`) → that ONE record is returned target-less, with a
 *    `degraded` report. Nothing else about the record changes and no other row
 *    is affected.
 * 3. Any OTHER field is invalid → this still THROWS, deliberately. Dropping a
 *    corrupt `content` or `scope` would hand the caller a record that lies
 *    about itself; the fix for those is a widening someone argues for on its
 *    own merits, not a blanket swallow. Named as a known limit rather than
 *    quietly extended.
 *
 * The `target` check runs BEFORE the record parse rather than as a catch-and-
 * retry, so the classification is decided by the schema and never inferred from
 * which exception happened to fire first. A structured target whose *payload*
 * is invalid therefore throws (case 3) — the target was readable, so it is not
 * the target's fault and dropping it would misreport the cause.
 */
export function readStoredMemoryRecord(
  input: Omit<MemoryRecordInput, "target"> & { target?: unknown },
): StoredMemoryRecordRead {
  if (input.target !== undefined) {
    const parsedTarget = StoredMemoryTargetSchema.safeParse(input.target);
    if (!parsedTarget.success) {
      const { target: _unreadable, ...withoutTarget } = input;
      const first = parsedTarget.error.issues[0];
      return {
        record: memoryRecord(withoutTarget),
        degraded: {
          id: String(input.id),
          field: "target",
          reason: `stored target is not readable as { primitive: string }${
            first ? `: ${first.message}` : ""
          }`,
        },
      };
    }
  }
  return { record: memoryRecord(input as MemoryRecordInput) };
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

# Spec 417 — core: memory record molecules

**Issue:** #417 · **Branch:** `dugshub/memory-store/1-record-molecules` · **Size:** S · **Package:** `@agentic-patterns/core` only
**Sources of record:** ADR-0007 Decisions 2, 3, 5, 7 (`docs/adr/0007-memory-store.md`); ADR-0008 Decision 1 (`docs/adr/0008-compositional-memory.md`, target union shape ONLY — no promotion/overlay behavior).
**Precedent to mirror:** `packages/agent-core/src/molecules/render-artifact.ts` (Zod schema + `z.infer` types + frozen factory + doc comments citing the ADR) and its test file `__tests__/render-artifact.test.ts`.

## Objective

Ship the memory **data contract** in core so that runtime stores (issue #418+) and the external Postgres backend can type against `MemoryRecord` without importing runtime. Pure data: Zod schemas, inferred types, one deep-freezing factory, payload-shape validation for structured targets. Zero I/O, zero runtime imports, zero behavior beyond validation/freezing.

## Scope (exact files)

| File | Action |
|---|---|
| `packages/agent-core/src/molecules/memory-record.ts` | **Create** — everything below lives here |
| `packages/agent-core/src/molecules/__tests__/memory-record.test.ts` | **Create** — vitest unit tests |
| `packages/agent-core/src/molecules/index.ts` | **Edit** — add barrel exports (core `src/index.ts` already does `export * from "./molecules/index.js"` — do NOT touch it) |

No other files. Nothing in `atoms/` (the `RenderContext.recall` / `Awareness.fromRecall` work is a separate issue). Nothing in runtime.

## API surface (exact TypeScript signatures)

All in `packages/agent-core/src/molecules/memory-record.ts`. Module header doc comment cites ADR-0007 Decision 2/7 and ADR-0008 Decision 1 with relative links, RenderArtifact-style.

### Scope

```ts
/** Flat string map partition key; subset-match semantics live in the store (ADR-0007 D3). */
export const MemoryScopeSchema = z.record(z.string(), z.string());
export type MemoryScope = z.infer<typeof MemoryScopeSchema>;

/** Frozen copy with keys sorted lexicographically — ADR-0007 D3 "stored canonically". */
export function canonicalMemoryScope(scope: MemoryScope): MemoryScope;
```

Note: use the two-arg `z.record(keySchema, valueSchema)` form — core's peer range is `zod ^3.25 || ^4.1` and the one-arg form is not valid in v4.

### Provenance

```ts
export const ProvenanceSchema = z.object({
  conversationId: z.string().optional(),
  runId: z.string().optional(),
  author: z.string().optional(),
  /** ISO 8601. Present on corroboration entries (`supports`); optional on record provenance. */
  at: z.string().optional(),
});
export type Provenance = z.infer<typeof ProvenanceSchema>;
```

The `at` field is the issue-pinned addition over ADR-0007's inline sketch (ADR-0008 D4 corroboration appends `{conversationId, runId, at}` to `supports`). All timestamps in this module are ISO 8601 **plain strings** — no `z.string().datetime()` (deprecated in zod v4; no repo precedent uses it). Document the ISO expectation in doc comments.

### MemoryTarget (ADR-0008 Decision 1 — full union, including guarded arms)

```ts
export const BackgroundTargetSchema = z.object({
  primitive: z.literal("background"),
  section: z.enum(["teamContext", "projectContext", "conventions", "currentState"]),
  key: z.string().min(1),
});
export const JudgmentTargetSchema = z.object({
  primitive: z.literal("judgment"),
  domain: z.string().min(1),
  slot: z.enum(["heuristics", "constraints", "escalationTriggers"]),
});
export const ExampleTargetSchema = z.object({
  primitive: z.literal("example"),
  judgmentDomain: z.string().min(1),
});
export const AwarenessTargetSchema = z.object({ primitive: z.literal("awareness") });
export const RecoveryTargetSchema = z.object({ primitive: z.literal("recovery") });
export const ManualTargetSchema = z.object({
  primitive: z.literal("manual"),
  capability: z.string().min(1),
  section: z.literal("workflows"),
});

export const MemoryTargetSchema = z.discriminatedUnion("primitive", [
  BackgroundTargetSchema,
  JudgmentTargetSchema,
  ExampleTargetSchema,
  AwarenessTargetSchema,
  RecoveryTargetSchema,
  ManualTargetSchema,
]);
export type MemoryTarget = z.infer<typeof MemoryTargetSchema>;
```

Doc comment must state: a `target` is a **proposal**, not a promotion (ADR-0008 D1); in ADR-0007 v1 it is stored and returned untouched; `constraints`/`escalationTriggers`/`recovery` are guarded-tier (human-gated, later phase) and `manual` is later-phase — the schema carries the full union now because it is breaking to widen the stored record later.

### Structured-target payload schemas (the pinned decision)

Structured targets (`example`, `awareness`) declare required payload shapes **as Zod schemas here** so `applyMemoryOverlay` (ADR-0008, later) never parses prose. `content` stays prompt-ready prose alongside. Shapes mirror the atoms they compile into (`atoms/example.ts` `ExampleSchema`, `atoms/awareness.ts` `AwarenessDomainSchema`) as *input* shapes — optional where the atom defaults:

```ts
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
): typeof ExampleTargetPayloadSchema | typeof AwarenessTargetPayloadSchema | undefined;
```

### MemoryRecord

```ts
export const MemoryKindSchema = z.enum(["fact", "preference", "episode", "profile"]);
export type MemoryKind = z.infer<typeof MemoryKindSchema>;

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
    invalidAt: z.string().min(1).optional(),     // invalidation chain (ADR-0007 D4)
    supersededBy: z.string().min(1).optional(),
    expiresAt: z.string().min(1).optional(),     // host-enforced TTL
    target: MemoryTargetSchema.optional(),       // reserved pointer — ADR-0008 D1
    payload: z.unknown().optional(),             // structured form for structured targets
    supports: z.array(ProvenanceSchema).optional(), // corroboration evidence — ADR-0008 D4
  })
  .superRefine((record, ctx) => {
    // Payload-shape validation per target arm:
    // - target absent, or a prose arm            → payload is opaque, never validated
    // - structured arm (example/awareness), payload === undefined → VALID
    //   (a candidate may lack its payload; it merely cannot promote — ADR-0008 D1)
    // - structured arm, payload present          → must parse against that arm's payload
    //   schema; on failure add an issue at path ["payload"] with a message naming the arm
  });
export type MemoryRecord = z.infer<typeof MemoryRecordSchema>;
```

Deliberately absent (ADR-0007 D7, field-consensus regret — do not add): confidence, salience, decay, embedding fields.

### Frozen factory

```ts
export type MemoryRecordInput = z.input<typeof MemoryRecordSchema>;

/**
 * Validate + canonicalize + deep-freeze. Throws ZodError on invalid input.
 * Scope is stored with sorted keys (canonicalMemoryScope). The returned record
 * and every nested container (scope, tags, provenance, target, supports and
 * each entry, and payload when it is an object/array) are frozen.
 */
export function memoryRecord(input: MemoryRecordInput): MemoryRecord;
```

Implementation: parse with `MemoryRecordSchema`, rebuild with `scope: canonicalMemoryScope(...)`, then apply a small local `deepFreeze` helper (recurse into plain objects/arrays; skip primitives/functions) to the whole parsed value. Follow the RenderArtifact convention of spreading optional keys only when present is NOT needed here — Zod's parse already omits absent optionals; just freeze the parse output. Do not export `deepFreeze`.

### Search + hit + capabilities

```ts
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
export type MemorySearchQueryInput = z.input<typeof MemorySearchQuerySchema>;

export const MemoryHitSchema = z.object({
  record: MemoryRecordSchema,
  /** Backend-specific relevance score; ordering is the contract, scores are advisory (ADR-0007 D5). */
  score: z.number().optional(),
});
export type MemoryHit = z.infer<typeof MemoryHitSchema>;

export const MemoryStoreCapabilitiesSchema = z.object({
  search: z.enum(["keyword", "semantic", "hybrid"]),
});
export type MemoryStoreCapabilities = z.infer<typeof MemoryStoreCapabilitiesSchema>;
```

`limit` allows `0` (schema-level); what a store does with `limit: 0` is pinned by the conformance kit in a later issue — note this in a comment (the ConversationStore `limit === 0` parity trap is the documented precedent, ADR-0007 context §4). Export `MemorySearchQueryInput` so callers get optional `limit`/`includeInvalidated` pre-parse.

### Barrel (`packages/agent-core/src/molecules/index.ts`)

Append one export block in the file's existing style:

```ts
export {
  AwarenessTargetPayloadSchema,
  BackgroundTargetSchema,
  ExampleTargetPayloadSchema,
  ExampleTargetSchema,
  JudgmentTargetSchema,
  ManualTargetSchema,
  AwarenessTargetSchema,
  RecoveryTargetSchema,
  MemoryHitSchema,
  MemoryKindSchema,
  MemoryRecordSchema,
  MemoryScopeSchema,
  MemorySearchQuerySchema,
  MemoryStoreCapabilitiesSchema,
  MemoryTargetSchema,
  ProvenanceSchema,
  canonicalMemoryScope,
  memoryRecord,
  targetPayloadSchema,
} from "./memory-record.js";
export type {
  AwarenessTargetPayload,
  ExampleTargetPayload,
  MemoryHit,
  MemoryKind,
  MemoryRecord,
  MemoryRecordInput,
  MemoryScope,
  MemorySearchQuery,
  MemorySearchQueryInput,
  MemoryStoreCapabilities,
  MemoryTarget,
  Provenance,
} from "./memory-record.js";
```

(biome will enforce ordering/format — run `bun run lint` and accept its sort.)

## Implementation strategy

1. Create `memory-record.ts` top-down in the order above: scope → provenance → target arms → payload schemas + `targetPayloadSchema` → record schema with `superRefine` → factory (+ private `deepFreeze`) → query/hit/capabilities. One file, ~250 lines with docs.
2. `superRefine` detail: `if (record.target === undefined || record.payload === undefined) return;` then `const schema = targetPayloadSchema(record.target); if (!schema) return;` then `const r = schema.safeParse(record.payload); if (!r.success) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["payload"], message: \`payload does not match required shape for "${record.target.primitive}" target: ...\` })` — include the first inner issue's message for debuggability.
3. `targetPayloadSchema` is a `switch (target.primitive)` returning the two schemas or `undefined`; exhaustive over the union (strict TS will enforce via the discriminant).
4. `canonicalMemoryScope`: `Object.freeze(Object.fromEntries(Object.entries(scope).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))))`.
5. `deepFreeze(value)`: if not an object or already frozen, return; freeze, then recurse over `Object.values` (arrays included). Guard against `null`.
6. Note on frozen output vs Zod: parse first, THEN freeze the parse result — never freeze before parsing (Zod clones anyway, but keep the order obvious).
7. Barrel edit, then tests, then `bun run check` from the repo root (build + typecheck + lint + test — takes minutes).
8. Zod compat constraints (peer `^3.25 || ^4.1`): two-arg `z.record`; no `.datetime()`; `z.discriminatedUnion`, `.superRefine`, `z.ZodIssueCode.custom`, `.default()` are fine in both majors.

## Test plan

`packages/agent-core/src/molecules/__tests__/memory-record.test.ts`, vitest `describe`/`it`, style of `render-artifact.test.ts`. Cover:

**MemoryScopeSchema / canonicalMemoryScope**
- accepts `{}` and `{ tenant: "acme", user: "u_42" }`; rejects non-string values (`{ n: 1 }`)
- `canonicalMemoryScope({ user: "u", tenant: "t" })` → keys ordered `["tenant", "user"]`; result frozen; input not mutated

**ProvenanceSchema** — accepts `{}`, accepts full `{conversationId, runId, author, at}`; rejects non-string `at`

**MemoryTargetSchema — one accept + one reject per arm**
- background: valid; rejects bad `section`; rejects empty `key`
- judgment: valid for each of the three `slot` values; rejects unknown slot
- example: valid; rejects missing `judgmentDomain`
- awareness / recovery: bare `{ primitive }` valid; extra keys stripped not rejected (default Zod object behavior — assert parse succeeds)
- manual: valid; rejects `section: "other"`
- union rejects `{ primitive: "persona" }` (locked tier is not a target)

**Payload validation per target arm (the acceptance-named behavior)**
- example target + valid payload `{scenario, good}` → record parses
- example target + payload `{scenario: "x"}` (missing `good`) → parse fails, issue path `["payload"]`
- awareness target + valid `{name, description, accessMethod}` → parses; + `{name: "x"}` → fails
- example target + `payload: undefined` → parses (candidate-without-payload is storable; promotion gating is later-phase)
- background target + arbitrary payload (`{ anything: true }`) → parses untouched (prose arm, payload opaque)
- untargeted record + arbitrary payload → parses

**MemoryRecordSchema**
- minimal record `{id, scope, kind: "fact", content, createdAt, updatedAt}` parses
- rejects empty `id`/`content`; rejects `kind: "opinion"`
- accepts full record with tags/provenance/invalidAt/supersededBy/expiresAt/supports

**memoryRecord factory**
- returns value satisfying `MemoryRecordSchema.safeParse`
- throws on invalid input (empty content)
- deep-freeze: `Object.isFrozen` on record, `record.scope`, `record.tags`, `record.target`, `record.supports`, `record.supports[0]`, and an object `payload`
- scope keys come back sorted regardless of input order
- absent optionals are absent (`"tags" in record === false`)

**MemorySearchQuerySchema**
- defaults: parsing `{ scope: {} }` yields `limit: 10`, `includeInvalidated: false`
- rejects missing `scope`, `limit: -1`, `limit: 2.5`; accepts `limit: 0`
- accepts `kinds: ["profile"]`; rejects `kinds: ["nope"]`

**MemoryHitSchema / MemoryStoreCapabilitiesSchema**
- hit with and without `score`; capabilities accepts the three enum values, rejects `"vector"`

**targetPayloadSchema**
- returns `ExampleTargetPayloadSchema` for example, `AwarenessTargetPayloadSchema` for awareness, `undefined` for background/judgment/recovery/manual

## Acceptance

- `bun run check` green from repo root (build + typecheck + lint + test).
- All symbols in the API-surface section exported from `@agentic-patterns/core` (via molecules barrel; core index is untouched `export *`).
- `memory-record.ts` imports **only** `zod` — no runtime imports, no atoms imports (payload schemas are declared here, mirroring atom shapes, not importing them — keeps molecules→atoms coupling out of the data contract and matches the issue's "declare required payload shapes as Zod schemas here").
- No confidence/salience/decay fields anywhere in the module.
- Tests cover schema validation, freeze semantics, and payload-shape validation per target arm (the issue's named acceptance).
- Commit includes this spec file (implementer commits spec with code, per workflow).

## Out of scope

- Everything in runtime: `MemoryStore` protocol/impls, toolbox, recall assembler, conformance kit, `loadMemoryStore`, events/SSE (issues #418+).
- `RenderContext.recall` widening and `Awareness.fromRecall` (separate core issue in this stack).
- Anything ADR-0008 behavioral: promotion/demotion/corroboration APIs, `applyMemoryOverlay`, overlay budgets, attribution `source: "memory"`, `MemoryWriteInput`. The target union and payload schemas ship here as **data only**.
- Store-side semantics: subset-match filtering, invalidation mechanics, `limit: 0` behavior, expiry filtering — schema carries the fields; behavior is pinned by the later conformance kit.
- `agent`-key scope-hygiene helpers (ADR-0008 D8 — runtime concern).
- Any change to `docs/memory/*` or the ADRs.

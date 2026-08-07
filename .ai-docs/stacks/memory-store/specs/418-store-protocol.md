# Spec 418 — runtime: MemoryStore protocol + InMemoryMemoryStore + exported conformance kit

**Issue:** #418 · **Branch:** `dugshub/memory-store/2-store-protocol` · **Size:** M · **Package:** `@agentic-patterns/runtime` (+ one docs table edit)
**Depends on:** #417 (merged — `packages/agent-core/src/molecules/memory-record.ts` ships `MemoryRecord`, `MemoryScope`, `MemoryHit`, `MemorySearchQuery{,Input}`, `MemoryStoreCapabilities`, `memoryRecord()`, `canonicalMemoryScope()` — all exported from `@agentic-patterns/core`).
**Sources of record:** ADR-0007 Decisions 3, 4, 5, 6, 11 (`docs/adr/0007-memory-store.md`). ADR-0008 is context only — promotion ops (`promote`/`demote`/`corroborate`) are Phase B and NOT in this issue.
**Precedent to mirror:** `packages/agent-runtime/src/conversation/store.ts` (structural protocol interface + `InMemory*` impl beside it in one file) and `packages/agent-runtime/src/stores/index.ts` (curated store-family barrel, naming per #118: bare noun = protocol, `InMemory<Noun>Store` = impl).

## Objective

Ship the runtime `memory/` module's foundation: the structural `MemoryStore` protocol, the `InMemoryMemoryStore` reference implementation, and `runMemoryStoreConformance(makeStore)` — the repo's **first conformance kit**, exported from the runtime barrel so the SQLite impl (next stack issue) and the external codegen-patterns Postgres backend run the exact same suite. The kit IS the SQLite↔Postgres portability contract (ADR-0007 D11): it pins subset-match scope semantics, invalidation chains, default exclusion of invalidated records, relevance *ordering* (never score values), limit semantics including `limit: 0`, the `updatedAt`-only-on-invalidate rule, and capabilities declaration.

## Scope (exact files)

| File | Action |
|---|---|
| `packages/agent-runtime/src/memory/store.ts` | **Create** — `MemoryWriteInputSchema` + `MemoryWriteInput`, `MemoryStore` interface, `InMemoryMemoryStore` |
| `packages/agent-runtime/src/memory/conformance.ts` | **Create** — `runMemoryStoreConformance` |
| `packages/agent-runtime/src/memory/index.ts` | **Create** — module barrel |
| `packages/agent-runtime/src/memory/__tests__/in-memory-memory-store.conformance.test.ts` | **Create** — runs the kit against `InMemoryMemoryStore` |
| `packages/agent-runtime/src/memory/__tests__/in-memory-memory-store.test.ts` | **Create** — impl-specific unit tests (not portable contract) |
| `packages/agent-runtime/src/index.ts` | **Edit** — add `export * from "./memory/index.js";` after the `stores/index.js` line |
| `packages/agent-runtime/src/stores/index.ts` | **Edit** — add curated MemoryStore re-exports (family barrel) |
| `packages/agent-runtime/package.json` | **Edit** — add `vitest` optional peer dependency (see "vitest boundary" below) |
| `packages/agent-runtime/tsup.config.ts` | **Edit** — add `"vitest"` to `external` with a comment (belt-and-braces beside `bun:sqlite`) |
| `docs/store-family.md` | **Edit** — update the MemoryStore rows (two table cells, exact text below) |

No other files. Nothing in core. NO SQLite store, NO toolbox, NO recall assembler, NO `loadMemoryStore`, NO events/SSE (all later stack issues).

## API surface (exact TypeScript signatures)

### `memory/store.ts`

Module header doc comment cites ADR-0007 D3–D6 with a relative link (`../../../../docs/adr/0007-memory-store.md`), states the module is modeled on the ConversationStore pattern (structural protocol + in-memory impl beside it), and notes promotion ops are ADR-0008 Phase B, deliberately absent.

Imports: `zod` + these from `@agentic-patterns/core`: `MemoryHit`, `MemoryKindSchema`, `MemoryRecord`, `MemoryScopeSchema`, `MemorySearchQueryInput`, `MemorySearchQuerySchema`, `MemoryStoreCapabilities`, `MemoryTargetSchema`, `ProvenanceSchema`, `canonicalMemoryScope` (only if needed — `memoryRecord` already canonicalizes), `memoryRecord`.

```ts
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

/** Cross-session memory persistence protocol — ADR-0007 D6. All methods async (issue pin). */
export interface MemoryStore {
  /**
   * Batch write; returns the created records in input order. The store assigns
   * id + createdAt/updatedAt (equal at birth). All-or-nothing: any invalid
   * input or unknown `supersedes` id rejects the whole batch with no mutation.
   */
  write(inputs: MemoryWriteInput[]): Promise<MemoryRecord[]>;

  /**
   * Relevance-ordered search (ADR-0007 D5). Accepts the pre-parse query shape;
   * implementations MUST apply MemorySearchQuerySchema defaults
   * (limit 10, includeInvalidated false). `query` absent ⇒ filtered,
   * recency-ordered listing (createdAt descending). Ordering is the contract;
   * `score` is backend-advisory and never part of it.
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

/** In-memory reference implementation — dev/CI/tests. Keyword search only. */
export class InMemoryMemoryStore implements MemoryStore {
  // private records = new Map<string, MemoryRecord>();  (insertion-ordered)
  write(inputs: MemoryWriteInput[]): Promise<MemoryRecord[]>;
  search(query: MemorySearchQueryInput): Promise<MemoryHit[]>;
  get(id: string): Promise<MemoryRecord | null>;
  invalidate(id: string, reason?: string): Promise<void>;
  delete(id: string): Promise<void>;
  capabilities(): Promise<MemoryStoreCapabilities>; // resolves { search: "keyword" }
}
```

Signature notes (deliberate, do not "fix"):

- **`capabilities()` returns a Promise.** The ADR-0007 D6 snippet shows it sync, but the issue pins "all async" and the house rule agrees. Issue wins.
- **`search` takes `MemorySearchQueryInput`** (the `z.input` type), not the parsed `MemorySearchQuery`. If it took the parsed type, `limit` would be required at every call site and the schema defaults would never apply. Implementations parse via `MemorySearchQuerySchema.parse(query)` first — that is where `limit: 10` / `includeInvalidated: false` come from, uniformly across backends.
- **No `expiresAt`/`supports` on `MemoryWriteInput`** — the issue pins the exact field list. Records created through this protocol can never carry them in this phase.

### Pinned store semantics (the conformance kit enforces these on every backend)

1. **Write:** store assigns `id` (crypto.randomUUID with the `conversation/store.ts` `generateId` fallback pattern — replicate the small local helper, do not import it) and `createdAt === updatedAt = new Date().toISOString()`. Scope is stored canonically (sorted keys) — building records via core's `memoryRecord()` gives canonicalization + payload-vs-target validation + deep-freeze for free; use it. Returns records in input order. `write([])` resolves `[]`.
2. **Write atomicity:** two-phase — (a) parse every input with `MemoryWriteInputSchema`, construct every new record via `memoryRecord()`, and resolve every `supersedes` id (unknown ⇒ `throw new Error(\`Memory record not found: ${id}\`)`); (b) only then commit map mutations. A failing input anywhere ⇒ nothing stored, nothing invalidated.
3. **Supersede = invalidation of the old record, atomically with the write** (ADR-0007 D4): old record gets `invalidAt = now`, `supersededBy = <new record id>`, `updatedAt = now` (same instant). If the old record was already invalidated: keep its original `invalidAt`, set/overwrite `supersededBy`, bump `updatedAt` (impl doc note — the kit does not pin this edge).
4. **`updatedAt` is touched ONLY by invalidation** (issue pin): write sets it equal to `createdAt`; `invalidate()` and supersede-triggered invalidation bump it; `get`/`search`/`delete` never do; there is no update op.
5. **Scope filtering is subset-match** (ADR-0007 D3): a record matches when `record.scope[k] === filter[k]` for **every** key in the filter. **The empty filter `{}` matches every record** — legal, deliberate, documented in the `search` doc comment (ADR-0007 consequences: powerful and easy to misuse; the toolbox never exposes it — later issue).
6. **`kinds` / `tags` filters:** `kinds` ⇒ `record.kind` ∈ kinds. `tags` ⇒ record's tags contain **every** queried tag (subset semantics, symmetric with scope; a record without tags matches only an absent/empty tags filter).
7. **Invalidated records are excluded from search by default**; `includeInvalidated: true` opts in. `get()` always returns them.
8. **Expired records (`expiresAt <= now`) are excluded from search unconditionally** (ADR-0007 known-limits: "stored and filtered on read"). Implement the filter (3 lines, forward parity with backends whose rows can be written by host SQL); it is untestable through this protocol since `MemoryWriteInput` cannot set `expiresAt` — note that in a comment, no test.
9. **Ordering, no `query`:** recency listing — `createdAt` descending; ties resolve by stable sort (insertion order preserved).
10. **Ordering, with `query` (InMemoryMemoryStore keyword algorithm):** tokens = `query.toLowerCase().split(/\s+/).filter(Boolean)`; haystack = `(content + " " + (tags ?? []).join(" ")).toLowerCase()`; score = count of tokens where `haystack.includes(token)`; records scoring 0 are excluded; order by score descending, then `createdAt` descending. Hits carry the score (advisory). The kit tests *ordering behavior*, never score values.
11. **`limit`:** applied after filtering + ordering. **`limit: 0` returns `[]` — zero means zero** (the ConversationStore `limit === 0` parity trap, pinned at last). Omitted ⇒ schema default 10.
12. **ISO-string comparison is chronological comparison** — all store-assigned timestamps are `toISOString()` (UTC, fixed width), so plain string `<`/`>` is correct; no `Date` parsing needed in filters/sorts.

### `memory/conformance.ts`

```ts
import type { MemoryStore } from "./store.js";

/**
 * Exported MemoryStore conformance kit — ADR-0007 D11, the SQLite↔Postgres
 * portability contract. Registers a vitest `describe` suite; call from a test
 * file with top-level await:
 *
 *   import { runMemoryStoreConformance } from "@agentic-patterns/runtime";
 *   await runMemoryStoreConformance(() => new InMemoryMemoryStore());
 *
 * `makeStore` is invoked once per test (beforeEach) — each test gets a fresh,
 * empty store. May be async (e.g. a SQLite temp file). Vitest is loaded via
 * dynamic import so the runtime barrel stays importable in production without
 * vitest installed.
 */
export async function runMemoryStoreConformance(
  makeStore: () => MemoryStore | Promise<MemoryStore>,
): Promise<void>;
```

Implementation shape:

```ts
export async function runMemoryStoreConformance(makeStore) {
  const { beforeEach, describe, expect, it } = await import("vitest");
  const caps = await (await makeStore()).capabilities();   // for capability-keyed sub-suites

  describe("MemoryStore conformance", () => {
    let store: MemoryStore;
    beforeEach(async () => { store = await makeStore(); });
    // ... suites below; capability-gated blocks registered conditionally on `caps`
  });
}
```

**The vitest boundary (why dynamic import — do not convert to a static import):** the kit is exported from the main runtime barrel (issue acceptance), and tsup bundles the barrel into `dist/index.js`. A static `import { describe } from "vitest"` would either be *bundled* (vitest is currently only a devDependency — tsup bundles non-dep imports) or, if externalized, become a top-level `import "vitest"` in `dist/index.js` that crashes every production consumer of `@agentic-patterns/runtime` that doesn't install vitest. The dynamic `await import("vitest")` inside the function body defers loading to the moment a test file actually calls the kit. Two supporting edits:

- `packages/agent-runtime/package.json`: add `"vitest": "^3.0.0"` to `peerDependencies` and `"vitest": { "optional": true }` to `peerDependenciesMeta` (consumers of the kit — test environments — have it; production consumers don't need it). Keep the existing devDependency.
- `packages/agent-runtime/tsup.config.ts`: add `"vitest"` to the `external` array with a one-line comment (peers are auto-external in tsup, but the explicit entry documents intent beside `bun:sqlite`).

A small kit-internal helper: `const tick = () => new Promise((r) => setTimeout(r, 5));` — store-assigned ISO timestamps have millisecond resolution; `tick()` between writes guarantees distinct `createdAt` wherever an ordering or before/after assertion needs it. Comment it.

### `memory/index.ts`

```ts
export { runMemoryStoreConformance } from "./conformance.js";
export { InMemoryMemoryStore, MemoryWriteInputSchema } from "./store.js";
export type { MemoryStore, MemoryWriteInput } from "./store.js";
```

### `src/index.ts` (runtime root barrel)

Add `export * from "./memory/index.js";` alongside the other module stars (after `storage/index.js`, before or after `stores/index.js` — biome order). Name-collision check already done: `MemoryStore` was freed by #118 (`docs/store-family.md` line 40); the core `Memory*` schema names are NOT re-exported by runtime, so no ambiguity.

### `src/stores/index.ts` (curated store-family barrel)

Append, in the file's existing style:

```ts
export { InMemoryMemoryStore } from "../memory/store.js";
export type { MemoryStore, MemoryWriteInput } from "../memory/store.js";
```

(Re-exporting the same declarations from both `memory/index.js` and `stores/index.js` is safe — same binding, the `InMemoryConversationStore` precedent; the `EvalSplit` ambiguity warning at the top of the root barrel only applies to *distinct* declarations sharing a name.)

### `docs/store-family.md` (two exact cell edits)

Row in "The family" table (currently `❌ **#119**, not built; **name freed by #118**`) becomes:

```
| **MemoryStore** | **semantic cross-session recall** — search facts from past sessions into the current one | ✅ #418 — protocol **`MemoryStore`** + impl **`InMemoryMemoryStore`** (`memory/store.ts`); conformance kit `runMemoryStoreConformance` (`memory/conformance.ts`) is the portability contract (ADR-0007); SQLite impl + toolbox in later stack issues | `MemoryService` |
```

Row in the ADK mapping table (currently `| \`MemoryService\` (semantic recall) | \`MemoryStore\` (freed by #118) | **#119**, deferred |`) — note cell becomes: `**#418** — protocol + in-memory impl + conformance kit; SQLite/toolbox later`.

## Implementation strategy

1. **`store.ts` first**, top-down: local `generateId()` (copy the `conversation/store.ts` crypto.randomUUID-with-fallback pattern) → `MemoryWriteInputSchema` → `MemoryStore` interface (full doc comments carrying the pinned semantics above — the interface doc IS the contract prose) → `InMemoryMemoryStore`.
2. `InMemoryMemoryStore.write`: phase 1 — map inputs to `{ parsed, record }` where `record = memoryRecord({ id: generateId(), scope, kind, content, ...optional fields present, createdAt: now, updatedAt: now })` (spread optionals only when defined — `exactOptionalPropertyTypes`-safe; `memoryRecord` throws ZodError on bad payload-vs-target) and collect supersede targets, throwing on unknown ids; phase 2 — `this.records.set(...)` each new record, then for each supersede rebuild the old record via `memoryRecord({ ...old, invalidAt: old.invalidAt ?? now, supersededBy: newId, updatedAt: now })` and re-set it. One `now` per batch.
3. `search`: `const q = MemorySearchQuerySchema.parse(query);` then filter (`scopeMatches` subset helper → kind → tags-subset → invalidated unless opted in → expired) → order (semantics 9/10) → `slice(0, q.limit)` (note: `limit: 0` ⇒ `[]` falls out of slice; keep it explicit with a comment anyway) → map to `MemoryHit` (`{ record }` for listings; `{ record, score }` for queries).
4. `invalidate`: lookup (throw `Memory record not found: ${id}` if missing); if `invalidAt` already set, return; else re-set via `memoryRecord({ ...old, invalidAt: now, updatedAt: now })`. `delete`: `this.records.delete(id)`, no throw. `get`: `this.records.get(id) ?? null`. `capabilities`: `return { search: "keyword" }` (async).
5. **`conformance.ts` second** — the shape above; suites mirror the Test plan's "Conformance kit" section one-to-one. Query-relevance suites are registered only when `caps.search !== "semantic"` (a pure-semantic backend need not do substring containment); everything else runs unconditionally. Add a comment marking this as the capability-keyed sub-suite seam (ADR-0007 D11) that the ADR-0008 promotion extension will later hook.
6. Barrels + package.json + tsup + docs edits.
7. Tests (below), then `bun run check` from the repo root (build + typecheck + lint + test — takes minutes; be patient). Watch `noUncheckedIndexedAccess` on Map/array access and biome's import ordering.

## Test plan

### Conformance kit content (`conformance.ts` — runs against ANY store)

**write / read-back**
- write one full input (scope, kind, tags, provenance, target `{primitive:"background",...}`, payload for a prose arm) → returned record: non-empty unique `id`, `createdAt === updatedAt`, all input fields preserved, record valid per `MemoryRecordSchema` (import from core, `safeParse` success)
- scope stored canonically: write `{ user: "u", tenant: "t" }` → `Object.keys(record.scope)` is `["tenant", "user"]`
- batch of 2 → 2 records, input order, distinct ids; `write([])` → `[]`
- `get(id)` round-trips the written record; `get("nope")` → `null`

**subset-match scope semantics** — seed `r1 {tenant:"acme"}`, `r2 {tenant:"acme",user:"u42"}`, `r3 {tenant:"other"}`:
- filter `{tenant:"acme"}` → r1+r2 (tenant-wide AND per-user — the ADR-0007 D3 motivating case); `{tenant:"acme",user:"u42"}` → r2 only; `{user:"u42"}` → r2; `{region:"eu"}` → none
- **empty filter `{}` matches all three** — the documented-and-tested empty-filter-matches-all pin
- `kinds: ["profile"]` filters by kind; `tags` filter requires ALL queried tags present (record tagged `["a","b"]` matches `tags:["a"]` and `tags:["a","b"]`, not `tags:["a","c"]`)

**invalidation chains**
- write A; `tick()`; write B with `supersedes: A.id` → `get(A.id)`: `invalidAt` set, `supersededBy === B.id`, `updatedAt === invalidAt`, `updatedAt > createdAt`; B itself untouched (`createdAt === updatedAt`)
- `invalidate(C.id)` standalone → `invalidAt` set, NO `supersededBy`
- `invalidate("nope")` rejects; second `invalidate(C.id)` is a no-op (`updatedAt` unchanged — capture before/after)
- write with `supersedes: "nope"` rejects AND is atomic: the batch's valid sibling is not stored (search `{}` afterward finds nothing new)
- `delete(id)` → `get` null, gone from `includeInvalidated` search; `delete("nope")` resolves

**search excludes invalidated by default**
- invalidated record absent from default search; present with `includeInvalidated: true`; still returned by `get`

**relevance ordering — never score values**
- no `query`: 3 writes separated by `tick()` → newest-first by `createdAt`; assert order via record ids, and assert `hits[i].record.createdAt >= hits[i+1].record.createdAt` — no assertion anywhere in the kit ever checks a `score` number (comment this rule at the top of the suite)
- with `query` (gated `caps.search !== "semantic"`): A content matches two query tokens, B matches one, C matches none → result is `[A, B]` in that order, C absent; `score`, when present, is a number (type check only)

**limit semantics incl. limit = 0**
- 12 writes, `limit` omitted → exactly 10 (schema default applied by the store)
- `limit: 2` over 3 matches → the 2 newest; **`limit: 0` → `[]`** (zero means zero — the pinned parity trap)

**`updatedAt` touched ONLY by invalidate (the pin)**
- after write: `createdAt === updatedAt`; after `get` + `search` calls: unchanged; after `invalidate`: bumped to equal `invalidAt`; after a further `search`: still that value

**capabilities declaration**
- `await store.capabilities()` parses against `MemoryStoreCapabilitiesSchema` (core import, `safeParse` success)

### `__tests__/in-memory-memory-store.conformance.test.ts`

```ts
import { InMemoryMemoryStore } from "../store.js";
import { runMemoryStoreConformance } from "../conformance.js";

await runMemoryStoreConformance(() => new InMemoryMemoryStore());
```

(Top-level await — vitest ESM test files support it; the suite registers during collection.)

### `__tests__/in-memory-memory-store.test.ts` (impl-specific, NOT in the kit)

- write rejects empty `content` / invalid `kind` (ZodError) with no mutation
- structured-target payload validation flows through: `target {primitive:"example",...}` + payload missing `good` → write rejects (core `memoryRecord` superRefine doing its job)
- returned records are deep-frozen: `Object.isFrozen(record)`, `record.scope`, `record.tags`
- superseding an already-invalidated record keeps the original `invalidAt`, overwrites `supersededBy`, bumps `updatedAt`
- `invalidate(id, "a reason")` resolves (reason accepted, unrecorded)
- keyword ordering detail: two-token match ranks above one-token match; equal scores fall back to `createdAt` desc
- `capabilities()` resolves `{ search: "keyword" }`

## Acceptance

- `bun run check` green from repo root.
- `InMemoryMemoryStore` passes the conformance kit (the conformance test file above).
- `runMemoryStoreConformance`, `MemoryStore`, `InMemoryMemoryStore`, `MemoryWriteInput{,Schema}` all importable from `@agentic-patterns/runtime` (root barrel); protocol + impl also in `stores/index.ts` (family barrel).
- `import "@agentic-patterns/runtime"` remains loadable without vitest installed — no static/top-level vitest import anywhere in `src/` outside `__tests__` (dynamic import only, inside `runMemoryStoreConformance`).
- `docs/store-family.md` MemoryStore rows updated (naming per #118: bare noun = protocol, `InMemory<Noun>Store` = impl).
- No `promote`/`demote`/`corroborate`, no scores asserted anywhere in the kit, no confidence/salience/decay anything.
- Commit includes this spec file (implementer commits spec with code, per workflow).

## Out of scope

- `SqliteMemoryStore`, FTS5, `loadMemoryStore()`, the second SQLite file / `PRAGMA user_version` ladder (next stack issue).
- `MemoryToolbox`, recall assembler, `RenderContext.recall` / `Awareness.fromRecall`, character budgets (later stack issues).
- Memory events (`agent.memory.*`), sse-formatter edits, manifest regen, dashboard union (later stack issue) — which is also where `invalidate`'s `reason` gains a consumer.
- Everything ADR-0008 behavioral: promotion ops, promotion rows, overlay, capability flags beyond `{ search }`.
- `expiresAt`/`supports` write paths (not in the pinned `MemoryWriteInput`); expiry read-filtering is implemented defensively but untested (no way to create an expired record via the protocol).
- Runtime re-exports of core `Memory*` schemas (consumers import `@agentic-patterns/core` directly, as the kit's tests do).
- Version bumps / changelog (release flow handles on merge).

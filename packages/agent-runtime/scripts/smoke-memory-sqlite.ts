/**
 * Hermetic bun:sqlite driver smoke for SqliteMemoryStore (#419).
 *
 * Vitest runs under Node, so it can only ever exercise better-sqlite3 — this
 * script proves the OTHER driver: FTS5 + JSON1 + multi-statement `.exec` +
 * `load.ts`'s named-param adapter (`wrapBunDatabase`) under the REAL
 * `bun:sqlite`, plus durability across a close/reopen. No network, no model,
 * no env creds.
 *
 * Run: bun packages/agent-runtime/scripts/smoke-memory-sqlite.ts
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMemoryStore } from "../src/storage/load.js";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`smoke-memory-sqlite FAILED: ${msg}`);
}

if (typeof process.versions.bun !== "string") {
  console.error("smoke-memory-sqlite must run under bun (it exercises bun:sqlite)");
  process.exit(1);
}

const dir = mkdtempSync(join(tmpdir(), "ap-memory-smoke-"));
const dbPath = join(dir, "memory.db");

try {
  const { store, unavailable, reason } = await loadMemoryStore({ path: dbPath });
  assert(unavailable === false, `expected a live store, got: ${reason}`);
  assert(reason.includes("bun:sqlite"), `expected bun:sqlite driver, got: ${reason}`);

  // Batch write: 2 records, tags + two-key scope.
  const [rich, poor] = await store.write([
    {
      scope: { tenant: "acme", user: "u1" },
      kind: "fact",
      content: "alpha beta gamma",
      tags: ["greek", "letters"],
    },
    { scope: { tenant: "acme" }, kind: "fact", content: "alpha only here" },
  ]);
  assert(rich !== undefined && poor !== undefined, "batch write returned 2 records");

  // FTS ordering: both hits, richer match first.
  const ftsHits = await store.search({ scope: {}, query: "alpha beta" });
  assert(ftsHits.length === 2, `expected 2 FTS hits, got ${ftsHits.length}`);
  assert(ftsHits[0]!.record.id === rich.id, "richer match (alpha+beta) ranks first");
  assert(ftsHits[1]!.record.id === poor.id, "subset match (alpha) ranks second");

  // Subset-scope filter.
  const scoped = await store.search({ scope: { user: "u1" } });
  assert(scoped.length === 1 && scoped[0]!.record.id === rich.id, "subset-scope filter");

  // Supersede: old invalidated + linked, excluded by default, present with includeInvalidated.
  const [corrected] = await store.write([
    { scope: { tenant: "acme" }, kind: "fact", content: "alpha corrected", supersedes: poor.id },
  ]);
  const oldRecord = await store.get(poor.id);
  assert(oldRecord !== null && oldRecord.invalidAt !== undefined, "superseded record invalidated");
  assert(oldRecord.supersededBy === corrected!.id, "supersededBy linked");
  const defaults = await store.search({ scope: {} });
  assert(!defaults.some((h) => h.record.id === poor.id), "invalidated record excluded by default");
  const included = await store.search({ scope: {}, includeInvalidated: true });
  assert(
    included.some((h) => h.record.id === poor.id),
    "invalidated record present with includeInvalidated",
  );

  // Standalone invalidate idempotency.
  await store.invalidate(poor.id);
  const afterFirst = (await store.get(poor.id))!.updatedAt;
  await store.invalidate(poor.id);
  assert((await store.get(poor.id))!.updatedAt === afterFirst, "re-invalidate is a no-op");

  // get round-trip.
  const roundTrip = await store.get(rich.id);
  assert(roundTrip !== null && roundTrip.content === rich.content, "get round-trip");
  assert(JSON.stringify(roundTrip.tags) === JSON.stringify(rich.tags), "tags round-trip");

  // limit: 0 ⇒ [] — zero means zero.
  assert((await store.search({ scope: {}, limit: 0 })).length === 0, "limit 0 returns []");

  // delete then FTS finds nothing for its content.
  await store.delete(corrected!.id);
  const afterDelete = await store.search({ scope: {}, query: "corrected" });
  assert(afterDelete.length === 0, "FTS scrubbed after delete");

  (store as { close(): void }).close();

  // Durability: reopen the same file, surviving records still there.
  const reopened = await loadMemoryStore({ path: dbPath });
  assert(reopened.unavailable === false, `reopen failed: ${reopened.reason}`);
  const survivor = await reopened.store.get(rich.id);
  assert(survivor !== null && survivor.content === rich.content, "record survives reopen");
  const survivorHits = await reopened.store.search({ scope: {}, query: "gamma" });
  assert(
    survivorHits.length === 1 && survivorHits[0]!.record.id === rich.id,
    "FTS index survives reopen",
  );
  (reopened.store as { close(): void }).close();

  console.log(
    "smoke-memory-sqlite PASS — bun:sqlite driver: FTS5 ordering, json_each filters, supersede/invalidate, durability across reopen",
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}

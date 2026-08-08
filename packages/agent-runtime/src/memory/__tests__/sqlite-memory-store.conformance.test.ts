/**
 * SqliteMemoryStore conformance — the exported kit run twice under
 * better-sqlite3: once with the plain driver, once through a shim-only
 * `Database` surface (prepare/exec/close ONLY, everything else throws) as
 * mechanical proof that the store never touches `.pragma()` /
 * `.transaction()` / any better-sqlite3-only API — the exact surface
 * `load.ts`'s bun:sqlite adapter exposes.
 */

import Database from "better-sqlite3";
import type { MemoryStoreConformanceOptions } from "../conformance.js";
import { runMemoryStoreConformance } from "../conformance.js";
import { SqliteMemoryStore } from "../sqlite-store.js";

// Copied from storage/__tests__/conversation-store.test.ts — typed as
// `typeof Database` to satisfy the store's option type; at runtime it
// deliberately satisfies ONLY the prepare/exec/close surface.
function shimOnlyDatabase(): typeof Database {
  return class ShimOnly {
    private readonly _raw: InstanceType<typeof Database>;
    constructor(path: string) {
      this._raw = new Database(path);
      // biome-ignore lint/correctness/noConstructorReturn: deliberate — a Proxy is the point
      return new Proxy(this, {
        get(target, prop) {
          if (prop === "prepare") return (sql: string) => target._raw.prepare(sql);
          if (prop === "exec") return (sql: string) => target._raw.exec(sql);
          if (prop === "close") return () => target._raw.close();
          throw new TypeError(`bun adapter surface has no member "${String(prop)}"`);
        },
      });
    }
  } as never;
}

/**
 * A store factory paired with the `setStoredTarget` seed hook Tier 1's
 * unknown-target tolerance axis needs (ADR-0009 Decision 14).
 *
 * The hook needs raw SQL against the store's OWN database, and the store keeps
 * its handle private — correctly, since nothing in the protocol should be able
 * to reach past it. So the driver is wrapped in a constructor function that
 * hands the instance back through a holder before returning it (a constructor
 * returning an object replaces `this`, so the store still gets the real
 * driver). The holder is created per `runMemoryStoreConformance` call, and the
 * kit re-invokes `makeStore` in `beforeEach`, so the handle is always the one
 * belonging to the store the current test is exercising.
 *
 * Only `.prepare` is used, so this works through the shim-only surface too —
 * which is worth having: it proves the seed itself needs no better-sqlite3
 * extension.
 */
function sqliteBackend(driver: typeof Database): {
  makeStore: () => SqliteMemoryStore;
  setStoredTarget: NonNullable<MemoryStoreConformanceOptions["setStoredTarget"]>;
} {
  const holder: { db?: InstanceType<typeof Database> } = {};
  const Tracking = function TrackingDatabase(path: string) {
    const db = new driver(path);
    holder.db = db;
    return db;
  } as unknown as typeof Database;

  return {
    makeStore: () => new SqliteMemoryStore({ path: ":memory:", Database: Tracking }),
    setStoredTarget: (_store, recordId, rawTarget) => {
      const db = holder.db;
      if (db === undefined) throw new Error("no SQLite handle captured for this store");
      // Bare-`@` named params, matching the store's own driver contract.
      db.prepare("UPDATE memory_records SET target = @target WHERE id = @id").run({
        target: JSON.stringify(rawTarget),
        id: recordId,
      });
    },
  };
}

// Top-level await — vitest ESM test files support it; the suites register
// during collection. The `label` option keeps the two runs (and the in-memory
// backend's run in the sibling file) distinguishable now that Tier 2 asserts
// the SAME corpus against every backend — an unlabelled "Tier 2 › diacritics
// fold" failure would not say which backend diverged.
const plain = sqliteBackend(Database);
await runMemoryStoreConformance(plain.makeStore, {
  label: "SqliteMemoryStore (better-sqlite3)",
  setStoredTarget: plain.setStoredTarget,
});
const shimmed = sqliteBackend(shimOnlyDatabase());
await runMemoryStoreConformance(shimmed.makeStore, {
  label: "SqliteMemoryStore (bun-adapter surface)",
  setStoredTarget: shimmed.setStoredTarget,
});

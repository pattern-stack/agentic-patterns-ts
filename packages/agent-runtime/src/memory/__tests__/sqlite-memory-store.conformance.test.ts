/**
 * SqliteMemoryStore conformance — the exported kit run twice under
 * better-sqlite3: once with the plain driver, once through a shim-only
 * `Database` surface (prepare/exec/close ONLY, everything else throws) as
 * mechanical proof that the store never touches `.pragma()` /
 * `.transaction()` / any better-sqlite3-only API — the exact surface
 * `load.ts`'s bun:sqlite adapter exposes.
 */

import Database from "better-sqlite3";
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

// Top-level await — vitest ESM test files support it; the suites register
// during collection. The `label` option keeps the two runs (and the in-memory
// backend's run in the sibling file) distinguishable now that Tier 2 asserts
// the SAME corpus against every backend — an unlabelled "Tier 2 › diacritics
// fold" failure would not say which backend diverged.
await runMemoryStoreConformance(() => new SqliteMemoryStore({ path: ":memory:", Database }), {
  label: "SqliteMemoryStore (better-sqlite3)",
});
await runMemoryStoreConformance(
  () => new SqliteMemoryStore({ path: ":memory:", Database: shimOnlyDatabase() }),
  { label: "SqliteMemoryStore (bun-adapter surface)" },
);

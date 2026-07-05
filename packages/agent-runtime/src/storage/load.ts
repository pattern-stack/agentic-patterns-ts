/**
 * Optional-dep loader for the SQLite-backed `EventStore` (and `RunStore` /
 * `EvalStore`, which extend it).
 *
 * The store classes are DRIVER-AGNOSTIC: they take an injected `Database`
 * constructor and use only the portable `.exec` / `.prepare` surface (never
 * better-sqlite3's `.pragma()`). These loaders pick the right driver for the
 * host runtime so persistence works out of the box on both:
 *
 *   • Node → `better-sqlite3` (declared as an optional peer dep, so library
 *     consumers don't pay the native-binary cost unless they want durable
 *     telemetry).
 *   • Bun  → `bun:sqlite` (built in). `better-sqlite3` IMPORTS under Bun but
 *     throws at `new Database()` ("not yet supported in Bun"), so under Bun we
 *     never touch it — we use the native driver, no compiled dep required. This
 *     is what lets `ap playground` persist eval/run/event data under Bun.
 *
 * Callers (typically the `ap playground` CLI) invoke `loadEventStore()` /
 * `loadRunStore()` / `loadEvalStore()` to wire one up if available, and fall
 * back to an in-memory-only setup otherwise.
 */

import type { EvalStore } from "./eval-store.js";
import type { EventStore, EventStoreOptions } from "./event-store.js";
import type { RunStore } from "./run-store.js";

/** Inputs for {@link loadEventStore}. The `Database` field is auto-resolved. */
export type LoadEventStoreOptions = Omit<EventStoreOptions, "Database">;

/** True when running under the Bun runtime (its built-in `bun:sqlite` is available). */
function isBun(): boolean {
  return (
    typeof (globalThis as { Bun?: unknown }).Bun !== "undefined" ||
    typeof process.versions.bun === "string"
  );
}

/** A resolved SQLite `Database` constructor plus its driver name (for banners). */
interface ResolvedDriver {
  Database: unknown;
  driver: string;
}

// ---------------------------------------------------------------------------
// bun:sqlite named-param adapter
// ---------------------------------------------------------------------------

/**
 * The store classes bind named params with BARE object keys (`{ status }` for
 * `@status`) — the better-sqlite3 convention. `bun:sqlite` instead matches by the
 * SIGIL'd key (`{ "@status" }`) and returns SQLITE_MISMATCH for a bare key. Since
 * `bun:sqlite` tolerates unused/extra keys, we normalize a named-bind object to
 * ALSO carry the `@`-prefixed variant of every bare key (all store params use `@`).
 * Positional binds (array / spread) pass through untouched. Node/better-sqlite3 is
 * never wrapped, so its bare-key path is unchanged.
 */
function normalizeBunBindArgs(args: unknown[]): unknown[] {
  if (
    args.length === 1 &&
    args[0] !== null &&
    typeof args[0] === "object" &&
    !Array.isArray(args[0])
  ) {
    const src = args[0] as Record<string, unknown>;
    const out: Record<string, unknown> = { ...src };
    for (const key of Object.keys(src)) {
      if (!/^[@$:]/.test(key)) out[`@${key}`] = src[key];
    }
    return [out];
  }
  return args;
}

/**
 * Wrap a `bun:sqlite` `Database` constructor so prepared-statement `all`/`get`/`run`
 * accept the stores' bare-key named binds (see {@link normalizeBunBindArgs}). Only
 * the surface the stores use — `prepare` / `exec` / `close` — is proxied.
 */
function wrapBunDatabase(Ctor: new (path: string, opts?: unknown) => unknown): unknown {
  type Stmt = {
    all: (...a: unknown[]) => unknown;
    get: (...a: unknown[]) => unknown;
    run: (...a: unknown[]) => unknown;
  };
  type RawDb = {
    prepare: (sql: string) => Stmt;
    exec: (sql: string) => unknown;
    close: () => unknown;
  };
  return class BunSqliteAdapter {
    private readonly _db: RawDb;
    constructor(path: string, opts?: unknown) {
      this._db = new Ctor(path, opts) as RawDb;
    }
    prepare(sql: string) {
      const stmt = this._db.prepare(sql);
      return {
        all: (...a: unknown[]) => stmt.all(...normalizeBunBindArgs(a)),
        get: (...a: unknown[]) => stmt.get(...normalizeBunBindArgs(a)),
        run: (...a: unknown[]) => stmt.run(...normalizeBunBindArgs(a)),
      };
    }
    exec(sql: string) {
      return this._db.exec(sql);
    }
    close() {
      return this._db.close();
    }
  };
}

/**
 * Resolve a SQLite `Database` constructor for the current runtime — `bun:sqlite`
 * under Bun, `better-sqlite3` under Node. Never throws: returns `{ reason }` when
 * the driver can't be loaded or doesn't expose a constructor, so the caller can
 * soft-degrade to in-memory.
 */
async function resolveDatabase(): Promise<ResolvedDriver | { reason: string }> {
  if (isBun()) {
    try {
      // `bun:sqlite` is a Bun built-in; the import only resolves under Bun. It is
      // marked `external` in the runtime tsup build so the bundler leaves it as a
      // live dynamic import rather than trying (and failing) to resolve it.
      // Specifier widened to `string` so tsc skips module resolution (no
      // `bun:sqlite` types under Node); the literal survives type-stripping,
      // and tsup marks it `external`, so the live import is kept under Bun.
      const mod = await import("bun:sqlite" as string);
      const Database = (mod as { Database?: unknown }).Database;
      if (typeof Database !== "function") {
        return { reason: "bun:sqlite did not expose a Database constructor" };
      }
      // Wrap so the stores' bare-key named binds work under bun:sqlite (SQLITE_MISMATCH otherwise).
      return {
        Database: wrapBunDatabase(Database as new (path: string, opts?: unknown) => unknown),
        driver: "bun:sqlite",
      };
    } catch (err) {
      return { reason: `bun:sqlite not loadable (${(err as Error).message ?? "unknown"})` };
    }
  }

  try {
    const mod = await import("better-sqlite3");
    const Database = (mod as { default?: unknown }).default ?? mod;
    if (typeof Database !== "function") {
      return { reason: "better-sqlite3 module did not expose a constructor" };
    }
    return { Database, driver: "better-sqlite3" };
  } catch (err) {
    return { reason: `better-sqlite3 not installed (${(err as Error).message ?? "unknown"})` };
  }
}

/** Result of {@link loadEventStore}: store + diagnostic info. */
export interface LoadEventStoreResult {
  /** Live store if a SQLite driver was resolvable. */
  store?: EventStore;
  /** True when no driver could be loaded or initialization failed. */
  unavailable: boolean;
  /** Human-readable reason; surfaced in the CLI banner. */
  reason: string;
}

/**
 * Attempt to instantiate an {@link EventStore} backed by SQLite (bun:sqlite under
 * Bun, better-sqlite3 under Node).
 *
 * Returns `{ unavailable: true }` with a reason if no driver can be loaded. The
 * caller decides whether that's fatal or a soft degradation (default: soft).
 */
export async function loadEventStore(opts: LoadEventStoreOptions): Promise<LoadEventStoreResult> {
  const resolved = await resolveDatabase();
  if ("reason" in resolved) {
    return { unavailable: true, reason: resolved.reason };
  }

  const { EventStore } = await import("./event-store.js");
  try {
    const store = new EventStore({
      ...opts,
      // biome-ignore lint/suspicious/noExplicitAny: dynamic dep
      Database: resolved.Database as any,
    });
    return {
      store,
      unavailable: false,
      reason: `connected to ${opts.path} via ${resolved.driver}`,
    };
  } catch (err) {
    return {
      unavailable: true,
      reason: `EventStore init failed: ${(err as Error).message ?? "unknown"}`,
    };
  }
}

/** Result of {@link loadRunStore}: store + diagnostic info. */
export interface LoadRunStoreResult {
  /** Live store if a SQLite driver was resolvable. */
  store?: RunStore;
  /** True when no driver could be loaded or initialization failed. */
  unavailable: boolean;
  /** Human-readable reason; surfaced in the CLI banner. */
  reason: string;
}

/**
 * Attempt to instantiate a {@link RunStore} backed by SQLite. Exact mirror of
 * {@link loadEventStore} — same driver resolution, `RunStore` instead of
 * `EventStore`.
 */
export async function loadRunStore(opts: LoadEventStoreOptions): Promise<LoadRunStoreResult> {
  const resolved = await resolveDatabase();
  if ("reason" in resolved) {
    return { unavailable: true, reason: resolved.reason };
  }

  const { RunStore } = await import("./run-store.js");
  try {
    const store = new RunStore({
      ...opts,
      // biome-ignore lint/suspicious/noExplicitAny: dynamic dep
      Database: resolved.Database as any,
    });
    return {
      store,
      unavailable: false,
      reason: `connected to ${opts.path} via ${resolved.driver}`,
    };
  } catch (err) {
    return {
      unavailable: true,
      reason: `RunStore init failed: ${(err as Error).message ?? "unknown"}`,
    };
  }
}

/** Result of {@link loadEvalStore}: store + diagnostic info. */
export interface LoadEvalStoreResult {
  /** Live store if a SQLite driver was resolvable. */
  store?: EvalStore;
  /** True when no driver could be loaded or initialization failed. */
  unavailable: boolean;
  /** Human-readable reason; surfaced in the CLI banner. */
  reason: string;
}

/**
 * Attempt to instantiate an {@link EvalStore} backed by SQLite. Exact mirror of
 * {@link loadRunStore} — same driver resolution, `EvalStore` instead of
 * `RunStore`.
 */
export async function loadEvalStore(opts: LoadEventStoreOptions): Promise<LoadEvalStoreResult> {
  const resolved = await resolveDatabase();
  if ("reason" in resolved) {
    return { unavailable: true, reason: resolved.reason };
  }

  const { EvalStore } = await import("./eval-store.js");
  try {
    const store = new EvalStore({
      ...opts,
      // biome-ignore lint/suspicious/noExplicitAny: dynamic dep
      Database: resolved.Database as any,
    });
    return {
      store,
      unavailable: false,
      reason: `connected to ${opts.path} via ${resolved.driver}`,
    };
  } catch (err) {
    return {
      unavailable: true,
      reason: `EvalStore init failed: ${(err as Error).message ?? "unknown"}`,
    };
  }
}

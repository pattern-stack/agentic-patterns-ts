/**
 * Optional-dep loader for the SQLite-backed `EventStore` (and `RunStore` /
 * `EvalStore`, which extend it).
 *
 * `better-sqlite3` is declared as an optional peer dep on @agentic-patterns/runtime
 * so library consumers don't pay the native-binary cost unless they want
 * durable telemetry. Callers (typically the `ap playground` CLI) invoke
 * `loadEventStore()` / `loadRunStore()` / `loadEvalStore()` to wire one up if
 * available, and fall back to an in-memory-only setup otherwise.
 */

import type { EvalStore } from "./eval-store.js";
import type { EventStore, EventStoreOptions } from "./event-store.js";
import type { RunStore } from "./run-store.js";

/** Inputs for {@link loadEventStore}. The `Database` field is auto-resolved. */
export type LoadEventStoreOptions = Omit<EventStoreOptions, "Database">;

/** Result of {@link loadEventStore}: store + diagnostic info. */
export interface LoadEventStoreResult {
  /** Live store if better-sqlite3 was resolvable. */
  store?: EventStore;
  /** True when the optional dep is missing or initialization failed. */
  unavailable: boolean;
  /** Human-readable reason; surfaced in the CLI banner. */
  reason: string;
}

/**
 * Attempt to instantiate an {@link EventStore} backed by SQLite.
 *
 * Returns `{ unavailable: true }` with a reason if better-sqlite3 cannot be
 * loaded. The caller decides whether that's fatal or a soft degradation
 * (default: soft).
 */
export async function loadEventStore(opts: LoadEventStoreOptions): Promise<LoadEventStoreResult> {
  let Database: unknown;
  try {
    const mod = await import("better-sqlite3");
    Database = (mod as { default?: unknown }).default ?? mod;
  } catch (err) {
    return {
      unavailable: true,
      reason: `better-sqlite3 not installed (${(err as Error).message ?? "unknown"})`,
    };
  }

  if (typeof Database !== "function") {
    return {
      unavailable: true,
      reason: "better-sqlite3 module did not expose a constructor",
    };
  }

  const { EventStore } = await import("./event-store.js");
  try {
    const store = new EventStore({
      ...opts,
      // biome-ignore lint/suspicious/noExplicitAny: dynamic dep
      Database: Database as any,
    });
    return { store, unavailable: false, reason: `connected to ${opts.path}` };
  } catch (err) {
    return {
      unavailable: true,
      reason: `EventStore init failed: ${(err as Error).message ?? "unknown"}`,
    };
  }
}

/** Result of {@link loadRunStore}: store + diagnostic info. */
export interface LoadRunStoreResult {
  /** Live store if better-sqlite3 was resolvable. */
  store?: RunStore;
  /** True when the optional dep is missing or initialization failed. */
  unavailable: boolean;
  /** Human-readable reason; surfaced in the CLI banner. */
  reason: string;
}

/**
 * Attempt to instantiate a {@link RunStore} backed by SQLite. Exact mirror of
 * {@link loadEventStore} — same optional-dep dance, `RunStore` instead of
 * `EventStore`.
 *
 * Returns `{ unavailable: true }` with a reason if better-sqlite3 cannot be
 * loaded. The caller decides whether that's fatal or a soft degradation
 * (default: soft).
 */
export async function loadRunStore(opts: LoadEventStoreOptions): Promise<LoadRunStoreResult> {
  let Database: unknown;
  try {
    const mod = await import("better-sqlite3");
    Database = (mod as { default?: unknown }).default ?? mod;
  } catch (err) {
    return {
      unavailable: true,
      reason: `better-sqlite3 not installed (${(err as Error).message ?? "unknown"})`,
    };
  }

  if (typeof Database !== "function") {
    return {
      unavailable: true,
      reason: "better-sqlite3 module did not expose a constructor",
    };
  }

  const { RunStore } = await import("./run-store.js");
  try {
    const store = new RunStore({
      ...opts,
      // biome-ignore lint/suspicious/noExplicitAny: dynamic dep
      Database: Database as any,
    });
    return { store, unavailable: false, reason: `connected to ${opts.path}` };
  } catch (err) {
    return {
      unavailable: true,
      reason: `RunStore init failed: ${(err as Error).message ?? "unknown"}`,
    };
  }
}

/** Result of {@link loadEvalStore}: store + diagnostic info. */
export interface LoadEvalStoreResult {
  /** Live store if better-sqlite3 was resolvable. */
  store?: EvalStore;
  /** True when the optional dep is missing or initialization failed. */
  unavailable: boolean;
  /** Human-readable reason; surfaced in the CLI banner. */
  reason: string;
}

/**
 * Attempt to instantiate an {@link EvalStore} backed by SQLite. Exact mirror of
 * {@link loadRunStore} — same optional-dep dance, `EvalStore` instead of
 * `RunStore`.
 *
 * Returns `{ unavailable: true }` with a reason if better-sqlite3 cannot be
 * loaded. The caller decides whether that's fatal or a soft degradation
 * (default: soft).
 */
export async function loadEvalStore(opts: LoadEventStoreOptions): Promise<LoadEvalStoreResult> {
  let Database: unknown;
  try {
    const mod = await import("better-sqlite3");
    Database = (mod as { default?: unknown }).default ?? mod;
  } catch (err) {
    return {
      unavailable: true,
      reason: `better-sqlite3 not installed (${(err as Error).message ?? "unknown"})`,
    };
  }

  if (typeof Database !== "function") {
    return {
      unavailable: true,
      reason: "better-sqlite3 module did not expose a constructor",
    };
  }

  const { EvalStore } = await import("./eval-store.js");
  try {
    const store = new EvalStore({
      ...opts,
      // biome-ignore lint/suspicious/noExplicitAny: dynamic dep
      Database: Database as any,
    });
    return { store, unavailable: false, reason: `connected to ${opts.path}` };
  } catch (err) {
    return {
      unavailable: true,
      reason: `EvalStore init failed: ${(err as Error).message ?? "unknown"}`,
    };
  }
}

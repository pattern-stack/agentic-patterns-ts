/**
 * Typed user-dependency channel — the `Slot<T>` analogue for injecting
 * clients/resolvers/loggers into a `Node` tree without closures (DESIGN §4
 * item 2, spec `.ai-docs/stacks/closed-composition/specs/98.md`).
 *
 * A `DepKey<T>` is a branded, typed handle minted once at module scope (same
 * idiom as `slot<T>()`). It is bound to a value in a `DepRegistry` at the
 * `run()` root (via {@link provideDeps}) and read at any leaf via
 * `ctx.deps?.get(key)` — type-safe, no generic on `Node`, no `any`-bag.
 *
 * Deliberately simpler than `Scratchpad`: deps are READ-ONLY (no `set`/
 * `update`) and RUN-SCOPED ONLY (never forked) — they are injected once and
 * shared by reference across every branch via the existing `{ ...ctx }`
 * spread every combinator already does.
 */

// ---------------------------------------------------------------------------
// DepKey
// ---------------------------------------------------------------------------

/** A branded, typed dependency handle — the DI analogue of `Slot<T>`. */
export interface DepKey<T> {
  readonly id: string;
  /** phantom — carries T for inference; never read at runtime. */
  readonly __t?: T;
}

let depKeySeq = 0;

/** Mint a typed dependency key. `name` is used for identity + error messages. */
export function depKey<T>(name: string): DepKey<T> {
  depKeySeq += 1;
  return Object.freeze({ id: `${name}#${depKeySeq}` }) as DepKey<T>;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class MissingDependencyError extends Error {
  constructor(keyName: string) {
    super(`Missing required dependency: "${keyName}" was never provided via provideDeps().`);
    this.name = "MissingDependencyError";
  }
}

// ---------------------------------------------------------------------------
// DepReader / DepRegistry
// ---------------------------------------------------------------------------

/** Read-only DI surface placed on `NodeRunContext.deps`. */
export interface DepReader {
  /** Bound value; throws {@link MissingDependencyError} if the key was never provided. */
  get<T>(key: DepKey<T>): T;
  /** Non-throwing lookup for an optional dependency. */
  getOptional<T>(key: DepKey<T>): T | undefined;
  has(key: DepKey<unknown>): boolean;
}

/** Frozen, `ReadonlyMap`-backed `DepReader` — built via {@link provideDeps}. */
export class DepRegistry implements DepReader {
  private readonly entries: ReadonlyMap<string, unknown>;

  constructor(entries: ReadonlyMap<string, unknown>) {
    this.entries = entries;
    Object.freeze(this);
  }

  get<T>(key: DepKey<T>): T {
    if (!this.entries.has(key.id)) {
      throw new MissingDependencyError(key.id);
    }
    return this.entries.get(key.id) as T;
  }

  getOptional<T>(key: DepKey<T>): T | undefined {
    return this.entries.get(key.id) as T | undefined;
  }

  has(key: DepKey<unknown>): boolean {
    return this.entries.has(key.id);
  }
}

// ---------------------------------------------------------------------------
// provideDeps — root injection builder
// ---------------------------------------------------------------------------

/** Fluent builder for the root injection point (`node.run(input, { runner, deps })`). */
export interface DepsBuilder {
  set<T>(key: DepKey<T>, value: T): DepsBuilder;
  build(): DepRegistry;
}

/**
 * Start building a `DepRegistry` at the `run()` root. Accepts an optional
 * array of `[key, value]` entries for a one-shot literal.
 *
 * ```ts
 * const deps = provideDeps().set(apiClientKey, client).set(loggerKey, logger).build();
 * // or
 * const deps = provideDeps([[apiClientKey, client], [loggerKey, logger]]).build();
 * ```
 */
export function provideDeps(
  entries?: ReadonlyArray<readonly [DepKey<unknown>, unknown]>,
): DepsBuilder {
  const map = new Map<string, unknown>(entries?.map(([key, value]) => [key.id, value]));

  const builder: DepsBuilder = {
    set<T>(key: DepKey<T>, value: T): DepsBuilder {
      map.set(key.id, value);
      return builder;
    },
    build(): DepRegistry {
      return new DepRegistry(new Map(map));
    },
  };

  return builder;
}

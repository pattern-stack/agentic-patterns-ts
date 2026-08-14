/**
 * Provider adapter protocol.
 *
 * A `ProviderProtocol` describes one LLM provider in three axes:
 *   • which env vars indicate the provider is available
 *   • a cross-provider tier map (opus / sonnet / haiku) giving default
 *     model ids at each quality/cost rung
 *   • a `load(modelId)` method that dynamically imports the provider
 *     package and returns a Vercel AI SDK `LanguageModelV2`
 *
 * Adding a provider = dropping one file under `providers/`. No conditionals
 * to grow — `createRunner()` reads the registry in `providers/index.ts`.
 */

import type { LanguageModelV2, LanguageModelV3, LanguageModelV4 } from "@ai-sdk/provider";

/**
 * A live, instance-form language model — any provider-spec version ai@7
 * accepts. Mirrors ai's `LanguageModel` union minus the string
 * (global-provider-id) arm: our resolvers hand out instances, never ids.
 */
export type ResolvedLanguageModel = LanguageModelV2 | LanguageModelV3 | LanguageModelV4;

/**
 * Runtime array mirroring {@link SupportedProvider} — TS union types are
 * erased at runtime, so anything needing the values themselves (a zod
 * `z.enum()`, an iteration) needs this array instead of the type. Single
 * source of truth for `model-resolver.ts`'s `PROFILE_PROVIDERS` and
 * `capabilities.ts`'s provider enum — both import it from here (the leaf
 * module in `providers/`) rather than from each other, to avoid a
 * providers/index.ts -> capabilities.ts -> model-resolver.ts -> index.ts
 * import cycle.
 */
export const SUPPORTED_PROVIDERS = [
  "anthropic",
  "openai",
  "google",
  "groq",
  "mistral",
  "xai",
  "deepseek",
  "openrouter",
  "ollama",
] as const;

/** Supported provider identifiers. Matches directory / file names below. */
export type SupportedProvider = (typeof SUPPORTED_PROVIDERS)[number];

/**
 * Cross-provider tier selector.
 *
 *   opus   — most capable / expensive / slowest
 *   sonnet — balanced default
 *   haiku  — fastest / cheapest / smallest
 *
 * Agents written against tiers stay portable across providers and hardware.
 */
export type ProviderTier = "opus" | "sonnet" | "haiku";

/** Per-provider adapter. One constant per provider file. */
export interface ProviderProtocol {
  readonly name: SupportedProvider;
  /** Default model id for each tier. */
  readonly tiers: Readonly<Record<ProviderTier, string>>;
  /**
   * Env variables whose presence indicates this provider is usable.
   * First-matched-first-wins during `createRunner()` auto-detection.
   */
  readonly envVars: readonly string[];
  /**
   * The npm package `load()` dynamically imports. Declared here (rather than
   * only inlined at the `importProvider` call site) so error messages, the
   * packaging contract test, and any tooling can name the exact package
   * without re-deriving it from the provider name.
   */
  readonly packageName: string;
  /**
   * Whether `packageName` ships as a real dependency of
   * `@pattern-stack/agentic-runtime` (#472). `true` means installing the runtime is
   * sufficient to reach this provider — a load failure is then a broken
   * install, not a missing optional package. `false` means the consumer must
   * install `packageName` themselves.
   *
   * Kept in lockstep with `packages/agent-runtime/package.json` by
   * `providers/__tests__/bundled-providers.test.ts`.
   */
  readonly bundled: boolean;
  /**
   * Dynamically import the provider's `@ai-sdk/*` (or equivalent) package
   * and return a `ResolvedLanguageModel` for the given model id. Throws a
   * helpful error if the package isn't installed.
   */
  load(modelId: string): Promise<ResolvedLanguageModel>;
}

// ---------------------------------------------------------------------------
// Dynamic import helper
// ---------------------------------------------------------------------------

/**
 * Thrown when a provider's package cannot be imported. Carries the package and
 * provider names so callers (notably `createRunner`) can build a fix-naming
 * message instead of string-matching a generic `Error`.
 */
export class ProviderPackageError extends Error {
  override readonly name = "ProviderPackageError";
  constructor(
    readonly packageName: string,
    readonly provider: string,
    readonly bundled: boolean,
    cause: unknown,
  ) {
    super(
      bundled
        ? [
            `provider "${provider}" could not load "${packageName}", which ships as a dependency`,
            "of @pattern-stack/agentic-runtime — this usually means a broken or partial install.",
            "Reinstall your dependencies (bun install / npm install / pnpm install).",
          ].join(" ")
        : [
            `provider "${provider}" requires "${packageName}" to be installed.`,
            `Run: bun add ${packageName}  (or npm i ${packageName})`,
          ].join(" "),
      { cause },
    );
  }
}

/**
 * Dynamically import a provider package. If it's not installed, throw an
 * error that tells the caller how to fix it.
 *
 * `bundled` distinguishes the two failure stories: a package the runtime ships
 * (a broken install) from one the consumer opted into (a missing install).
 */
export async function importProvider(
  pkg: string,
  provider: string,
  bundled = false,
  // biome-ignore lint/suspicious/noExplicitAny: imported module shape is opaque
): Promise<any> {
  try {
    return await import(/* @vite-ignore */ pkg);
  } catch (e) {
    throw new ProviderPackageError(pkg, provider, bundled, e);
  }
}

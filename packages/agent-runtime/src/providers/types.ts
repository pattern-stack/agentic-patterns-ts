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
 * Dynamically import a provider package. If it's not installed, throw an
 * error that tells the caller how to fix it.
 */
// biome-ignore lint/suspicious/noExplicitAny: imported module shape is opaque
export async function importProvider(pkg: string, provider: string): Promise<any> {
  try {
    return await import(/* @vite-ignore */ pkg);
  } catch (e) {
    throw new Error(
      `createRunner: provider "${provider}" requires "${pkg}" to be installed. ` +
        `Run: pnpm add ${pkg}`,
      { cause: e },
    );
  }
}

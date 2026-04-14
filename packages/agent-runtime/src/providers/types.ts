/**
 * Provider adapter protocol.
 *
 * A `ProviderProtocol` describes one LLM provider in three axes:
 *   • which env vars indicate the provider is available
 *   • a cross-provider tier map (opus / sonnet / haiku) giving default
 *     model ids at each quality/cost rung
 *   • a `load(modelId)` method that dynamically imports the provider
 *     package and returns a Vercel AI SDK `LanguageModelV1`
 *
 * Adding a provider = dropping one file under `providers/`. No conditionals
 * to grow — `createRunner()` reads the registry in `providers/index.ts`.
 */

import type { LanguageModelV1 } from "ai";

/** Supported provider identifiers. Matches directory / file names below. */
export type SupportedProvider =
  | "anthropic"
  | "openai"
  | "google"
  | "groq"
  | "mistral"
  | "xai"
  | "deepseek"
  | "openrouter"
  | "ollama";

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
   * and return a `LanguageModelV1` for the given model id. Throws a helpful
   * error if the package isn't installed.
   */
  load(modelId: string): Promise<LanguageModelV1>;
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

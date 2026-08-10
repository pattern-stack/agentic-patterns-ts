/**
 * Provider adapter registry.
 *
 * Each provider exports a `ProviderProtocol` constant that knows its env
 * vars, tier map, and how to dynamically load the `@ai-sdk/*` (or
 * equivalent) package. The registry below is consumed by `createRunner()`
 * for provider auto-detection and tier resolution.
 *
 * Registry order matters for env-based auto-detection: the first provider
 * with a matching env var wins. We lead with Anthropic (repo's center of
 * gravity: the Claude Agent SDK is a peer dep). Callers who want a
 * different order pass `options.provider` explicitly.
 */

export type { ProviderProtocol, ProviderTier, SupportedProvider } from "./types.js";
export { ProviderPackageError } from "./types.js";

// Model capability map (#390) — Zod-schema'd, provenance-carrying knowledge
// of which V4 SDK-level knobs each model family honors. See capabilities.ts
// for the full design; consumed by `runStructured()` for advisory warnings.
export {
  CapabilityValueSchema,
  MODEL_CAPABILITIES,
  ModelCapabilitiesSchema,
  ReasoningEffortCapabilitySchema,
  ReasoningEffortLevelSchema,
  SupportSchema,
  VerificationSchema,
  adviseStructuredRun,
  adviseStructuredRunFor,
  bareModelId,
  getModelCapabilities,
} from "./capabilities.js";
export type {
  CapabilityValue,
  ModelCapabilities,
  ReasoningEffortCapability,
  ReasoningEffortLevel,
  Support,
  Verification,
} from "./capabilities.js";

export { anthropicProvider } from "./anthropic.js";
export { openaiProvider } from "./openai.js";
export { googleProvider } from "./google.js";
export { groqProvider } from "./groq.js";
export { mistralProvider } from "./mistral.js";
export { xaiProvider } from "./xai.js";
export { deepseekProvider } from "./deepseek.js";
export { openrouterProvider } from "./openrouter.js";
export { ollamaProvider } from "./ollama.js";

// Claude Code LanguageModelV4 adapter — wraps the Claude Agent SDK so
// Max subscription users can feed Claude through AgentRunner like any
// other @ai-sdk/* provider with full event vocabulary.
export { claudeCode, ClaudeCodeLanguageModel } from "./claude-code.js";
export type {
  CCSessionDebugEvent,
  ClaudeCodeProviderOptions,
  SessionStrategy,
} from "./claude-code.js";

import { anthropicProvider } from "./anthropic.js";
import { deepseekProvider } from "./deepseek.js";
import { googleProvider } from "./google.js";
import { groqProvider } from "./groq.js";
import { mistralProvider } from "./mistral.js";
import { ollamaProvider } from "./ollama.js";
import { openaiProvider } from "./openai.js";
import { openrouterProvider } from "./openrouter.js";
import type { ProviderProtocol, ProviderTier, SupportedProvider } from "./types.js";
import { xaiProvider } from "./xai.js";

/** All supported providers keyed by name. */
export const PROVIDERS: Readonly<Record<SupportedProvider, ProviderProtocol>> = {
  anthropic: anthropicProvider,
  openai: openaiProvider,
  google: googleProvider,
  groq: groqProvider,
  mistral: mistralProvider,
  xai: xaiProvider,
  deepseek: deepseekProvider,
  openrouter: openrouterProvider,
  ollama: ollamaProvider,
};

/**
 * Env-detection priority. First entry whose `envVars` include a set env
 * variable wins. Order reflects repo defaults — Anthropic first, OSS local
 * (Ollama) last so remote providers are preferred when both exist.
 *
 * This order is BEHAVIOUR, not documentation: it decides which model a bare
 * `createRunner()` picks when several keys are present. Since #472 shipped
 * anthropic/openai/google as real dependencies, every one of those three is
 * reachable on a stock install, so the order is now observable by ordinary
 * consumers rather than only by those who installed the matching provider
 * package. Locked down by `runner/__tests__/create-runner.test.ts`.
 */
export const PROVIDER_PRIORITY: readonly SupportedProvider[] = [
  "anthropic",
  "openai",
  "google",
  "groq",
  "mistral",
  "xai",
  "deepseek",
  "openrouter",
  "ollama",
];

/**
 * Providers whose package ships as a real dependency of
 * `@agentic-patterns/runtime` (#472) — reachable with nothing installed beyond
 * the runtime itself. Derived from the registry so it cannot drift from the
 * adapters; the package.json side is asserted by
 * `providers/__tests__/bundled-providers.test.ts`.
 */
export const BUNDLED_PROVIDERS: readonly SupportedProvider[] = Object.freeze(
  PROVIDER_PRIORITY.filter((name) => PROVIDERS[name].bundled),
);

/**
 * The primary env var of each bundled provider, in priority order — the
 * shortest list of "set one of these and you reach AgentRunner on a stock
 * install". Aliases (e.g. `GOOGLE_API_KEY`) are omitted deliberately: this is
 * advice copy, not the detection set. Used to build `createRunner`'s fallback
 * message so it can never recommend a provider the runtime does not ship.
 */
export const BUNDLED_PROVIDER_ENV_VARS: readonly string[] = Object.freeze(
  BUNDLED_PROVIDERS.map((name) => PROVIDERS[name].envVars[0] ?? "").filter((v) => v.length > 0),
);

/** Resolve a model id for a (provider, tier?, explicitModelId?) triple. */
export function resolveModelId(
  provider: ProviderProtocol,
  explicitModelId?: string,
  tier: ProviderTier = "sonnet",
): string {
  return explicitModelId ?? provider.tiers[tier];
}

/** The cross-provider tier words an agent may declare in place of a model id. */
export const PROVIDER_TIERS: readonly ProviderTier[] = ["opus", "sonnet", "haiku"];

/**
 * Whether a declared id is a cross-provider tier alias rather than a real model
 * id. Tier words are the ONE id family that is not addressable upstream — every
 * dispatch path has to translate them through a provider's tier map first.
 */
export function isProviderTier(modelId: string): modelId is ProviderTier {
  return (PROVIDER_TIERS as readonly string[]).includes(modelId.toLowerCase());
}

/**
 * Translate a declared id that MAY be a tier alias into a concrete model id,
 * reading `provider`'s tier map. Non-alias ids pass through untouched, so this
 * is safe to call on any declared id.
 *
 * This is the single translation point for tier words: the direct-provider path
 * reaches it via {@link resolveModelId} (createRunner's pinned ladder) and the
 * gateway path via `model-resolver`'s gateway id translation — both read the same
 * `PROVIDERS[p].tiers` map, so `haiku` can never mean two different things.
 */
export function resolveTierAlias(modelId: string, provider: ProviderProtocol): string {
  const lower = modelId.toLowerCase();
  return isProviderTier(lower) ? provider.tiers[lower] : modelId;
}

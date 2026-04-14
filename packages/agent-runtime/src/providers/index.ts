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
export { anthropicProvider } from "./anthropic.js";
export { openaiProvider } from "./openai.js";
export { googleProvider } from "./google.js";
export { groqProvider } from "./groq.js";
export { mistralProvider } from "./mistral.js";
export { xaiProvider } from "./xai.js";
export { deepseekProvider } from "./deepseek.js";
export { openrouterProvider } from "./openrouter.js";
export { ollamaProvider } from "./ollama.js";

// Claude Code LanguageModelV1 adapter — wraps the Claude Agent SDK so
// Max subscription users can feed Claude through AgentRunner like any
// other @ai-sdk/* provider with full event vocabulary.
export { claudeCode, ClaudeCodeLanguageModel } from "./claude-code.js";
export type { ClaudeCodeProviderOptions } from "./claude-code.js";

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

/** Resolve a model id for a (provider, tier?, explicitModelId?) triple. */
export function resolveModelId(
  provider: ProviderProtocol,
  explicitModelId?: string,
  tier: ProviderTier = "sonnet",
): string {
  return explicitModelId ?? provider.tiers[tier];
}

import { type ProviderProtocol, importProvider } from "./types.js";

/**
 * OpenRouter gateways 150+ models across every major provider. Our tier
 * defaults route to Claude (repo's center of gravity); callers who want
 * a non-Claude default pass `modelId` explicitly (e.g. "meta-llama/llama-3.3-70b").
 */
export const openrouterProvider: ProviderProtocol = {
  name: "openrouter",
  tiers: {
    opus: "anthropic/claude-opus-4-5",
    sonnet: "anthropic/claude-sonnet-4-5",
    haiku: "anthropic/claude-haiku-4-5",
  },
  envVars: ["OPENROUTER_API_KEY"],
  packageName: "@openrouter/ai-sdk-provider",
  bundled: false,
  async load(modelId) {
    const mod = await importProvider(this.packageName, this.name, this.bundled);
    return mod.openrouter(modelId);
  },
};

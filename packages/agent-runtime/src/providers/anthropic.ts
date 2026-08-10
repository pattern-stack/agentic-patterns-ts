import { type ProviderProtocol, importProvider } from "./types.js";

export const anthropicProvider: ProviderProtocol = {
  name: "anthropic",
  tiers: {
    opus: "claude-opus-4-5",
    sonnet: "claude-sonnet-4-5",
    haiku: "claude-haiku-4-5",
  },
  envVars: ["ANTHROPIC_API_KEY"],
  packageName: "@ai-sdk/anthropic",
  // Bundled (#472): setting ANTHROPIC_API_KEY is enough to reach AgentRunner —
  // no second package for the consumer to discover and install.
  bundled: true,
  async load(modelId) {
    const mod = await importProvider(this.packageName, this.name, this.bundled);
    return mod.anthropic(modelId);
  },
};

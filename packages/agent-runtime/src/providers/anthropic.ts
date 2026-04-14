import { type ProviderProtocol, importProvider } from "./types.js";

export const anthropicProvider: ProviderProtocol = {
  name: "anthropic",
  tiers: {
    opus: "claude-opus-4-5",
    sonnet: "claude-sonnet-4-5",
    haiku: "claude-haiku-4-5",
  },
  envVars: ["ANTHROPIC_API_KEY"],
  async load(modelId) {
    const mod = await importProvider("@ai-sdk/anthropic", "anthropic");
    return mod.anthropic(modelId);
  },
};

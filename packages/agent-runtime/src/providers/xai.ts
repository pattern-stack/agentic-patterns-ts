import { type ProviderProtocol, importProvider } from "./types.js";

export const xaiProvider: ProviderProtocol = {
  name: "xai",
  tiers: {
    opus: "grok-4",
    sonnet: "grok-3",
    haiku: "grok-3-mini",
  },
  envVars: ["XAI_API_KEY"],
  async load(modelId) {
    const mod = await importProvider("@ai-sdk/xai", "xai");
    return mod.xai(modelId);
  },
};

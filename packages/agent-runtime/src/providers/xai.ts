import { type ProviderProtocol, importProvider } from "./types.js";

export const xaiProvider: ProviderProtocol = {
  name: "xai",
  tiers: {
    opus: "grok-4",
    sonnet: "grok-3",
    haiku: "grok-3-mini",
  },
  envVars: ["XAI_API_KEY"],
  packageName: "@ai-sdk/xai",
  bundled: false,
  async load(modelId) {
    const mod = await importProvider(this.packageName, this.name, this.bundled);
    return mod.xai(modelId);
  },
};

import { type ProviderProtocol, importProvider } from "./types.js";

export const mistralProvider: ProviderProtocol = {
  name: "mistral",
  tiers: {
    opus: "mistral-large-latest",
    sonnet: "mistral-medium-latest",
    haiku: "mistral-small-latest",
  },
  envVars: ["MISTRAL_API_KEY"],
  packageName: "@ai-sdk/mistral",
  bundled: false,
  async load(modelId) {
    const mod = await importProvider(this.packageName, this.name, this.bundled);
    return mod.mistral(modelId);
  },
};

import { type ProviderProtocol, importProvider } from "./types.js";

export const mistralProvider: ProviderProtocol = {
  name: "mistral",
  tiers: {
    opus: "mistral-large-latest",
    sonnet: "mistral-medium-latest",
    haiku: "mistral-small-latest",
  },
  envVars: ["MISTRAL_API_KEY"],
  async load(modelId) {
    const mod = await importProvider("@ai-sdk/mistral", "mistral");
    return mod.mistral(modelId);
  },
};

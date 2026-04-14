import { type ProviderProtocol, importProvider } from "./types.js";

export const openaiProvider: ProviderProtocol = {
  name: "openai",
  tiers: {
    opus: "gpt-4.1",
    sonnet: "gpt-4o",
    haiku: "gpt-4o-mini",
  },
  envVars: ["OPENAI_API_KEY"],
  async load(modelId) {
    const mod = await importProvider("@ai-sdk/openai", "openai");
    return mod.openai(modelId);
  },
};

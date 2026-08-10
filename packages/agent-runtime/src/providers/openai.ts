import { type ProviderProtocol, importProvider } from "./types.js";

export const openaiProvider: ProviderProtocol = {
  name: "openai",
  tiers: {
    opus: "gpt-4.1",
    sonnet: "gpt-4o",
    haiku: "gpt-4o-mini",
  },
  envVars: ["OPENAI_API_KEY"],
  packageName: "@ai-sdk/openai",
  // Bundled (#472): setting OPENAI_API_KEY is enough to reach AgentRunner.
  bundled: true,
  async load(modelId) {
    const mod = await importProvider(this.packageName, this.name, this.bundled);
    return mod.openai(modelId);
  },
};

import { type ProviderProtocol, importProvider } from "./types.js";

export const googleProvider: ProviderProtocol = {
  name: "google",
  tiers: {
    opus: "gemini-2.5-pro",
    sonnet: "gemini-2.5-flash",
    haiku: "gemini-2.5-flash-lite",
  },
  envVars: ["GOOGLE_GENERATIVE_AI_API_KEY", "GOOGLE_API_KEY"],
  packageName: "@ai-sdk/google",
  // Bundled (#472): setting GOOGLE_GENERATIVE_AI_API_KEY is enough to reach
  // AgentRunner.
  bundled: true,
  async load(modelId) {
    const mod = await importProvider(this.packageName, this.name, this.bundled);
    return mod.google(modelId);
  },
};

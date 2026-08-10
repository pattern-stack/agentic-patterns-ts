import { type ProviderProtocol, importProvider } from "./types.js";

export const groqProvider: ProviderProtocol = {
  name: "groq",
  tiers: {
    opus: "llama-3.3-70b-versatile",
    sonnet: "llama-3.1-70b-versatile",
    haiku: "llama-3.1-8b-instant",
  },
  envVars: ["GROQ_API_KEY"],
  packageName: "@ai-sdk/groq",
  bundled: false,
  async load(modelId) {
    const mod = await importProvider(this.packageName, this.name, this.bundled);
    return mod.groq(modelId);
  },
};

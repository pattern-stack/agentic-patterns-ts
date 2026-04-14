import { type ProviderProtocol, importProvider } from "./types.js";

export const googleProvider: ProviderProtocol = {
  name: "google",
  tiers: {
    opus: "gemini-2.5-pro",
    sonnet: "gemini-2.5-flash",
    haiku: "gemini-2.5-flash-lite",
  },
  envVars: ["GOOGLE_GENERATIVE_AI_API_KEY", "GOOGLE_API_KEY"],
  async load(modelId) {
    const mod = await importProvider("@ai-sdk/google", "google");
    return mod.google(modelId);
  },
};

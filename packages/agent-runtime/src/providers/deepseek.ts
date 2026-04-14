import { type ProviderProtocol, importProvider } from "./types.js";

export const deepseekProvider: ProviderProtocol = {
  name: "deepseek",
  tiers: {
    opus: "deepseek-reasoner",
    sonnet: "deepseek-chat",
    // DeepSeek has no dedicated small-fast model today; reuse chat.
    haiku: "deepseek-chat",
  },
  envVars: ["DEEPSEEK_API_KEY"],
  async load(modelId) {
    const mod = await importProvider("@ai-sdk/deepseek", "deepseek");
    return mod.deepseek(modelId);
  },
};

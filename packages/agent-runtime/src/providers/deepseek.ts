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
  packageName: "@ai-sdk/deepseek",
  bundled: false,
  async load(modelId) {
    const mod = await importProvider(this.packageName, this.name, this.bundled);
    return mod.deepseek(modelId);
  },
};

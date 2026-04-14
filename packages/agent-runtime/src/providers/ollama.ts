import { type ProviderProtocol, importProvider } from "./types.js";

/**
 * Ollama — local-only OSS models via HTTP.
 *
 * Default tier map uses the Qwen3 family because Qwen's team explicitly
 * prioritizes tool-calling and keeps the same grammar across sizes — so
 * agents scale between haiku↔sonnet↔opus without prompt changes.
 *
 * Sized for 16GB-class consumer GPUs (tested on 4080 Super):
 *   opus  (30B MoE, activates 3B/token)  — ~14 GB VRAM, 50–80 tok/s
 *   sonnet (14B dense)                   —  ~9 GB VRAM, 30–50 tok/s
 *   haiku  (4B dense)                    —  ~3 GB VRAM, 100+ tok/s
 *
 * Override with `options.modelId` if you want a different family.
 */
export const ollamaProvider: ProviderProtocol = {
  name: "ollama",
  tiers: {
    opus: "qwen3:30b-a3b",
    sonnet: "qwen3:14b",
    haiku: "qwen3:4b",
  },
  envVars: ["OLLAMA_HOST"],
  async load(modelId) {
    const mod = await importProvider("ollama-ai-provider", "ollama");
    // ollama-ai-provider doesn't read OLLAMA_HOST from env — pass it
    // explicitly so remote GPU boxes (e.g. behind a VPN) work out of
    // the box when the user sets the env var.
    const host = process.env.OLLAMA_HOST;
    // simulateStreaming: use the reliable non-streaming API (which
    // correctly returns tool_calls) wrapped in a stream interface.
    // Real streaming silently drops tool calls for many models.
    const settings = { simulateStreaming: true };
    if (host) {
      const baseURL = `${host.replace(/\/$/, "")}/api`;
      const provider = mod.createOllama({ baseURL });
      return provider(modelId, settings);
    }
    return mod.ollama(modelId, settings);
  },
};

import { type ProviderProtocol, importProvider } from "./types.js";

/**
 * Ollama — local-only OSS models via HTTP.
 *
 * Default tier map uses the qwen3.5/3.6 families because Qwen's team
 * explicitly prioritizes tool-calling and keeps the same grammar across
 * sizes — so agents scale between haiku↔sonnet↔opus without prompt
 * changes. Three sizes selected from a single bench pass on a 4080 Super-
 * class box:
 *
 *   opus   (35B MoE, activates 3B/token) — 15.1 GB VRAM + 10.5 GB RAM spill, ~15 tok/s
 *   sonnet (9B dense)                    —  8.2 GB VRAM, 0 spill,            ~98 tok/s
 *   haiku  (4B dense)                    —  3.4 GB VRAM, 0 spill,            ~145 tok/s
 *
 * Earlier qwen3:14b is the same speed class as 3.5:9b and worse at most
 * tool-calling tasks; 3.5:9b is preferred for the sonnet slot.
 *
 * Override with `options.modelId` (or `AGENT_MODEL` env) for any other
 * family — the tier map is just the default when nothing is pinned.
 */
export const ollamaProvider: ProviderProtocol = {
  name: "ollama",
  tiers: {
    opus: "qwen3.6:35b-a3b",
    sonnet: "qwen3.5:9b",
    haiku: "qwen3.5:4b",
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

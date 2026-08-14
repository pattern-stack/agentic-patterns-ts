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
  // AI SDK v5: the V1-only `ollama-ai-provider` is rejected by the v5 runtime;
  // we use the V2 fork `ollama-ai-provider-v2`. Its `createOllama` / default
  // `ollama` factory signature is unchanged at the `load()` call site.
  packageName: "ollama-ai-provider-v2",
  // Already a real dependency of @pattern-stack/agentic-runtime (predates #472).
  bundled: true,
  async load(modelId) {
    const mod = await importProvider(this.packageName, this.name, this.bundled);
    // The fork doesn't read OLLAMA_HOST from env — pass it explicitly so
    // remote GPU boxes (e.g. behind a VPN) work out of the box when the
    // user sets the env var.
    const host = process.env.OLLAMA_HOST;
    // Note: the v1 `{ simulateStreaming: true }` model-construction setting is
    // gone in the V2 fork — its streaming model returns tool calls correctly,
    // so the non-streaming-wrapper workaround is no longer needed. Per-request
    // tuning (num_ctx, think, …) now flows through `providerOptions.ollama`
    // at call time, which the config-driven provider factory (Part B) wires up.
    if (host) {
      const baseURL = `${host.replace(/\/$/, "")}/api`;
      const provider = mod.createOllama({ baseURL });
      return provider(modelId);
    }
    return mod.ollama(modelId);
  },
};

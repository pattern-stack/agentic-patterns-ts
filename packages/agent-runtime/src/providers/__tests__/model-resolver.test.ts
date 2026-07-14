/**
 * Tests for the ModelResolver — the seam that lets AgentRunner dispatch each
 * agent's *declared* model (agent.getModel()) instead of a model bound to the
 * runner. Covers pattern-match routing, profile precedence + aliasing,
 * the YAML loader, memoisation, and the AgentRunner integration (resolver
 * honours the agent; constant = back-compat).
 */

import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LanguageModelV2 } from "@ai-sdk/provider";
import { MockLanguageModelV2 } from "ai/test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AgentRunner } from "../../runner/agent-runner.js";
import type { AgentLike } from "../../runner/agent-runner.js";
import { createRunner } from "../../runner/create-runner.js";
import {
  anthropicProvider,
  googleProvider,
  isProviderTier,
  openaiProvider,
  resolveTierAlias,
} from "../index.js";
import {
  GATEWAY_AUTO_PREFIX,
  HybridModelResolver,
  ModelProfileSchema,
  type ModelResolver,
  constantModelResolver,
  createModelResolver,
  inferProvider,
  isModelResolver,
  loadModelProfiles,
  toGatewayModelId,
} from "../model-resolver.js";

// --- fixtures ---------------------------------------------------------------

/** A stand-in LanguageModelV2 — enough for routing assertions (never dispatched). */
function fakeModel(modelId: string): LanguageModelV2 {
  return { modelId, provider: "test", specificationVersion: "v2" } as unknown as LanguageModelV2;
}

function makeAgent(getModel: () => string): AgentLike {
  return {
    role: { name: "test-agent" },
    getModel,
    getTools: () => [],
    renderInitialPrompt: () => "system",
  };
}

function textModel(text: string): MockLanguageModelV2 {
  return new MockLanguageModelV2({
    doGenerate: async () => ({
      content: [{ type: "text", text }],
      finishReason: "stop",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      warnings: [],
    }),
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

// --- inferProvider ----------------------------------------------------------

describe("inferProvider", () => {
  it.each([
    ["claude-opus-4-8", "anthropic"],
    ["gpt-5.4-nano", "openai"],
    ["gpt-4o", "openai"],
    ["o3-mini", "openai"],
    ["chatgpt-4o-latest", "openai"],
    ["gemini-3.5-flash", "google"],
    ["grok-4", "xai"],
    ["deepseek-chat", "deepseek"],
    ["mistral-large-latest", "mistral"],
    ["mixtral-8x7b", "mistral"],
  ])("routes %s -> %s", (id, provider) => {
    expect(inferProvider(id)).toBe(provider);
  });

  it.each([
    ["llama-3.1-70b"],
    ["qwen3:4b"],
    ["gemma-2-9b"],
    ["anthropic/claude-3.5"],
    ["mystery-model"],
  ])("returns undefined for ambiguous/unknown id %s", (id) => {
    expect(inferProvider(id)).toBeUndefined();
  });
});

// --- constantModelResolver / isModelResolver --------------------------------

describe("constantModelResolver / isModelResolver", () => {
  it("constant resolver returns the same model for any id", async () => {
    const m = fakeModel("fixed");
    const r = constantModelResolver(m);
    expect(await r.resolve("anything")).toBe(m);
    expect(await r.resolve("else")).toBe(m);
  });

  it("isModelResolver distinguishes a resolver from a model", () => {
    expect(isModelResolver({ resolve: async () => fakeModel("x") })).toBe(true);
    expect(isModelResolver(fakeModel("x"))).toBe(false);
  });
});

// --- HybridModelResolver ----------------------------------------------------

describe("HybridModelResolver", () => {
  it("routes a bare vendor-prefixed id to the inferred provider", async () => {
    const spy = vi.spyOn(anthropicProvider, "load").mockResolvedValue(fakeModel("claude"));
    const r = new HybridModelResolver();
    const m = await r.resolve("claude-sonnet-4-8");
    expect(spy).toHaveBeenCalledWith("claude-sonnet-4-8");
    expect(m.modelId).toBe("claude");
  });

  it("uses a profile's upstream `model`, not the key", async () => {
    const spy = vi.spyOn(anthropicProvider, "load").mockResolvedValue(fakeModel("claude-haiku"));
    const r = new HybridModelResolver({
      profiles: { fast: { provider: "anthropic", model: "claude-haiku-4" } },
    });
    await r.resolve("fast");
    expect(spy).toHaveBeenCalledWith("claude-haiku-4");
  });

  it("a profile wins over the pattern match", async () => {
    const aSpy = vi.spyOn(anthropicProvider, "load").mockResolvedValue(fakeModel("a"));
    const oSpy = vi.spyOn(openaiProvider, "load").mockResolvedValue(fakeModel("gpt"));
    // id looks like an anthropic model, but a profile reroutes it to openai
    const r = new HybridModelResolver({
      profiles: { "claude-weird": { provider: "openai", model: "gpt-x" } },
    });
    await r.resolve("claude-weird");
    expect(oSpy).toHaveBeenCalledWith("gpt-x");
    expect(aSpy).not.toHaveBeenCalled();
  });

  it("memoises by id — one build per id", async () => {
    const spy = vi.spyOn(anthropicProvider, "load").mockResolvedValue(fakeModel("c"));
    const r = new HybridModelResolver();
    const a = await r.resolve("claude-x");
    const b = await r.resolve("claude-x");
    expect(a).toBe(b);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("evicts a failed build so a later resolve retries", async () => {
    const spy = vi
      .spyOn(anthropicProvider, "load")
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(fakeModel("c"));
    const r = new HybridModelResolver();
    await expect(r.resolve("claude-x")).rejects.toThrow("boom");
    const m = await r.resolve("claude-x");
    expect(m.modelId).toBe("c");
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("register() replaces a profile and invalidates the cache", async () => {
    const aSpy = vi.spyOn(anthropicProvider, "load").mockResolvedValue(fakeModel("a"));
    const oSpy = vi.spyOn(openaiProvider, "load").mockResolvedValue(fakeModel("o"));
    const r = new HybridModelResolver({
      profiles: { x: { provider: "anthropic", model: "claude-a" } },
    });
    await r.resolve("x");
    expect(aSpy).toHaveBeenCalledWith("claude-a");
    r.register("x", { provider: "openai", model: "gpt-o" });
    await r.resolve("x");
    expect(oSpy).toHaveBeenCalledWith("gpt-o");
  });

  it("throws a helpful error for an unknown id, listing registered profiles", async () => {
    const r = new HybridModelResolver({ profiles: { known: { provider: "anthropic" } } });
    await expect(r.resolve("mystery-xyz")).rejects.toThrow(/cannot resolve model id "mystery-xyz"/);
    await expect(r.resolve("mystery-xyz")).rejects.toThrow(/known/);
  });

  it("rejects gateway fields (baseURL/apiKey/headers) — gateway support removed", () => {
    // These used to configure an openai-compatible endpoint; that kind is gone,
    // so the strict schema rejects them as unknown keys (and TS rejects them too).
    expect(() =>
      ModelProfileSchema.parse({ provider: "openai", baseURL: "https://gw/v1" }),
    ).toThrow();
    expect(() => ModelProfileSchema.parse({ provider: "openai", apiKey: "sk" })).toThrow();
    expect(() => ModelProfileSchema.parse({ provider: "openai", headers: {} })).toThrow();
  });

  it("a stale failed build does not evict a newer cached entry", async () => {
    // Reproduces the identity-guard race: build A (failing, in-flight) is
    // displaced by register()+build B (good); A's late rejection must NOT evict B.
    let rejectA!: (e: Error) => void;
    const aHangs = new Promise<LanguageModelV2>((_, rej) => {
      rejectA = rej;
    });
    const spy = vi
      .spyOn(anthropicProvider, "load")
      .mockReturnValueOnce(aHangs)
      .mockResolvedValueOnce(fakeModel("B"));

    const r = new HybridModelResolver({
      profiles: { x: { provider: "anthropic", model: "claude-a" } },
    });
    const pA = r.resolve("x"); // starts + caches build A
    pA.catch(() => {}); // swallow A's eventual rejection on this handle
    r.register("x", { provider: "anthropic", model: "claude-b" }); // invalidates cached A
    const b = await r.resolve("x"); // cache-miss → build B (good), cached
    expect(b.modelId).toBe("B");

    rejectA(new Error("late A failure")); // A's catch fires now
    await Promise.resolve();
    await Promise.resolve();

    const b2 = await r.resolve("x"); // B must have survived → no rebuild
    expect(b2).toBe(b);
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

// --- ModelProfileSchema -----------------------------------------------------

describe("ModelProfileSchema", () => {
  it("accepts a valid profile", () => {
    expect(() => ModelProfileSchema.parse({ provider: "openai", model: "gpt-4o" })).not.toThrow();
  });
  it("rejects an unknown provider", () => {
    expect(() => ModelProfileSchema.parse({ provider: "nope" })).toThrow();
  });
  it("rejects unknown keys (strict)", () => {
    expect(() => ModelProfileSchema.parse({ provider: "openai", bogus: 1 })).toThrow();
  });
});

// --- GatewayConfig (gateway routing) ----------------------------------------

describe("GatewayConfig — gateway routing", () => {
  const GW = { baseURL: "https://gw.example/v1", apiKey: "sk-test" };

  it("routes a non-profile id through the gateway (real adapter, no network)", async () => {
    const aSpy = vi.spyOn(anthropicProvider, "load").mockResolvedValue(fakeModel("direct"));
    // The id pattern-matches anthropic, but the gateway short-circuits first.
    const r = new HybridModelResolver({ gateway: GW });
    const m = await r.resolve("claude-sonnet-4-5");
    expect(m.modelId).toBe("claude-sonnet-4-5"); // passed through to the gateway
    expect(aSpy).not.toHaveBeenCalled(); // did NOT go direct to anthropic
  });

  it("modelPrefix qualifies the id", async () => {
    const r = new HybridModelResolver({ gateway: { ...GW, modelPrefix: "anthropic/" } });
    const m = await r.resolve("claude-sonnet-4-5");
    expect(m.modelId).toBe("anthropic/claude-sonnet-4-5");
  });

  it("qualify() overrides modelPrefix", async () => {
    const r = new HybridModelResolver({
      gateway: { ...GW, modelPrefix: "ignored/", qualify: (id) => `virt:${id}` },
    });
    const m = await r.resolve("gpt-4o");
    expect(m.modelId).toBe("virt:gpt-4o");
  });

  it("a profile still wins over the gateway (per-id escape hatch)", async () => {
    const aSpy = vi.spyOn(anthropicProvider, "load").mockResolvedValue(fakeModel("direct"));
    const r = new HybridModelResolver({
      gateway: GW,
      profiles: { "pin-direct": { provider: "anthropic", model: "claude-x" } },
    });
    const m = await r.resolve("pin-direct");
    expect(aSpy).toHaveBeenCalledWith("claude-x");
    expect(m.modelId).toBe("direct");
  });

  it("apiKeyEnv is read at resolve time", async () => {
    vi.stubEnv("GW_KEY", "sk-from-env");
    const r = new HybridModelResolver({
      gateway: { baseURL: "https://gw.example/v1", apiKeyEnv: "GW_KEY" },
    });
    const m = await r.resolve("any-model");
    expect(m.modelId).toBe("any-model");
  });

  it("createModelResolver passes the gateway through", async () => {
    const r = await createModelResolver({ gateway: GW });
    const m = await r.resolve("some-model");
    expect(m.modelId).toBe("some-model");
  });

  it("createRunner picks up AP_GATEWAY_BASE_URL from env", async () => {
    vi.stubEnv("AP_GATEWAY_BASE_URL", "https://gw.example/v1");
    const { source, reason } = await createRunner({ verbose: false });
    expect(source).toBe("model-resolver");
    expect(reason).toContain("gateway https://gw.example/v1");
  });
});

// --- Gateway id translation (#244) ------------------------------------------
//
// The contract: an agent declares a model ONCE and it runs on a direct provider
// AND through a gateway. Tier words are not addressable upstream, so the gateway
// path must translate them — a raw "haiku" reaching a gateway is a 400 (verified
// against the dev Bifrost: `no providers found for model "haiku" ... to auto-resolve`).
// Bare CANONICAL ids, by contrast, are auto-resolved by such gateways against their
// own catalog (verified: `gemini-3.1-flash-lite` → 200 unprefixed), so prefixing
// stays opt-in and must never be forced onto a working path.

describe("toGatewayModelId — declared id → gateway id", () => {
  const GW = { baseURL: "https://gw.example/v1", apiKey: "sk-test" };

  it("resolves a tier alias to a canonical id via the default (anthropic) tier map", () => {
    expect(toGatewayModelId("haiku", GW)).toBe("claude-haiku-4-5");
    expect(toGatewayModelId("sonnet", GW)).toBe("claude-sonnet-4-5");
    expect(toGatewayModelId("opus", GW)).toBe("claude-opus-4-5");
  });

  it("tierProvider selects whose tier ladder a tier word climbs", () => {
    const gw = { ...GW, tierProvider: "google" as const };
    expect(toGatewayModelId("haiku", gw)).toBe("gemini-2.5-flash-lite");
    expect(toGatewayModelId("opus", gw)).toBe("gemini-2.5-pro");
  });

  it("reads the SAME tier map as the direct path (no second source of truth)", () => {
    expect(toGatewayModelId("haiku", GW)).toBe(anthropicProvider.tiers.haiku);
    expect(toGatewayModelId("haiku", { ...GW, tierProvider: "google" })).toBe(
      googleProvider.tiers.haiku,
    );
  });

  it("passes a bare canonical id through untouched (the path that works today)", () => {
    expect(toGatewayModelId("gemini-3.1-flash-lite", GW)).toBe("gemini-3.1-flash-lite");
    expect(toGatewayModelId("gpt-4o-mini", GW)).toBe("gpt-4o-mini");
  });

  it("never double-prefixes an id that already carries a / segment", () => {
    expect(
      toGatewayModelId("gemini/gemini-3.1-flash-lite", { ...GW, modelPrefix: "openai/" }),
    ).toBe("gemini/gemini-3.1-flash-lite");
    expect(
      toGatewayModelId("anthropic/claude-haiku-4-5", { ...GW, modelPrefix: GATEWAY_AUTO_PREFIX }),
    ).toBe("anthropic/claude-haiku-4-5");
  });

  it("a literal modelPrefix qualifies the CANONICAL id, not the alias", () => {
    const gw = { ...GW, modelPrefix: "anthropic/" };
    expect(toGatewayModelId("haiku", gw)).toBe("anthropic/claude-haiku-4-5");
    expect(toGatewayModelId("claude-sonnet-4-5", gw)).toBe("anthropic/claude-sonnet-4-5");
  });

  it('modelPrefix "auto" derives the vendor segment per id', () => {
    const gw = { ...GW, modelPrefix: GATEWAY_AUTO_PREFIX };
    expect(toGatewayModelId("gpt-4o", gw)).toBe("openai/gpt-4o");
    expect(toGatewayModelId("gemini-3.1-flash-lite", gw)).toBe("google/gemini-3.1-flash-lite");
    expect(toGatewayModelId("haiku", gw)).toBe("anthropic/claude-haiku-4-5"); // alias → canonical → vendor
  });

  it('modelPrefix "auto" fails loud on an unclassifiable id, telling the translation story', () => {
    const gw = { ...GW, modelPrefix: GATEWAY_AUTO_PREFIX };
    expect(() => toGatewayModelId("llama-3.3-70b", gw)).toThrow(
      /cannot translate model id "llama-3.3-70b"/,
    );
    // The story: what was tried, and each way to make it resolvable.
    expect(() => toGatewayModelId("llama-3.3-70b", gw)).toThrow(/matched no known vendor prefix/);
    expect(() => toGatewayModelId("llama-3.3-70b", gw)).toThrow(/resolver\.register/);
    expect(() => toGatewayModelId("llama-3.3-70b", gw)).toThrow(/models\.yaml/);
    expect(() => toGatewayModelId("llama-3.3-70b", gw)).toThrow(/AP_GATEWAY_MODEL_PREFIX/);
  });

  it("qualify() receives the canonical id — a custom qualifier never re-implements tiers", () => {
    const seen: string[] = [];
    const gw = {
      ...GW,
      modelPrefix: "ignored/",
      qualify: (id: string) => {
        seen.push(id);
        return `virt:${id}`;
      },
    };
    expect(toGatewayModelId("haiku", gw)).toBe("virt:claude-haiku-4-5");
    expect(seen).toEqual(["claude-haiku-4-5"]);
  });
});

describe("gateway id translation — end to end through the resolver", () => {
  const GW = { baseURL: "https://gw.example/v1", apiKey: "sk-test" };

  it("an agent declaring a tier alias dispatches a real model id (the #244 bug)", async () => {
    const r = new HybridModelResolver({ gateway: GW });
    const m = await r.resolve("haiku");
    expect(m.modelId).toBe("claude-haiku-4-5"); // NOT the raw "haiku" that 400s
  });

  it("a bare canonical id still reaches the gateway unprefixed (no regression)", async () => {
    const r = new HybridModelResolver({ gateway: GW });
    const m = await r.resolve("gemini-3.1-flash-lite");
    expect(m.modelId).toBe("gemini-3.1-flash-lite");
  });

  it("an untranslatable id in auto mode rejects instead of dispatching a guess", async () => {
    const r = new HybridModelResolver({
      gateway: { ...GW, modelPrefix: GATEWAY_AUTO_PREFIX },
    });
    await expect(r.resolve("llama-3.3-70b")).rejects.toThrow(/cannot translate model id/);
  });

  it("a profile still wins over gateway translation (top precedence, unchanged)", async () => {
    const aSpy = vi.spyOn(anthropicProvider, "load").mockResolvedValue(fakeModel("direct"));
    const r = new HybridModelResolver({
      gateway: { ...GW, modelPrefix: GATEWAY_AUTO_PREFIX },
      profiles: { haiku: { provider: "anthropic", model: "claude-haiku-4-5" } },
    });
    const m = await r.resolve("haiku");
    expect(m.modelId).toBe("direct");
    expect(aSpy).toHaveBeenCalledWith("claude-haiku-4-5");
  });

  it("createRunner reads AP_GATEWAY_TIER_PROVIDER from env", async () => {
    vi.stubEnv("AP_GATEWAY_BASE_URL", "https://gw.example/v1");
    vi.stubEnv("AP_GATEWAY_TIER_PROVIDER", "google");
    const { runner } = await createRunner({ verbose: false });
    const resolver = (runner as unknown as { _resolver: ModelResolver })._resolver;
    const m = await resolver.resolve("haiku");
    expect(m.modelId).toBe("gemini-2.5-flash-lite");
  });

  it("createRunner rejects a typo'd AP_GATEWAY_TIER_PROVIDER rather than silently defaulting", async () => {
    vi.stubEnv("AP_GATEWAY_BASE_URL", "https://gw.example/v1");
    vi.stubEnv("AP_GATEWAY_TIER_PROVIDER", "gemini"); // catalog spelling, not a provider name
    await expect(createRunner({ verbose: false })).rejects.toThrow(
      /AP_GATEWAY_TIER_PROVIDER="gemini" is not a supported provider/,
    );
  });
});

// --- Tier alias primitive (providers/index) ---------------------------------

describe("isProviderTier / resolveTierAlias", () => {
  it("classifies the three tier words, case-insensitively", () => {
    expect(isProviderTier("haiku")).toBe(true);
    expect(isProviderTier("SONNET")).toBe(true);
    expect(isProviderTier("claude-haiku-4-5")).toBe(false);
  });

  it("maps a tier word through a provider's ladder and leaves real ids alone", () => {
    expect(resolveTierAlias("opus", anthropicProvider)).toBe("claude-opus-4-5");
    expect(resolveTierAlias("opus", googleProvider)).toBe("gemini-2.5-pro");
    expect(resolveTierAlias("gpt-4o", openaiProvider)).toBe("gpt-4o");
  });
});

// --- loadModelProfiles / createModelResolver --------------------------------

describe("loadModelProfiles / createModelResolver", () => {
  it("loads + validates a models.yaml and merges in-code profiles over it", async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), "ap-mr-"));
    const file = join(dir, "models.yaml");
    await fs.writeFile(
      file,
      [
        "slow:",
        "  provider: openai",
        "  model: gpt-4o",
        "fast:",
        "  provider: anthropic",
        "  model: claude-haiku-4",
      ].join("\n"),
    );

    const profiles = await loadModelProfiles(file);
    expect(profiles.slow?.provider).toBe("openai");
    expect(profiles.fast?.model).toBe("claude-haiku-4");

    const oSpy = vi.spyOn(openaiProvider, "load").mockResolvedValue(fakeModel("gpt-x"));
    // in-code profile for `fast` (openai) overrides the yaml one (anthropic)
    const r = await createModelResolver({
      modelsPath: file,
      profiles: { fast: { provider: "openai", model: "gpt-x" } },
    });
    expect(r.has("slow")).toBe(true);
    await r.resolve("fast");
    expect(oSpy).toHaveBeenCalledWith("gpt-x");

    await fs.rm(dir, { recursive: true, force: true });
  });

  it("rejects an invalid models.yaml", async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), "ap-mr-"));
    const file = join(dir, "bad.yaml");
    await fs.writeFile(file, "x:\n  provider: not-a-provider\n");
    await expect(loadModelProfiles(file)).rejects.toThrow();
    await fs.rm(dir, { recursive: true, force: true });
  });
});

// --- AgentRunner integration ------------------------------------------------

describe("AgentRunner × ModelResolver", () => {
  it("resolver-backed runner dispatches the agent's declared model", async () => {
    const asked: (string | undefined)[] = [];
    const resolver: ModelResolver = {
      resolve: async (id) => {
        asked.push(id);
        return textModel("ok");
      },
    };
    const runner = new AgentRunner(resolver);
    const result = await runner.run(
      makeAgent(() => "agent-declared-model"),
      "hi",
    );
    expect(asked).toEqual(["agent-declared-model"]);
    expect(result.response).toBe("ok");
  });

  it("constant (LanguageModelV2) runner keeps working and ignores the agent's id (back-compat)", async () => {
    const runner = new AgentRunner(textModel("pinned"));
    const result = await runner.run(
      makeAgent(() => "whatever-the-agent-says"),
      "hi",
    );
    expect(result.response).toBe("pinned");
  });
});

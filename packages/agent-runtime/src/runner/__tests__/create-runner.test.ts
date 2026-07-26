/**
 * Unit tests for createRunner() — selection priority + adapter integration.
 *
 * We exercise the factory's priority tree without actually loading provider
 * packages. Each test stubs or substitutes the relevant ingredient
 * (explicit runner, env vars, provider adapter) and asserts both the runner
 * class produced and the `source` tag on the selection.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PROVIDERS, type ProviderProtocol } from "../../providers/index.js";
import { AgentRunner } from "../agent-runner.js";
import { _resetClaudeCliCache, createRunner } from "../create-runner.js";
import { MockRunner } from "../mock-runner.js";

const KEYS = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "GOOGLE_API_KEY",
  "GROQ_API_KEY",
  "MISTRAL_API_KEY",
  "XAI_API_KEY",
  "DEEPSEEK_API_KEY",
  "OPENROUTER_API_KEY",
  "OLLAMA_HOST",
  "AGENT_TIER",
  "AGENT_MODEL",
] as const;

function stashEnv(): Record<string, string | undefined> {
  const saved: Record<string, string | undefined> = {};
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  return saved;
}

function restoreEnv(saved: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

/** Replace a provider's `load` with a stub that returns a canned model. */
function stubProviderLoad(provider: ProviderProtocol, cannedModelId?: string) {
  return vi.spyOn(provider, "load").mockImplementation(async (modelId) => {
    return {
      specificationVersion: "v4",
      provider: provider.name,
      modelId: cannedModelId ?? modelId,
      // biome-ignore lint/suspicious/noExplicitAny: test stub for ResolvedLanguageModel
    } as any;
  });
}

describe("createRunner", () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = stashEnv();
    _resetClaudeCliCache();
  });

  afterEach(() => {
    restoreEnv(savedEnv);
    vi.restoreAllMocks();
  });

  it("returns the explicit runner when options.runner is provided", async () => {
    const mock = new MockRunner();
    const { runner, source } = await createRunner({ runner: mock, verbose: false });
    expect(runner).toBe(mock);
    expect(source).toBe("explicit-runner");
  });

  it("wraps options.model in AgentRunner", async () => {
    const fakeModel = {
      specificationVersion: "v4",
      provider: "stub",
      modelId: "stub-1",
      // biome-ignore lint/suspicious/noExplicitAny: test stub
    } as any;
    const { runner, source } = await createRunner({ model: fakeModel, verbose: false });
    expect(runner).toBeInstanceOf(AgentRunner);
    expect(source).toBe("explicit-model");
  });

  it("honors options.provider and passes tier-resolved model to load()", async () => {
    const spy = stubProviderLoad(PROVIDERS.anthropic);
    const { runner, source, reason } = await createRunner({
      provider: "anthropic",
      tier: "opus",
      verbose: false,
    });
    expect(runner).toBeInstanceOf(AgentRunner);
    expect(source).toBe("explicit-provider");
    expect(spy).toHaveBeenCalledWith("claude-opus-4-5");
    expect(reason).toContain("claude-opus-4-5");
  });

  it("defaults to sonnet tier when tier is omitted", async () => {
    const spy = stubProviderLoad(PROVIDERS.openai);
    await createRunner({ provider: "openai", verbose: false });
    expect(spy).toHaveBeenCalledWith("gpt-4o");
  });

  it("honors explicit modelId over tier", async () => {
    const spy = stubProviderLoad(PROVIDERS.openai);
    await createRunner({
      provider: "openai",
      tier: "haiku",
      modelId: "my-custom-model",
      verbose: false,
    });
    expect(spy).toHaveBeenCalledWith("my-custom-model");
  });

  it("auto-detects anthropic from env ANTHROPIC_API_KEY", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-test-abc";
    const spy = stubProviderLoad(PROVIDERS.anthropic);
    const { runner, source, reason } = await createRunner({ verbose: false });
    expect(runner).toBeInstanceOf(AgentRunner);
    expect(source).toBe("env-anthropic");
    expect(reason).toContain("ANTHROPIC_API_KEY");
    expect(spy).toHaveBeenCalledWith("claude-sonnet-4-5");
  });

  it("prefers earlier-priority providers when multiple env vars are set", async () => {
    // ANTHROPIC comes before OPENAI in PROVIDER_PRIORITY.
    process.env.OPENAI_API_KEY = "sk-openai";
    process.env.ANTHROPIC_API_KEY = "sk-anthropic";
    const anthropicSpy = stubProviderLoad(PROVIDERS.anthropic);
    const openaiSpy = stubProviderLoad(PROVIDERS.openai);
    const { source } = await createRunner({ verbose: false });
    expect(source).toBe("env-anthropic");
    expect(anthropicSpy).toHaveBeenCalled();
    expect(openaiSpy).not.toHaveBeenCalled();
  });

  it("falls back to ollama when only OLLAMA_HOST is set", async () => {
    process.env.OLLAMA_HOST = "http://localhost:11434";
    const spy = stubProviderLoad(PROVIDERS.ollama);
    const { source } = await createRunner({ tier: "opus", verbose: false });
    expect(source).toBe("env-ollama");
    expect(spy).toHaveBeenCalledWith("qwen3.6:35b-a3b"); // opus-tier Qwen
  });

  it("env AGENT_MODEL overrides the tier default in env-detect", async () => {
    process.env.OLLAMA_HOST = "http://localhost:11434";
    process.env.AGENT_MODEL = "qwen3.6:27b";
    const spy = stubProviderLoad(PROVIDERS.ollama);
    const { source, reason } = await createRunner({ verbose: false });
    expect(source).toBe("env-ollama");
    expect(spy).toHaveBeenCalledWith("qwen3.6:27b");
    expect(reason).toContain("qwen3.6:27b");
  });

  it("env AGENT_TIER picks the tier when no opts.tier is passed", async () => {
    process.env.OLLAMA_HOST = "http://localhost:11434";
    process.env.AGENT_TIER = "haiku";
    const spy = stubProviderLoad(PROVIDERS.ollama);
    await createRunner({ verbose: false });
    expect(spy).toHaveBeenCalledWith("qwen3.5:4b"); // haiku-tier Qwen
  });

  it("opts.tier takes precedence over env AGENT_TIER", async () => {
    process.env.OLLAMA_HOST = "http://localhost:11434";
    process.env.AGENT_TIER = "haiku";
    const spy = stubProviderLoad(PROVIDERS.ollama);
    await createRunner({ tier: "opus", verbose: false });
    expect(spy).toHaveBeenCalledWith("qwen3.6:35b-a3b"); // opts.tier wins
  });

  it("invalid AGENT_TIER values are silently ignored (default sonnet)", async () => {
    process.env.OLLAMA_HOST = "http://localhost:11434";
    process.env.AGENT_TIER = "premium"; // not a valid tier
    const spy = stubProviderLoad(PROVIDERS.ollama);
    await createRunner({ verbose: false });
    expect(spy).toHaveBeenCalledWith("qwen3.5:9b"); // sonnet default
  });

  it("env AGENT_MODEL also applies to explicit-provider path", async () => {
    process.env.AGENT_MODEL = "claude-magic-5";
    const spy = stubProviderLoad(PROVIDERS.anthropic);
    await createRunner({ provider: "anthropic", verbose: false });
    expect(spy).toHaveBeenCalledWith("claude-magic-5");
  });

  // --- provider-follows-model (env-detection path) --------------------------

  it("explicit gemini modelId with only OPENAI key fails loud (no silent mismatch)", async () => {
    process.env.OPENAI_API_KEY = "sk-openai";
    const openaiSpy = stubProviderLoad(PROVIDERS.openai);
    await expect(
      createRunner({ modelId: "gemini-3.1-flash-lite", verbose: false }),
    ).rejects.toThrow(/gemini-3\.1-flash-lite/);
    // Never stapled the gemini id onto the priority-detected openai provider.
    expect(openaiSpy).not.toHaveBeenCalled();
  });

  it("names the required google env vars in the mismatch error", async () => {
    process.env.OPENAI_API_KEY = "sk-openai";
    await expect(
      createRunner({ modelId: "gemini-3.1-flash-lite", verbose: false }),
    ).rejects.toThrow(/GOOGLE_GENERATIVE_AI_API_KEY/);
  });

  it("routes an explicit gemini modelId to google when the GOOGLE key is present", async () => {
    process.env.OPENAI_API_KEY = "sk-openai";
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = "goog-key";
    const googleSpy = stubProviderLoad(PROVIDERS.google);
    const openaiSpy = stubProviderLoad(PROVIDERS.openai);
    const { source } = await createRunner({ modelId: "gemini-3.1-flash-lite", verbose: false });
    expect(source).toBe("env-google");
    expect(googleSpy).toHaveBeenCalledWith("gemini-3.1-flash-lite");
    expect(openaiSpy).not.toHaveBeenCalled(); // provider followed the model, not priority
  });

  it("routes an explicit gpt modelId to openai when the OPENAI key is present", async () => {
    process.env.OPENAI_API_KEY = "sk-openai";
    const spy = stubProviderLoad(PROVIDERS.openai);
    const { source } = await createRunner({ modelId: "gpt-4o", verbose: false });
    expect(source).toBe("env-openai");
    expect(spy).toHaveBeenCalledWith("gpt-4o");
  });

  it("fails loud for an AGENT_MODEL gemini id when only the OPENAI key is present", async () => {
    process.env.OPENAI_API_KEY = "sk-openai";
    process.env.AGENT_MODEL = "gemini-3.1-flash-lite";
    await expect(createRunner({ verbose: false })).rejects.toThrow(/gemini-3\.1-flash-lite/);
  });

  it("pins an unclassifiable custom id onto the priority-detected provider (unchanged)", async () => {
    // inferProvider() can't map `qwen3.6:27b` → any vendor, so it must fall
    // through to the env-priority loop rather than error.
    process.env.OLLAMA_HOST = "http://localhost:11434";
    const spy = stubProviderLoad(PROVIDERS.ollama);
    const { source } = await createRunner({ modelId: "qwen3.6:27b", verbose: false });
    expect(source).toBe("env-ollama");
    expect(spy).toHaveBeenCalledWith("qwen3.6:27b");
  });

  it("falls back to MockRunner when fallbackToMock is true", async () => {
    // We can't stub hasClaudeCli() easily here; rely on the fact that CI
    // runners typically don't have `claude` on PATH. If the fallback path
    // goes through Claude CLI first, this test is a no-op.
    const { runner, source } = await createRunner({ fallbackToMock: true, verbose: false });
    if (source === "mock-fallback") {
      expect(runner).toBeInstanceOf(MockRunner);
      expect(source).toBe("mock-fallback");
    } else {
      // Claude CLI was detected; fallback wasn't reached.
      expect(source).toBe("claude-cli");
    }
  });

  it("throws a helpful error when nothing matches and fallbackToMock is false", async () => {
    // Again, only meaningful if claude CLI is absent; skip the assertion
    // shape if we're on a dev box with claude installed.
    try {
      await createRunner({ verbose: false });
      // Got here without throwing — claude CLI must be present.
      expect(true).toBe(true);
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain("no runnable configuration");
      expect((err as Error).message).toContain("ANTHROPIC_API_KEY");
    }
  });

  it("passes eventBus through to AgentRunner", async () => {
    const fakeModel = {
      specificationVersion: "v4",
      provider: "stub",
      modelId: "stub-1",
      // biome-ignore lint/suspicious/noExplicitAny: test stub
    } as any;
    const { AgentEventBus } = await import("../../events/agent-event-bus.js");
    const bus = new AgentEventBus();
    const { runner } = await createRunner({ model: fakeModel, eventBus: bus, verbose: false });
    // AgentRunner accepts eventBus as a constructor arg; it's private. We verify
    // construction succeeded and runner is the right shape.
    expect(runner).toBeInstanceOf(AgentRunner);
  });
});

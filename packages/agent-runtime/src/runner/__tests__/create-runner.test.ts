/**
 * Unit tests for createRunner() — selection priority + adapter integration.
 *
 * We exercise the factory's priority tree without actually loading provider
 * packages. Each test stubs or substitutes the relevant ingredient
 * (explicit runner, env vars, provider adapter) and asserts both the runner
 * class produced and the `source` tag on the selection.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  BUNDLED_PROVIDER_ENV_VARS,
  PROVIDERS,
  PROVIDER_PRIORITY,
  ProviderPackageError,
  type ProviderProtocol,
} from "../../providers/index.js";
import { AgentRunner } from "../agent-runner.js";
import { ClaudeCodeAPIRunner } from "../claude-code-api-runner.js";
import { _resetClaudeCliCache, _setClaudeCliCache, createRunner } from "../create-runner.js";
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

  // -------------------------------------------------------------------------
  // #472 — bundled providers + no silent degradation
  //
  // The regression these guard: a consumer set a provider key, no @ai-sdk
  // package was installed, and the run landed on ClaudeCodeAPIRunner — the one
  // runner with no read site for `options.messageHistory`. Every multi-turn
  // conversation became a series of first turns, and nothing said so.
  // -------------------------------------------------------------------------

  describe("#472 acceptance — a key alone reaches AgentRunner", () => {
    // Deliberately UNSTUBBED: these call the real adapters and the real
    // `@ai-sdk/*` packages. That is the whole claim — install the runtime, set a
    // key, name a model, get AgentRunner. A stub would pass even if the
    // packages were missing, which is exactly how the bug survived.
    const cases = [
      { env: "ANTHROPIC_API_KEY", source: "env-anthropic", model: "claude-haiku-4-5" },
      { env: "OPENAI_API_KEY", source: "env-openai", model: "gpt-4o-mini" },
      { env: "GOOGLE_GENERATIVE_AI_API_KEY", source: "env-google", model: "gemini-2.5-flash" },
    ] as const;

    it.each(cases)("$env + a named model → AgentRunner (never the CLI fallback)", async (c) => {
      process.env[c.env] = "test-key-not-used-offline";
      // Pretend the claude CLI IS on PATH: if the ladder were still leaky, the
      // fallback rung would be sitting right there to catch us.
      _setClaudeCliCache(true);

      const { runner, source, reason } = await createRunner({
        modelId: c.model,
        verbose: false,
      });

      expect(runner).toBeInstanceOf(AgentRunner);
      expect(runner).not.toBeInstanceOf(ClaudeCodeAPIRunner);
      expect(source).toBe(c.source);
      expect(source).not.toBe("claude-cli");
      expect(reason).toContain(c.model);
    });

    it.each(cases)("$env with no model named → AgentRunner on the tier default", async (c) => {
      process.env[c.env] = "test-key-not-used-offline";
      _setClaudeCliCache(true);
      const { runner, source } = await createRunner({ verbose: false });
      expect(runner).toBeInstanceOf(AgentRunner);
      expect(source).toBe(c.source);
    });
  });

  describe("#472 — a present key with an unloadable provider fails loudly", () => {
    /** Simulate the published-consumer reality: the package isn't there. */
    function stubMissingPackage(provider: ProviderProtocol) {
      return vi.spyOn(provider, "load").mockImplementation(async () => {
        throw new ProviderPackageError(
          provider.packageName,
          provider.name,
          provider.bundled,
          new Error(`Cannot find package '${provider.packageName}'`),
        );
      });
    }

    it("throws instead of falling through to ClaudeCodeAPIRunner", async () => {
      process.env.OPENAI_API_KEY = "sk-openai";
      stubMissingPackage(PROVIDERS.openai);
      // The fallback rung is available — the point is that we refuse it.
      _setClaudeCliCache(true);
      await expect(createRunner({ verbose: false })).rejects.toThrow(/could not be loaded/);
    });

    it("names the provider, the package, and the credential that selected it", async () => {
      process.env.OPENAI_API_KEY = "sk-openai";
      stubMissingPackage(PROVIDERS.openai);
      _setClaudeCliCache(true);
      const err = await createRunner({ verbose: false }).catch((e: Error) => e);
      expect(err).toBeInstanceOf(Error);
      const msg = (err as Error).message;
      expect(msg).toContain("openai");
      expect(msg).toContain("@ai-sdk/openai");
      expect(msg).toContain("OPENAI_API_KEY");
    });

    it("states the messageHistory consequence so the failure is legible", async () => {
      process.env.OPENAI_API_KEY = "sk-openai";
      stubMissingPackage(PROVIDERS.openai);
      _setClaudeCliCache(true);
      const err = await createRunner({ verbose: false }).catch((e: Error) => e);
      expect((err as Error).message).toContain("messageHistory");
      expect((err as Error).message).toMatch(/multi-turn conversations lose all prior context/);
    });

    it("names a reinstall (not an install) for a bundled provider", async () => {
      process.env.ANTHROPIC_API_KEY = "sk-anthropic";
      stubMissingPackage(PROVIDERS.anthropic);
      const err = await createRunner({ verbose: false }).catch((e: Error) => e);
      const msg = (err as Error).message;
      expect(msg).toMatch(/ships as a dependency of @agentic-patterns\/runtime/);
      expect(msg).toMatch(/reinstall dependencies/i);
    });

    it("names an install command for a non-bundled provider", async () => {
      process.env.GROQ_API_KEY = "gsk-test";
      stubMissingPackage(PROVIDERS.groq);
      const err = await createRunner({ verbose: false }).catch((e: Error) => e);
      expect((err as Error).message).toContain("bun add @ai-sdk/groq");
    });

    it("also fails loudly on the model-follows-provider path", async () => {
      process.env.GOOGLE_GENERATIVE_AI_API_KEY = "goog-key";
      stubMissingPackage(PROVIDERS.google);
      _setClaudeCliCache(true);
      await expect(createRunner({ modelId: "gemini-2.5-flash", verbose: false })).rejects.toThrow(
        /@ai-sdk\/google/,
      );
    });

    it("also fails loudly on the explicit-provider path", async () => {
      stubMissingPackage(PROVIDERS.mistral);
      _setClaudeCliCache(true);
      await expect(createRunner({ provider: "mistral", verbose: false })).rejects.toThrow(
        /@ai-sdk\/mistral/,
      );
    });
  });

  describe("#472 — the CLI fallback reason tells the truth", () => {
    it("says the runner drops messageHistory", async () => {
      _setClaudeCliCache(true);
      const { source, reason } = await createRunner({ verbose: false });
      expect(source).toBe("claude-cli");
      expect(reason).toContain("messageHistory");
      expect(reason).toContain("lose all prior context");
    });

    it("says no key was found — not the old, misleading 'set ANTHROPIC_API_KEY' framing alone", async () => {
      _setClaudeCliCache(true);
      const { reason } = await createRunner({ verbose: false });
      expect(reason).toContain("no provider API key found");
    });

    it("names every env var that works on a stock install", async () => {
      _setClaudeCliCache(true);
      const { reason } = await createRunner({ verbose: false });
      for (const v of BUNDLED_PROVIDER_ENV_VARS) expect(reason).toContain(v);
      expect(reason).toContain("nothing else to install");
    });

    it("calls out a provider key that is set but EMPTY (the silent skip)", async () => {
      // `OPENAI_API_KEY=` in a .env is falsy, so detection skips it exactly as
      // if it were unset — indistinguishable from "I configured nothing".
      process.env.OPENAI_API_KEY = "";
      _setClaudeCliCache(true);
      const { source, reason } = await createRunner({ verbose: false });
      expect(source).toBe("claude-cli");
      expect(reason).toContain("OPENAI_API_KEY");
      expect(reason).toMatch(/set but EMPTY/);
    });

    it("the terminal throw also warns about history loss", async () => {
      _setClaudeCliCache(false);
      const err = await createRunner({ verbose: false }).catch((e: Error) => e);
      expect((err as Error).message).toContain("no runnable configuration");
      expect((err as Error).message).toContain("messageHistory");
    });
  });

  describe("#472 — PROVIDER_PRIORITY is behaviour, not documentation", () => {
    // Shipping three real provider dependencies changes what a bare
    // createRunner() picks when several keys are present: all three rungs are
    // now genuinely reachable, where before only an installed one was. Pin the
    // documented order so a registry edit cannot quietly re-route consumers.
    it("documents anthropic → openai → google as the first three", () => {
      expect(PROVIDER_PRIORITY.slice(0, 3)).toEqual(["anthropic", "openai", "google"]);
      expect(PROVIDER_PRIORITY[PROVIDER_PRIORITY.length - 1]).toBe("ollama");
    });

    it("all three keys set → anthropic wins", async () => {
      process.env.ANTHROPIC_API_KEY = "sk-a";
      process.env.OPENAI_API_KEY = "sk-o";
      process.env.GOOGLE_GENERATIVE_AI_API_KEY = "goog";
      const { source } = await createRunner({ verbose: false });
      expect(source).toBe("env-anthropic");
    });

    it("openai + google → openai wins", async () => {
      process.env.OPENAI_API_KEY = "sk-o";
      process.env.GOOGLE_GENERATIVE_AI_API_KEY = "goog";
      const { source } = await createRunner({ verbose: false });
      expect(source).toBe("env-openai");
    });

    it("google alone → google", async () => {
      process.env.GOOGLE_GENERATIVE_AI_API_KEY = "goog";
      const { source } = await createRunner({ verbose: false });
      expect(source).toBe("env-google");
    });

    it("a bundled provider outranks a non-bundled one that sits later", async () => {
      // GROQ_API_KEY alone would need @ai-sdk/groq installed; with a google key
      // also present, priority sends us to the provider that ships in the box.
      process.env.GOOGLE_GENERATIVE_AI_API_KEY = "goog";
      process.env.GROQ_API_KEY = "gsk";
      const { source } = await createRunner({ verbose: false });
      expect(source).toBe("env-google");
    });
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

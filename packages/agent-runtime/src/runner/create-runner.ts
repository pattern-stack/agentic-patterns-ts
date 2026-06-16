/**
 * `createRunner()` — zero-config runner factory.
 *
 * Selection priority (first match wins):
 *   1. options.runner                → use it verbatim
 *   2. options.model (LanguageModelV2) → new AgentRunner(model)
 *   2.5 resolveAgentModel/profiles/modelsPath → new AgentRunner(resolver)  (per-agent model)
 *   3. options.provider + tier/modelId → new AgentRunner(provider.load(...))
 *   4. env vars (in PROVIDER_PRIORITY order) → new AgentRunner(...)
 *   5. claude CLI on PATH            → new ClaudeCodeAPIRunner()  (fallback, limited events)
 *   6. options.fallbackToMock === true → new MockRunner()
 *   7. throw
 *
 * See docs/runners.md (§4) for the design doc.
 */

import { spawn } from "node:child_process";
import type { LanguageModelV2 } from "@ai-sdk/provider";

import type { AgentEventBus } from "../events/agent-event-bus.js";
import {
  PROVIDERS,
  PROVIDER_PRIORITY,
  type ProviderProtocol,
  type ProviderTier,
  type SupportedProvider,
  resolveModelId,
} from "../providers/index.js";
import {
  type GatewayConfig,
  type ModelProfiles,
  createModelResolver,
} from "../providers/model-resolver.js";
import { AgentRunner } from "./agent-runner.js";
import { ClaudeCodeAPIRunner } from "./claude-code-api-runner.js";
import { MockRunner } from "./mock-runner.js";
import type { RunnerProtocol } from "./types.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface CreateRunnerOptions {
  /**
   * Explicit runner instance. Wins over everything else — useful for
   * tests (`runner: new MockRunner()`) or bespoke setups.
   */
  runner?: RunnerProtocol;
  /**
   * Explicit provider. Overrides env-based detection. Requires the
   * corresponding `@ai-sdk/*` package to be installed.
   */
  provider?: SupportedProvider;
  /**
   * Explicit model id. Falls through to the provider's tier default.
   * Ignored if `runner` or `model` is set.
   *
   * When omitted, `process.env.AGENT_MODEL` is read as a default — this
   * is the only way to pin an exact model from a `.env` file (e.g.
   * `AGENT_MODEL=qwen3.6:27b` to use a model the framework's tier map
   * doesn't list).
   */
  modelId?: string;
  /**
   * Cross-provider tier selector — "opus" | "sonnet" | "haiku". Resolved
   * via each `ProviderProtocol.tiers` map. Default: "sonnet".
   * Ignored if `modelId` is set.
   *
   * When omitted, `process.env.AGENT_TIER` is read as a default. Invalid
   * values are silently ignored (fall through to the "sonnet" default).
   */
  tier?: ProviderTier;
  /**
   * Pre-constructed `LanguageModelV2`. Short-circuits provider resolution;
   * the factory wraps it in `AgentRunner`.
   */
  model?: LanguageModelV2;
  /** Optional event bus. Passed through to the constructed runner. */
  eventBus?: AgentEventBus;
  /** Log the selection decision to console. Defaults to true. */
  verbose?: boolean;
  /**
   * If no runnable configuration is found, fall back to `MockRunner`
   * instead of throwing. Defaults to false.
   */
  fallbackToMock?: boolean;
  /**
   * Opt into agent-model-driven dispatch: build a resolver-backed runner that
   * resolves each agent's `getModel()` at run time (the model belongs to the
   * agent, overridable per-agent). Well-known families are pattern-matched;
   * supply `profiles` / `modelsPath` to alias or pin custom ids.
   * Implied when `profiles` or `modelsPath` is set. Default: false (a single
   * bound model is selected from model/provider/env, as before).
   */
  resolveAgentModel?: boolean;
  /** In-code model profiles for resolver mode (implies `resolveAgentModel`). */
  profiles?: ModelProfiles;
  /** Path to a `models.yaml` for resolver mode (implies `resolveAgentModel`). */
  modelsPath?: string;
  /**
   * Route ids through an OpenAI-compatible gateway (e.g. Bifrost). Implies
   * `resolveAgentModel`. Also auto-detected from env when unset: set
   * `AP_GATEWAY_BASE_URL` (+ optional `AP_GATEWAY_API_KEY`,
   * `AP_GATEWAY_MODEL_PREFIX`). See {@link GatewayConfig}.
   */
  gateway?: GatewayConfig;
}

export type RunnerSource =
  | "explicit-runner"
  | "explicit-model"
  | "model-resolver"
  | "explicit-provider"
  | `env-${SupportedProvider}`
  | "claude-cli"
  | "mock-fallback";

export interface RunnerSelection {
  runner: RunnerProtocol;
  /** Human-readable explanation, e.g. `"using anthropic (env ANTHROPIC_API_KEY)"`. */
  reason: string;
  /** Which branch of the priority tree fired. */
  source: RunnerSource;
}

/**
 * Build a {@link GatewayConfig} from env: `AP_GATEWAY_BASE_URL` (required),
 * `AP_GATEWAY_API_KEY`, `AP_GATEWAY_MODEL_PREFIX`. Returns undefined when no
 * gateway URL is set — so setting one env var routes every agent through the
 * gateway, no code change.
 */
function envGateway(): GatewayConfig | undefined {
  const baseURL = process.env.AP_GATEWAY_BASE_URL;
  if (!baseURL) return undefined;
  return {
    baseURL,
    ...(process.env.AP_GATEWAY_API_KEY ? { apiKey: process.env.AP_GATEWAY_API_KEY } : {}),
    ...(process.env.AP_GATEWAY_MODEL_PREFIX
      ? { modelPrefix: process.env.AP_GATEWAY_MODEL_PREFIX }
      : {}),
  };
}

/**
 * Construct a runner from explicit opts / env vars / Claude CLI presence.
 * Returns the runner plus metadata about why it was chosen.
 */
export async function createRunner(opts: CreateRunnerOptions = {}): Promise<RunnerSelection> {
  const verbose = opts.verbose ?? true;

  // Env-driven defaults applied to provider resolution. AGENT_MODEL pins
  // an exact model id (wins over tier, matching resolveModelId's
  // explicit-modelId-over-tier rule); AGENT_TIER picks one of the three
  // cross-provider tier slots. Both are ignored when `runner` / `model`
  // short-circuit provider resolution.
  const tier = opts.tier ?? envTier();
  const modelId = opts.modelId ?? process.env.AGENT_MODEL;

  // 1. Explicit runner wins.
  if (opts.runner) {
    return log(verbose, {
      runner: opts.runner,
      reason: "using caller-provided runner",
      source: "explicit-runner",
    });
  }

  // 2. Explicit LanguageModelV2 → AgentRunner.
  if (opts.model) {
    return log(verbose, {
      runner: new AgentRunner(opts.model, opts.eventBus),
      reason: "using caller-provided LanguageModelV2 via AgentRunner",
      source: "explicit-model",
    });
  }

  // 2.5 Resolver-backed runner — dispatch each agent's declared model at run
  // time (the model belongs to the agent). Opt-in via resolveAgentModel, or
  // implied by profiles/modelsPath/gateway for custom / aliased / gateway ids.
  const gateway = opts.gateway ?? envGateway();
  if (opts.resolveAgentModel || opts.profiles || opts.modelsPath || gateway) {
    const resolver = await createModelResolver({
      profiles: opts.profiles,
      modelsPath: opts.modelsPath,
      gateway,
    });
    return log(verbose, {
      runner: new AgentRunner(resolver, opts.eventBus),
      reason: gateway
        ? `resolving agent models per run (gateway ${gateway.baseURL})`
        : opts.modelsPath
          ? `resolving agent models per run (profiles + ${opts.modelsPath})`
          : "resolving agent models per run",
      source: "model-resolver",
    });
  }

  // 3. Explicit provider.
  if (opts.provider) {
    const provider = PROVIDERS[opts.provider];
    const resolved = resolveModelId(provider, modelId, tier);
    const model = await provider.load(resolved);
    return log(verbose, {
      runner: new AgentRunner(model, opts.eventBus),
      reason: `using ${opts.provider} (explicit, model=${resolved})`,
      source: "explicit-provider",
    });
  }

  // 4. Env-based auto-detection, in PROVIDER_PRIORITY order.
  for (const name of PROVIDER_PRIORITY) {
    const provider = PROVIDERS[name];
    const matchedEnv = provider.envVars.find((v) => process.env[v]);
    if (matchedEnv) {
      const resolved = resolveModelId(provider, modelId, tier);
      const model = await provider.load(resolved);
      return log(verbose, {
        runner: new AgentRunner(model, opts.eventBus),
        reason: `using ${name} (env ${matchedEnv}, model=${resolved})`,
        source: `env-${name}` as RunnerSource,
      });
    }
  }

  // 5. Claude CLI probe.
  if (await hasClaudeCli()) {
    const runner = new ClaudeCodeAPIRunner({
      eventBus: opts.eventBus,
      defaults: { tools: [] },
    });
    return log(verbose, {
      runner,
      reason:
        "using ClaudeCodeAPIRunner (claude CLI on PATH) — limited event vocabulary; set ANTHROPIC_API_KEY for AgentRunner with full events",
      source: "claude-cli",
    });
  }

  // 6. Mock fallback (opt-in).
  if (opts.fallbackToMock) {
    return log(verbose, {
      runner: new MockRunner(),
      reason: "no runnable configuration — falling back to MockRunner (fallbackToMock=true)",
      source: "mock-fallback",
    });
  }

  // 7. Throw.
  throw new Error(
    [
      "createRunner: no runnable configuration found.",
      "Provide one of:",
      "  • options.runner (a RunnerProtocol instance)",
      "  • options.model (a LanguageModelV2)",
      "  • options.provider + the matching @ai-sdk/* package installed",
      "  • an env var: ANTHROPIC_API_KEY, OPENAI_API_KEY, GOOGLE_GENERATIVE_AI_API_KEY,",
      "    GROQ_API_KEY, MISTRAL_API_KEY, XAI_API_KEY, DEEPSEEK_API_KEY,",
      "    OPENROUTER_API_KEY, or OLLAMA_HOST",
      "  • `claude` CLI on PATH (Claude Max login or ANTHROPIC_API_KEY)",
      "  • options.fallbackToMock = true",
    ].join("\n"),
  );
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Read AGENT_TIER from env and validate. Mistyped values (e.g. "sonnet ")
 * fall through to undefined so the downstream default kicks in instead
 * of indexing the tier map with garbage.
 */
function envTier(): ProviderTier | undefined {
  const v = process.env.AGENT_TIER;
  return v === "opus" || v === "sonnet" || v === "haiku" ? v : undefined;
}

function log(verbose: boolean, selection: RunnerSelection): RunnerSelection {
  if (verbose) {
    process.stdout.write(`[runner] ${selection.reason}\n`);
  }
  return selection;
}

/**
 * Probe whether `claude` is on PATH. Returns false on any error (not
 * installed, timeout, crashed). Cached for the process lifetime to keep
 * repeated `createRunner()` calls cheap.
 */
let _claudeCliCache: boolean | undefined;
async function hasClaudeCli(): Promise<boolean> {
  if (_claudeCliCache !== undefined) return _claudeCliCache;
  _claudeCliCache = await new Promise<boolean>((resolve) => {
    const child = spawn("claude", ["--version"], {
      stdio: "ignore",
      // shell: true handles Windows `.cmd` extension and generally behaves
      // for "is this command on PATH" probes.
      shell: process.platform === "win32",
    });
    const timer = setTimeout(() => {
      child.kill();
      resolve(false);
    }, 2000);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
  return _claudeCliCache;
}

/** @internal — tests use this to reset the CLI-probe cache between runs. */
export function _resetClaudeCliCache(): void {
  _claudeCliCache = undefined;
}

/**
 * Utility consumed by tests: returns the active provider's adapter if any.
 * Kept `@internal` so we don't stamp it as a public API.
 *
 * @internal
 */
export function _getProviderByName(name: SupportedProvider): ProviderProtocol {
  return PROVIDERS[name];
}

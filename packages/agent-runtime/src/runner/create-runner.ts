/**
 * `createRunner()` — zero-config runner factory.
 *
 * Selection priority (first match wins):
 *   1. options.runner                → use it verbatim
 *   2. options.model (LanguageModelV1) → new AgentRunner(model)
 *   3. options.provider + tier/modelId → new AgentRunner(provider.load(...))
 *   4. env vars (in PROVIDER_PRIORITY order) → new AgentRunner(...)
 *   5. claude CLI on PATH            → new ClaudeCodeAPIRunner()  (fallback, limited events)
 *   6. options.fallbackToMock === true → new MockRunner()
 *   7. throw
 *
 * See docs/runners.md (§4) for the design doc.
 */

import { spawn } from "node:child_process";
import type { LanguageModelV1 } from "ai";

import type { AgentEventBus } from "../events/agent-event-bus.js";
import {
  PROVIDERS,
  PROVIDER_PRIORITY,
  type ProviderProtocol,
  type ProviderTier,
  type SupportedProvider,
  resolveModelId,
} from "../providers/index.js";
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
   */
  modelId?: string;
  /**
   * Cross-provider tier selector — "opus" | "sonnet" | "haiku". Resolved
   * via each `ProviderProtocol.tiers` map. Default: "sonnet".
   * Ignored if `modelId` is set.
   */
  tier?: ProviderTier;
  /**
   * Pre-constructed `LanguageModelV1`. Short-circuits provider resolution;
   * the factory wraps it in `AgentRunner`.
   */
  model?: LanguageModelV1;
  /** Optional event bus. Passed through to the constructed runner. */
  eventBus?: AgentEventBus;
  /** Log the selection decision to console. Defaults to true. */
  verbose?: boolean;
  /**
   * If no runnable configuration is found, fall back to `MockRunner`
   * instead of throwing. Defaults to false.
   */
  fallbackToMock?: boolean;
}

export type RunnerSource =
  | "explicit-runner"
  | "explicit-model"
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
 * Construct a runner from explicit opts / env vars / Claude CLI presence.
 * Returns the runner plus metadata about why it was chosen.
 */
export async function createRunner(opts: CreateRunnerOptions = {}): Promise<RunnerSelection> {
  const verbose = opts.verbose ?? true;

  // 1. Explicit runner wins.
  if (opts.runner) {
    return log(verbose, {
      runner: opts.runner,
      reason: "using caller-provided runner",
      source: "explicit-runner",
    });
  }

  // 2. Explicit LanguageModelV1 → AgentRunner.
  if (opts.model) {
    return log(verbose, {
      runner: new AgentRunner(opts.model, opts.eventBus),
      reason: "using caller-provided LanguageModelV1 via AgentRunner",
      source: "explicit-model",
    });
  }

  // 3. Explicit provider.
  if (opts.provider) {
    const provider = PROVIDERS[opts.provider];
    const modelId = resolveModelId(provider, opts.modelId, opts.tier);
    const model = await provider.load(modelId);
    return log(verbose, {
      runner: new AgentRunner(model, opts.eventBus),
      reason: `using ${opts.provider} (explicit, model=${modelId})`,
      source: "explicit-provider",
    });
  }

  // 4. Env-based auto-detection, in PROVIDER_PRIORITY order.
  for (const name of PROVIDER_PRIORITY) {
    const provider = PROVIDERS[name];
    const matchedEnv = provider.envVars.find((v) => process.env[v]);
    if (matchedEnv) {
      const modelId = resolveModelId(provider, opts.modelId, opts.tier);
      const model = await provider.load(modelId);
      return log(verbose, {
        runner: new AgentRunner(model, opts.eventBus),
        reason: `using ${name} (env ${matchedEnv}, model=${modelId})`,
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
      "  • options.model (a LanguageModelV1)",
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

/**
 * `createRunner()` — zero-config runner factory.
 *
 * Selection priority (first match wins):
 *   1. options.runner                → use it verbatim
 *   2. options.model (ResolvedLanguageModel) → new AgentRunner(model)
 *   2.5 resolveAgentModel/profiles/modelsPath → new AgentRunner(resolver)  (per-agent model)
 *   3. options.provider + tier/modelId → new AgentRunner(provider.load(...))
 *   4. explicit modelId/AGENT_MODEL → inferProvider(id) picks the provider (the
 *      PROVIDER FOLLOWS THE MODEL; fail loud if that provider's key is absent);
 *      otherwise env vars in PROVIDER_PRIORITY order → new AgentRunner(...)
 *   5. claude CLI on PATH            → new ClaudeCodeAPIRunner()  (fallback, limited events)
 *   6. options.fallbackToMock === true → new MockRunner()
 *   7. throw
 *
 * PACKAGING (#472): `@ai-sdk/anthropic`, `@ai-sdk/openai` and `@ai-sdk/google`
 * ship as real dependencies of `@pattern-stack/agentic-runtime`, so setting any of
 * ANTHROPIC_API_KEY / OPENAI_API_KEY / GOOGLE_GENERATIVE_AI_API_KEY reaches rung
 * 4 (`AgentRunner`) with nothing else installed. The remaining adapters stay
 * dynamic-import-only and name their package when they can't be loaded.
 *
 * NO SILENT DEGRADATION (#472): rung 5 is reachable ONLY when no provider
 * credential was found at all. A credential that IS present but whose provider
 * package cannot be loaded throws from `loadProviderModel` — it never continues
 * down the ladder — because `ClaudeCodeAPIRunner` has no read site for
 * `options.messageHistory`, so degrading into it silently turns every multi-turn
 * conversation into a series of first turns.
 *
 * See docs/runners.md (§4) for the design doc and docs/adr/0010-* for the
 * packaging decision.
 */

import { spawn } from "node:child_process";

import type { AgentEventBus } from "../events/agent-event-bus.js";
import { bifrostCorrelationHeaders } from "../providers/bifrost.js";
import {
  BUNDLED_PROVIDER_ENV_VARS,
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
  inferProvider,
} from "../providers/model-resolver.js";
import type { ResolvedLanguageModel } from "../providers/types.js";
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
   *
   * On the env-detection path (no `provider`), the PROVIDER FOLLOWS THE MODEL:
   * a classifiable id (via {@link inferProvider}, e.g. `gemini-*` → google)
   * selects that provider and REQUIRES its env key — a key-absent classified id
   * fails loud instead of being stapled onto a priority-detected provider. An
   * unclassifiable custom id (e.g. `qwen3.6:27b`) still pins onto the
   * priority-detected provider (or `opts.provider`).
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
   * Pre-constructed {@link ResolvedLanguageModel}. Short-circuits provider
   * resolution; the factory wraps it in `AgentRunner`.
   */
  model?: ResolvedLanguageModel;
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
 * `AP_GATEWAY_API_KEY`, `AP_GATEWAY_MODEL_PREFIX` (a literal prefix, or `"auto"`
 * to derive `«vendor»/«model»` per id), `AP_GATEWAY_TIER_PROVIDER` (whose tier
 * map turns `haiku`/`sonnet`/`opus` into a real id — default `anthropic`),
 * `AP_GATEWAY_STRUCTURED_OUTPUTS` (1/true → the gateway forwards json-schema
 * structured outputs; see {@link GatewayConfig.supportsStructuredOutputs}),
 * `AP_GATEWAY_VIRTUAL_KEY` (Bifrost `x-bf-vk` — governed instances 401 without
 * it), `AP_GATEWAY_GUARDRAIL_IDS` (comma list → Bifrost `x-bf-guardrail-ids`).
 * Returns undefined when no gateway URL is set — so setting one env var routes
 * every agent through the gateway, no code change.
 *
 * Auth: a token gateway uses `AP_GATEWAY_API_KEY` (sent as `Authorization: Bearer`).
 * A Basic-auth gateway (e.g. a Bifrost deployment fronted by HTTP Basic, which 401s
 * on Bearer) instead takes `AP_GATEWAY_BASIC_USER` + `AP_GATEWAY_BASIC_PASS` — we send
 * a precomputed `Authorization: Basic <base64(user:pass)>` header and omit the apiKey.
 *
 * `AP_GATEWAY_VIRTUAL_KEY` is orthogonal to both: it is Bifrost governance
 * (`x-bf-vk`), not transport/proxy auth, so it is sent ALONGSIDE either
 * `Authorization` form when both are configured.
 */
function envGateway(): GatewayConfig | undefined {
  const baseURL = process.env.AP_GATEWAY_BASE_URL;
  if (!baseURL) return undefined;
  // Fail loud on a typo'd provider name rather than silently falling back to the
  // default tier map — a wrong tier map picks a real-but-unintended model.
  const tierProvider = process.env.AP_GATEWAY_TIER_PROVIDER;
  if (tierProvider && !(tierProvider in PROVIDERS)) {
    throw new Error(
      `createRunner: AP_GATEWAY_TIER_PROVIDER="${tierProvider}" is not a supported provider. ` +
        `Expected one of: ${Object.keys(PROVIDERS).join(", ")}.`,
    );
  }
  const basicUser = process.env.AP_GATEWAY_BASIC_USER;
  const basicPass = process.env.AP_GATEWAY_BASIC_PASS;
  const basicHeader =
    basicUser && basicPass
      ? {
          authorization: `Basic ${Buffer.from(`${basicUser}:${basicPass}`).toString("base64")}`,
        }
      : undefined;
  const guardrailIds = (process.env.AP_GATEWAY_GUARDRAIL_IDS ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
  return {
    baseURL,
    ...(process.env.AP_GATEWAY_API_KEY ? { apiKey: process.env.AP_GATEWAY_API_KEY } : {}),
    ...(process.env.AP_GATEWAY_MODEL_PREFIX
      ? { modelPrefix: process.env.AP_GATEWAY_MODEL_PREFIX }
      : {}),
    ...(tierProvider ? { tierProvider: tierProvider as SupportedProvider } : {}),
    ...(basicHeader ? { headers: basicHeader } : {}),
    ...(/^(1|true|yes)$/i.test(process.env.AP_GATEWAY_STRUCTURED_OUTPUTS ?? "")
      ? { supportsStructuredOutputs: true }
      : {}),
    ...(process.env.AP_GATEWAY_VIRTUAL_KEY
      ? { virtualKey: process.env.AP_GATEWAY_VIRTUAL_KEY }
      : {}),
    ...(guardrailIds.length ? { guardrailIds } : {}),
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

  // 2. Explicit ResolvedLanguageModel → AgentRunner.
  if (opts.model) {
    return log(verbose, {
      runner: new AgentRunner(opts.model, opts.eventBus),
      reason: "using caller-provided language model (V2/V3/V4 spec) via AgentRunner",
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
      // #406: a gateway wires the Bifrost correlation-header factory
      // automatically; it self-gates on `ctx.modelProvider`, so profile ids
      // that escape-hatch to a direct provider are unaffected. No gateway →
      // the plain 2-arg construction, unchanged.
      runner: gateway
        ? new AgentRunner(resolver, opts.eventBus, { requestHeaders: bifrostCorrelationHeaders })
        : new AgentRunner(resolver, opts.eventBus),
      reason: gateway
        ? `resolving each agent's declared model per run (gateway ${gateway.baseURL})`
        : opts.modelsPath
          ? `resolving each agent's declared model per run (profiles + ${opts.modelsPath})`
          : "resolving each agent's declared model per run",
      source: "model-resolver",
    });
  }

  // 3. Explicit provider.
  if (opts.provider) {
    const provider = PROVIDERS[opts.provider];
    const resolved = resolveModelId(provider, modelId, tier);
    const model = await loadProviderModel(provider, resolved, "options.provider");
    return log(verbose, {
      runner: new AgentRunner(model, opts.eventBus),
      reason: `using ${opts.provider} (explicit, model=${resolved})`,
      source: "explicit-provider",
    });
  }

  // 4. Env-based auto-detection.
  //
  // When an explicit model id is known (opts.modelId / AGENT_MODEL) the PROVIDER
  // must FOLLOW THE MODEL — never pair a model with whichever priority-detected
  // provider happens to have a key. inferProvider() classifies the id to its
  // vendor; we then require THAT provider's env key. A classified id whose
  // provider key is absent FAILS LOUD (below) instead of being stapled onto a
  // different provider (the openai + gemini-3.1-flash-lite mismatch bug). Only an
  // UNCLASSIFIABLE id (custom / OSS names inferProvider can't map, e.g.
  // `qwen3.6:27b`) falls through to the priority loop, which pins it onto the
  // priority-detected provider — the documented "AGENT_MODEL pins an exact id"
  // escape hatch.
  if (modelId) {
    const inferred = inferProvider(modelId);
    if (inferred) {
      const provider = PROVIDERS[inferred];
      const matchedEnv = provider.envVars.find((v) => process.env[v]);
      if (!matchedEnv) {
        throw new Error(modelProviderMismatchError(modelId, inferred, provider));
      }
      const model = await loadProviderModel(provider, modelId, `env ${matchedEnv}`);
      return log(verbose, {
        runner: new AgentRunner(model, opts.eventBus),
        reason: `using ${inferred} (model ${modelId} → ${inferred}, env ${matchedEnv})`,
        source: `env-${inferred}` as RunnerSource,
      });
    }
  }

  // No explicit model id, or an unclassifiable custom id: choose the provider by
  // env priority and resolve its tier default (or pin the unclassifiable id).
  for (const name of PROVIDER_PRIORITY) {
    const provider = PROVIDERS[name];
    const matchedEnv = provider.envVars.find((v) => process.env[v]);
    if (matchedEnv) {
      const resolved = resolveModelId(provider, modelId, tier);
      const model = await loadProviderModel(provider, resolved, `env ${matchedEnv}`);
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
      reason: claudeCliFallbackReason(),
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
      "  • options.model (a language model, V2/V3/V4 spec)",
      `  • an env var — ${BUNDLED_PROVIDER_ENV_VARS.join(", ")} — whose provider package`,
      "    ships with @pattern-stack/agentic-runtime (nothing else to install)",
      "  • an env var for a provider whose package you install yourself:",
      "    GROQ_API_KEY, MISTRAL_API_KEY, XAI_API_KEY, DEEPSEEK_API_KEY, OPENROUTER_API_KEY",
      "  • options.provider + (for a non-bundled provider) its package installed",
      "  • `claude` CLI on PATH (Claude Max login) — note: that runner does NOT carry",
      "    options.messageHistory, so multi-turn conversations lose prior context",
      "  • options.fallbackToMock = true",
      ...emptyEnvVarNotes(),
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

/**
 * The consequence sentence (#472). `ClaudeCodeAPIRunner` has NO read site for
 * `options.messageHistory` — only `AgentRunner`'s message assembly does — so a
 * silent landing on that rung turns every multi-turn conversation into a series
 * of first turns while still answering plausibly. Every message that could lead
 * a caller onto (or explain) that rung says this out loud.
 */
const HISTORY_LOSS_WARNING =
  "ClaudeCodeAPIRunner does NOT carry options.messageHistory — multi-turn conversations lose all prior context";

/**
 * Load a model through a provider adapter, converting any package-load failure
 * into a loud, fix-naming error (#472).
 *
 * The defect this closes: a consumer sets a provider key, the provider's package
 * cannot be imported, and the run degrades into `ClaudeCodeAPIRunner` — the one
 * runner that drops `messageHistory`. A credential was present, so the caller's
 * INTENT was `AgentRunner`; silently serving a lesser runner (or a bare
 * ERR_MODULE_NOT_FOUND with no context) is the wrong answer. We refuse to
 * continue down the ladder and say exactly what to fix.
 *
 * @param credentialSource human-readable origin of the choice that got us here,
 *   e.g. `"env OPENAI_API_KEY"` or `"options.provider"`.
 */
async function loadProviderModel(
  provider: ProviderProtocol,
  resolvedModelId: string,
  credentialSource: string,
): Promise<ResolvedLanguageModel> {
  try {
    return await provider.load(resolvedModelId);
  } catch (cause) {
    throw new Error(providerLoadFailureError(provider, resolvedModelId, credentialSource, cause), {
      cause,
    });
  }
}

/**
 * Build the fail-loud message for "credential present, provider package
 * unloadable". Names the credential, the package, the fix, and — crucially —
 * why we are NOT quietly continuing to the CLI fallback.
 */
function providerLoadFailureError(
  provider: ProviderProtocol,
  resolvedModelId: string,
  credentialSource: string,
  cause: unknown,
): string {
  const fix = provider.bundled
    ? [
        `  Fix: "${provider.packageName}" ships as a dependency of @pattern-stack/agentic-runtime, so it`,
        "       should already be present. This usually means a broken, partial, or deduped-away",
        "       install — reinstall dependencies (bun install / npm install / pnpm install).",
      ]
    : [
        `  Fix: install it — bun add ${provider.packageName}  (or npm i ${provider.packageName})`,
        `       Only ${BUNDLED_PROVIDER_ENV_VARS.join(", ")} work with no extra install.`,
      ];
  return [
    `createRunner: ${credentialSource} selected the "${provider.name}" provider, but its package`,
    `"${provider.packageName}" could not be loaded — no model could be constructed for "${resolvedModelId}".`,
    ...fix,
    "",
    "  Not falling back to another runner: a credential was present, so AgentRunner was the",
    `  intended path. ${HISTORY_LOSS_WARNING}, which would make this failure invisible.`,
    "",
    `  Underlying error: ${cause instanceof Error ? cause.message : String(cause)}`,
  ].join("\n");
}

/**
 * The `reason` for the `claude` CLI rung. Reaching it means NO provider env var
 * was set (a set-but-unloadable provider throws in {@link loadProviderModel}),
 * so the old copy — "set ANTHROPIC_API_KEY for AgentRunner with full events" —
 * was both incomplete and, in the #472 report, actively misleading: the key WAS
 * set and the package was missing. This version names every env var that works
 * on a stock install, states the history-loss consequence, and calls out env
 * vars that are present but empty (an empty value reads as unset, which is its
 * own silent skip).
 */
function claudeCliFallbackReason(): string {
  const notes = emptyEnvVarNotes();
  return [
    "using ClaudeCodeAPIRunner (claude CLI on PATH) — no provider API key found.",
    `WARNING: ${HISTORY_LOSS_WARNING}; event vocabulary is also limited.`,
    `For AgentRunner set one of: ${BUNDLED_PROVIDER_ENV_VARS.join(", ")} — those provider packages ship with @pattern-stack/agentic-runtime, nothing else to install.`,
    ...notes,
  ].join(" ");
}

/**
 * Notes about provider env vars that are DEFINED BUT EMPTY. `OPENAI_API_KEY=`
 * in a `.env` is falsy, so detection skips it exactly as if it were unset —
 * a silent skip that looks identical to "I configured nothing".
 */
function emptyEnvVarNotes(): string[] {
  const blank = new Set<string>();
  for (const name of PROVIDER_PRIORITY) {
    for (const v of PROVIDERS[name].envVars) {
      if (process.env[v] !== undefined && process.env[v] === "") blank.add(v);
    }
  }
  return blank.size === 0
    ? []
    : [`(note: ${[...blank].join(", ")} is set but EMPTY — an empty value is treated as unset.)`];
}

/**
 * Build the fail-loud error for an explicit model id whose inferred provider has
 * no credential present. Names the model, the provider it belongs to, and the
 * env var(s) to set — so the mismatch is fixed rather than silently paired with a
 * priority-detected provider that can't serve the model.
 */
function modelProviderMismatchError(
  modelId: string,
  provider: SupportedProvider,
  adapter: ProviderProtocol,
): string {
  return [
    `createRunner: model "${modelId}" is a ${provider} model, but no ${provider} credential is set.`,
    `Set one of: ${adapter.envVars.join(", ")} — or choose a model for a provider whose key you have.`,
    `(The model names its provider; the framework will not run a ${provider} model on a different provider.)`,
  ].join("\n");
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
 * Force the CLI-probe result so the fallback rung can be exercised
 * deterministically on machines with (or without) `claude` on PATH.
 *
 * @internal — tests only.
 */
export function _setClaudeCliCache(value: boolean): void {
  _claudeCliCache = value;
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

/**
 * ModelResolver — maps an agent's *declared* model id (`agent.getModel()`) to a
 * live `LanguageModelV2` at run time.
 *
 * ARCHITECTURE: the model belongs to the **agent**, not the runner. `AgentRunner`
 * is model-agnostic — it "just runs an agent" and asks the resolver to turn that
 * agent's declared model into a live model each `run()`. Per-agent overrides
 * (`agent.withModel(id)` / `buildAgentFromConfig` `modelOverride`) therefore change
 * what the runner dispatches, with no per-runner / per-step-runner plumbing.
 *
 * Back-compat: `new AgentRunner(model)` still works — a concrete `LanguageModelV2`
 * is wrapped in a {@link constantModelResolver} that ignores `agent.getModel()`
 * and always returns that model (the pre-resolver behaviour, and the path tests
 * use with `MockLanguageModelV2`).
 *
 * {@link HybridModelResolver} resolution precedence (first match wins):
 *   1. an explicit {@link ModelProfile} — registered in-code or loaded from a
 *      `models.yaml` via {@link loadModelProfiles}. Aliases or pins a model id
 *      to one of the named providers.
 *   2. a configured {@link GatewayConfig} (if any) — routes the id through one
 *      OpenAI-compatible gateway (e.g. Bifrost): one endpoint, the agent's model
 *      id passed through (optionally prefixed/qualified). Profiles still win, so
 *      a profile is the per-id escape hatch to go direct.
 *   3. a pattern-matched well-known family (`gemini-*` → google, `gpt-*`/`o1`/`o3`
 *      → openai, `claude-*` → anthropic, …) — zero-config for the common clouds.
 *   4. a helpful error listing the known families + registered profiles.
 */

import type { LanguageModelV2 } from "@ai-sdk/provider";
import { z } from "zod";

import { PROVIDERS, type SupportedProvider } from "./index.js";

/**
 * Dynamically import an optional package, throwing an accurate,
 * package-manager-neutral error if it isn't installed. Unlike
 * providers/`importProvider`, this is not provider-framed — it's used by the
 * yaml loader, which a consumer installs only when they use that feature.
 */
// biome-ignore lint/suspicious/noExplicitAny: imported module shape is opaque
async function importOptional(pkg: string, feature: string): Promise<any> {
  try {
    return await import(/* @vite-ignore */ pkg);
  } catch (e) {
    throw new Error(
      `ModelResolver: ${feature} needs the optional package "${pkg}". Install it (e.g. \`bun add ${pkg}\`).`,
      { cause: e },
    );
  }
}

// ---------------------------------------------------------------------------
// ModelResolver
// ---------------------------------------------------------------------------

/** Turns a declared model id into a live `LanguageModelV2`. `modelId` may be
 *  `undefined` when an agent pins no model; a pinned/constant resolver ignores
 *  it, while an id-driven resolver rejects with a clear error. */
export interface ModelResolver {
  resolve(modelId: string | undefined): Promise<LanguageModelV2>;
}

/** Narrow a constructor arg to a {@link ModelResolver} (vs a `LanguageModelV2`). */
export function isModelResolver(x: LanguageModelV2 | ModelResolver): x is ModelResolver {
  return typeof (x as ModelResolver).resolve === "function";
}

/**
 * A resolver that ignores the id and always returns `model`. Wraps a concrete
 * `LanguageModelV2` so `new AgentRunner(model)` keeps the pre-resolver
 * (model-pinned) behaviour — used by tests/mocks and single-model apps.
 */
export function constantModelResolver(model: LanguageModelV2): ModelResolver {
  return { resolve: () => Promise.resolve(model) };
}

// ---------------------------------------------------------------------------
// ModelProfile — the serializable registry entry (also the models.yaml shape)
// ---------------------------------------------------------------------------

/** Provider kinds a profile may target — every {@link SupportedProvider}. */
export const PROFILE_PROVIDERS = [
  "anthropic",
  "openai",
  "google",
  "groq",
  "mistral",
  "xai",
  "deepseek",
  "openrouter",
  "ollama",
] as const;

/**
 * A single model profile — serializable, so it round-trips through `models.yaml`
 * and (later) a workflow config. A profile aliases or pins a model id to one of
 * the named `@ai-sdk/*` providers, which authenticate from their own env vars.
 */
export const ModelProfileSchema = z
  .object({
    /** Provider adapter to build from. */
    provider: z.enum(PROFILE_PROVIDERS),
    /** Upstream model id sent to the provider. Defaults to the profile key. */
    model: z.string().optional(),
  })
  .strict();

export type ModelProfile = z.infer<typeof ModelProfileSchema>;

/** A map of `{ id → ModelProfile }` — the `models.yaml` document shape. */
export const ModelProfilesSchema = z.record(ModelProfileSchema);
export type ModelProfiles = z.infer<typeof ModelProfilesSchema>;

// ---------------------------------------------------------------------------
// GatewayConfig — route many ids through one OpenAI-compatible endpoint
// ---------------------------------------------------------------------------

/**
 * An OpenAI-compatible gateway (e.g. Bifrost, LiteLLM, OpenRouter, vLLM).
 *
 * A gateway is "just the URL (+ key)": one endpoint that fronts many upstream
 * models and does its own routing / load-balancing / failover. Agents stay
 * clean — each agent still declares its own model id (`agent.getModel()`),
 * which is passed through to the gateway, optionally prefixed/qualified to the
 * gateway's namespace (e.g. `claude-sonnet-4-5` → `anthropic/claude-sonnet-4-5`).
 *
 * When a resolver has a gateway, it routes every id through it EXCEPT ids that
 * have an explicit profile — so a profile is the per-id escape hatch to go
 * direct. Requires the optional `@ai-sdk/openai-compatible` package.
 */
export interface GatewayConfig {
  /** Gateway endpoint base URL. */
  readonly baseURL: string;
  /** Inline gateway key. Prefer {@link GatewayConfig.apiKeyEnv} to keep secrets out of config. */
  readonly apiKey?: string;
  /** Name of an env var holding the gateway key (read at resolve time). */
  readonly apiKeyEnv?: string;
  /** Extra request headers (e.g. a gateway routing / virtual-key header). */
  readonly headers?: Readonly<Record<string, string>>;
  /**
   * Prepended to the agent's declared id to form the gateway model id (gateways
   * often namespace by vendor). Ignored when {@link GatewayConfig.qualify} is set.
   */
  readonly modelPrefix?: string;
  /** Full control over agent-id → gateway-id mapping. Overrides `modelPrefix`. */
  readonly qualify?: (modelId: string) => string;
  /**
   * Whether this gateway faithfully forwards OpenAI `response_format` json-schema
   * (structured outputs) to its upstream models. `@ai-sdk/openai-compatible`
   * defaults to `false` for a generic gateway — it then STRIPS the schema before
   * sending, so the model free-forms and structured emits fail ("No object
   * generated"). Set `true` only when you know the gateway translates structured
   * outputs for the models you route through it (e.g. Bifrost → Gemini, verified).
   * It is a property of the (gateway × upstream model) pair, so it is opt-in, not
   * assumed. Per-model granularity belongs in a model profile (which wins over the
   * gateway). Env: `AP_GATEWAY_STRUCTURED_OUTPUTS`.
   */
  readonly supportsStructuredOutputs?: boolean;
}

/** Map an agent's declared id to the id the gateway expects. */
function qualifyGatewayId(modelId: string, gw: GatewayConfig): string {
  if (gw.qualify) return gw.qualify(modelId);
  if (gw.modelPrefix) return `${gw.modelPrefix}${modelId}`;
  return modelId;
}

// ---------------------------------------------------------------------------
// Pattern-match: bare id → well-known provider
// ---------------------------------------------------------------------------

/**
 * Ordered, unambiguous vendor-prefix rules. We only auto-route ids whose prefix
 * names exactly one provider — OSS names served by several providers
 * (`llama-*`, `qwen*`, `gemma*`) and slash/colon formats deliberately return
 * `undefined` so the caller adds a profile (or relies on `createRunner` env
 * detection) rather than guessing wrong.
 */
const FAMILY_RULES: ReadonlyArray<readonly [RegExp, SupportedProvider]> = [
  [/^claude[-.]/i, "anthropic"],
  [/^(gpt-|gpt5|chatgpt|o1[-_]?|o3[-_]?|o4[-_]?)/i, "openai"],
  [/^gemini[-.]/i, "google"],
  [/^grok[-.]/i, "xai"],
  [/^deepseek[-.]/i, "deepseek"],
  [/^(mistral|mixtral|ministral|codestral|magistral|pixtral|devstral)[-.]?/i, "mistral"],
];

/** Infer the provider for a bare model id by vendor prefix, or `undefined` if ambiguous/unknown. */
export function inferProvider(modelId: string): SupportedProvider | undefined {
  for (const [re, provider] of FAMILY_RULES) {
    if (re.test(modelId)) return provider;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// HybridModelResolver
// ---------------------------------------------------------------------------

export interface HybridModelResolverOptions {
  /** Seed profiles (merged via {@link HybridModelResolver.register}). */
  profiles?: ModelProfiles;
  /**
   * Route ids through an OpenAI-compatible gateway (e.g. Bifrost). Profiles
   * still win; every other id goes through the gateway instead of native
   * pattern-match. See {@link GatewayConfig}.
   */
  gateway?: GatewayConfig;
}

/**
 * Resolver implementing the profile → pattern → error precedence. Resolved
 * models are memoised by id (the build is async and provider-package loads are
 * not free); a failed build is evicted so a later call can retry.
 */
export class HybridModelResolver implements ModelResolver {
  private readonly _profiles = new Map<string, ModelProfile>();
  private readonly _cache = new Map<string, Promise<LanguageModelV2>>();
  private readonly _gateway: GatewayConfig | undefined;

  constructor(opts: HybridModelResolverOptions = {}) {
    this._gateway = opts.gateway;
    for (const [id, profile] of Object.entries(opts.profiles ?? {})) {
      this.register(id, profile);
    }
  }

  /** Register (or replace) a profile, invalidating any cached build for that id. */
  register(id: string, profile: ModelProfile): this {
    this._profiles.set(id, ModelProfileSchema.parse(profile));
    this._cache.delete(id);
    return this;
  }

  /** Whether an id has an explicit profile. */
  has(id: string): boolean {
    return this._profiles.has(id);
  }

  resolve(modelId: string | undefined): Promise<LanguageModelV2> {
    if (!modelId) {
      return Promise.reject(
        new Error(
          [
            "ModelResolver: the agent declares no model and this runner resolves per-agent models.",
            "Set one with agent.withModel(id) or role.withDefaultModel(id),",
            "or run a pinned runner (createRunner with an explicit model/tier, no gateway/resolver).",
          ].join("\n"),
        ),
      );
    }
    const cached = this._cache.get(modelId);
    if (cached) return cached;
    const built = this._build(modelId);
    this._cache.set(modelId, built);
    // Evict only if THIS build is still the cached one — a stale rejection must
    // not delete a newer entry registered/re-resolved for the same id.
    built.catch(() => {
      if (this._cache.get(modelId) === built) this._cache.delete(modelId);
    });
    return built;
  }

  private async _build(modelId: string): Promise<LanguageModelV2> {
    const profile = this._profiles.get(modelId);
    if (profile) return buildFromProfile(modelId, profile);

    if (this._gateway) return buildFromGateway(modelId, this._gateway);

    const inferred = inferProvider(modelId);
    if (inferred) return PROVIDERS[inferred].load(modelId);

    throw new Error(this._unknownIdError(modelId));
  }

  private _unknownIdError(modelId: string): string {
    const registered = [...this._profiles.keys()];
    return [
      `ModelResolver: cannot resolve model id "${modelId}".`,
      "It matched no known vendor prefix (claude-*, gpt-*/o1/o3/o4, gemini-*, grok-*, deepseek-*, mistral-*)",
      "and has no registered profile.",
      registered.length
        ? `Registered profiles: ${registered.join(", ")}.`
        : "No profiles are registered.",
      "Add a profile (in-code via resolver.register(id, profile) or in a models.yaml loaded with loadModelProfiles),",
      'e.g. { provider: "anthropic", model: "claude-haiku-4-5" }.',
    ].join("\n");
  }
}

// ---------------------------------------------------------------------------
// Profile → LanguageModelV2
// ---------------------------------------------------------------------------

function buildFromProfile(id: string, profile: ModelProfile): Promise<LanguageModelV2> {
  // A profile aliases/pins an id to a named provider; that provider's loader
  // authenticates from its own env vars and takes only a model id.
  const upstreamId = profile.model ?? id;
  return PROVIDERS[profile.provider].load(upstreamId);
}

// ---------------------------------------------------------------------------
// Gateway → LanguageModelV2
// ---------------------------------------------------------------------------

async function buildFromGateway(modelId: string, gw: GatewayConfig): Promise<LanguageModelV2> {
  const apiKey = gw.apiKey ?? (gw.apiKeyEnv ? process.env[gw.apiKeyEnv] : undefined);
  const mod = await importOptional(
    "@ai-sdk/openai-compatible",
    "gateway routing (openai-compatible)",
  );
  const provider = mod.createOpenAICompatible({
    name: "gateway",
    baseURL: gw.baseURL,
    ...(apiKey ? { apiKey } : {}),
    ...(gw.headers ? { headers: gw.headers } : {}),
    // Provider-level in @ai-sdk/openai-compatible: gates whether the SDK SENDS the
    // json-schema `response_format` (default false → stripped). Opt-in per gateway.
    ...(gw.supportsStructuredOutputs ? { supportsStructuredOutputs: true } : {}),
  });
  return provider(qualifyGatewayId(modelId, gw));
}

// ---------------------------------------------------------------------------
// YAML loader (optional dep, dynamically imported per repo convention)
// ---------------------------------------------------------------------------

/**
 * Read + validate a `models.yaml` into a {@link ModelProfiles} map. The `yaml`
 * package is loaded on demand (optional dep) — a missing install throws a
 * helpful "install yaml" error rather than being a hard dependency of every
 * consumer.
 */
export async function loadModelProfiles(path: string): Promise<ModelProfiles> {
  const { readFile } = await import("node:fs/promises");
  const yaml = await importOptional("yaml", "loadModelProfiles (models.yaml)");
  const text = await readFile(path, "utf8");
  const parsed = yaml.parse(text) ?? {};
  return ModelProfilesSchema.parse(parsed);
}

// ---------------------------------------------------------------------------
// Convenience factory
// ---------------------------------------------------------------------------

export interface CreateModelResolverOptions {
  /** In-code profiles. Merged over anything loaded from `modelsPath`. */
  profiles?: ModelProfiles;
  /** Path to a `models.yaml`; loaded and merged under `profiles`. */
  modelsPath?: string;
  /** Route non-profile ids through an OpenAI-compatible gateway. See {@link GatewayConfig}. */
  gateway?: GatewayConfig;
}

/** Build a {@link HybridModelResolver}, optionally loading profiles from a `models.yaml`. */
export async function createModelResolver(
  opts: CreateModelResolverOptions = {},
): Promise<HybridModelResolver> {
  const fromYaml = opts.modelsPath ? await loadModelProfiles(opts.modelsPath) : {};
  return new HybridModelResolver({
    profiles: { ...fromYaml, ...opts.profiles },
    gateway: opts.gateway,
  });
}

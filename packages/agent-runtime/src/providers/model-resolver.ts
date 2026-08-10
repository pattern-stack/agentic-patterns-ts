/**
 * ModelResolver — maps an agent's *declared* model id (`agent.getModel()`) to a
 * live {@link ResolvedLanguageModel} at run time.
 *
 * ARCHITECTURE: the model belongs to the **agent**, not the runner. `AgentRunner`
 * is model-agnostic — it "just runs an agent" and asks the resolver to turn that
 * agent's declared model into a live model each `run()`. Per-agent overrides
 * (`agent.withModel(id)` / `buildAgentFromConfig` `modelOverride`) therefore change
 * what the runner dispatches, with no per-runner / per-step-runner plumbing.
 *
 * Back-compat: `new AgentRunner(model)` still works — a concrete
 * {@link ResolvedLanguageModel} is wrapped in a {@link constantModelResolver}
 * that ignores `agent.getModel()` and always returns that model (the
 * pre-resolver behaviour, and the path tests use with `MockLanguageModelV3`).
 *
 * {@link HybridModelResolver} resolution precedence (first match wins):
 *   1. an explicit {@link ModelProfile} — registered in-code or loaded from a
 *      `models.yaml` via {@link loadModelProfiles}. Aliases or pins a model id
 *      to one of the named providers.
 *   2. a configured {@link GatewayConfig} (if any) — routes the id through one
 *      OpenAI-compatible gateway (e.g. Bifrost): one endpoint, the agent's model
 *      id translated to the gateway's namespace by {@link toGatewayModelId}
 *      (tier alias → canonical id, then any configured prefix/qualifier).
 *      Profiles still win, so a profile is the per-id escape hatch to go direct.
 *   3. a pattern-matched well-known family (`gemini-*` → google, `gpt-*`/`o1`/`o3`
 *      → openai, `claude-*` → anthropic, …) — zero-config for the common clouds.
 *   4. a helpful error listing the known families + registered profiles.
 */

import { z } from "zod";

import {
  BIFROST_GUARDRAILS_HEADER,
  BIFROST_VK_HEADER,
  bifrostMetadataExtractor,
} from "./bifrost.js";
import { PROVIDERS, type SupportedProvider, resolveTierAlias } from "./index.js";
import { SUPPORTED_PROVIDERS } from "./types.js";
import type { ResolvedLanguageModel } from "./types.js";

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

/** Turns a declared model id into a live {@link ResolvedLanguageModel}. `modelId`
 *  may be `undefined` when an agent pins no model; a pinned/constant resolver
 *  ignores it, while an id-driven resolver rejects with a clear error. */
export interface ModelResolver {
  resolve(modelId: string | undefined): Promise<ResolvedLanguageModel>;
}

/** Narrow a constructor arg to a {@link ModelResolver} (vs a {@link ResolvedLanguageModel}). */
export function isModelResolver(x: ResolvedLanguageModel | ModelResolver): x is ModelResolver {
  return typeof (x as ModelResolver).resolve === "function";
}

/**
 * A resolver that ignores the id and always returns `model`. Wraps a concrete
 * {@link ResolvedLanguageModel} so `new AgentRunner(model)` keeps the
 * pre-resolver (model-pinned) behaviour — used by tests/mocks and single-model
 * apps.
 */
export function constantModelResolver(model: ResolvedLanguageModel): ModelResolver {
  return { resolve: () => Promise.resolve(model) };
}

// ---------------------------------------------------------------------------
// ModelProfile — the serializable registry entry (also the models.yaml shape)
// ---------------------------------------------------------------------------

/**
 * Provider kinds a profile may target — every {@link SupportedProvider}.
 * Re-exports `types.ts`'s {@link SUPPORTED_PROVIDERS} under this module's
 * established name (kept for back-compat with existing imports).
 */
export const PROFILE_PROVIDERS = SUPPORTED_PROVIDERS;

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
 * which {@link toGatewayModelId} translates into the gateway's namespace before
 * dispatch (tier alias → canonical id; optional vendor qualification).
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
   * Inline Bifrost virtual key, sent as `x-bf-vk` on every request through this
   * gateway. A governed Bifrost 401s (`{"type":"virtual_key_required"}`) on ALL
   * endpoints without it — this is the entry ticket, not an option.
   *
   * Orthogonal to `apiKey`/`Authorization`: `x-bf-vk` is Bifrost governance,
   * `Authorization` is transport/proxy auth (Basic or Bearer). When both are
   * configured, both are sent — a Basic-fronted governed Bifrost needs exactly
   * that. Bifrost also accepts `Authorization: Bearer vk-*`, but this library
   * does NOT auto-map `virtualKey` into `Authorization` — `x-bf-vk` is the
   * canonical header and keeps `Authorization` free for a fronting proxy.
   *
   * Prefer {@link GatewayConfig.virtualKeyEnv} to keep the secret out of config
   * files. Env: `AP_GATEWAY_VIRTUAL_KEY`.
   */
  readonly virtualKey?: string;
  /** Name of an env var holding the virtual key (read at resolve time). Mirror of {@link GatewayConfig.apiKeyEnv}. */
  readonly virtualKeyEnv?: string;
  /**
   * Default guardrail profile ids (e.g. Presidio profiles) sent as
   * `x-bf-guardrail-ids` (comma-joined) on every request through this gateway.
   * Override per run via `RunOptions.requestHeaders` / `bifrostRunHeaders`
   * (per-call headers beat this provider-static default). Env:
   * `AP_GATEWAY_GUARDRAIL_IDS` (comma list).
   */
  readonly guardrailIds?: readonly string[];
  /**
   * How to qualify a canonical id into the gateway's namespace. Two forms:
   *
   *   • a literal prefix (e.g. `"anthropic/"`) — prepended verbatim. The right
   *     choice for a single-vendor gateway.
   *   • {@link GATEWAY_AUTO_PREFIX} (`"auto"`) — derive the vendor segment per id
   *     via {@link inferProvider}, giving `«vendor»/«id»` (e.g. `gpt-4o` →
   *     `openai/gpt-4o`). The right choice for a multi-vendor gateway that
   *     REQUIRES `provider/model` addressing, which one static prefix cannot serve.
   *     An id no rule classifies then fails loud (see {@link toGatewayModelId})
   *     rather than being sent as an unqualified guess.
   *
   * Left unset, a canonical id is sent bare — many gateways (Bifrost, LiteLLM)
   * auto-resolve a bare id against their catalog, and that is the behaviour this
   * library has always had. Prefixing is therefore opt-in: explicit config beats
   * inference, and inference beats nothing.
   *
   * Ids that ALREADY carry a `/` segment are never touched by any of this — the
   * caller has namespaced them deliberately. Ignored when
   * {@link GatewayConfig.qualify} is set. Env: `AP_GATEWAY_MODEL_PREFIX`.
   */
  readonly modelPrefix?: string;
  /**
   * Which provider's tier map translates a declared tier word (`opus` / `sonnet`
   * / `haiku`) into a concrete model id on this gateway. Tier words are not
   * addressable upstream — a gateway 400s on a raw `haiku` — so they are always
   * resolved before dispatch, and this says whose ladder to climb: a gateway
   * fronting Gemini wants `"google"` (haiku → `gemini-2.5-flash-lite`), one
   * fronting Claude wants `"anthropic"` (haiku → `claude-haiku-4-5`).
   *
   * Default `"anthropic"`. Env: `AP_GATEWAY_TIER_PROVIDER`.
   */
  readonly tierProvider?: SupportedProvider;
  /**
   * Full control over agent-id → gateway-id mapping. Overrides `modelPrefix`.
   * Receives the CANONICAL id (tier aliases already resolved), so a custom
   * qualifier never has to re-implement the tier map.
   */
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
  private readonly _cache = new Map<string, Promise<ResolvedLanguageModel>>();
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

  resolve(modelId: string | undefined): Promise<ResolvedLanguageModel> {
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

  private async _build(modelId: string): Promise<ResolvedLanguageModel> {
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
// Profile → ResolvedLanguageModel
// ---------------------------------------------------------------------------

function buildFromProfile(id: string, profile: ModelProfile): Promise<ResolvedLanguageModel> {
  // A profile aliases/pins an id to a named provider; that provider's loader
  // authenticates from its own env vars and takes only a model id.
  const upstreamId = profile.model ?? id;
  return PROVIDERS[profile.provider].load(upstreamId);
}

// ---------------------------------------------------------------------------
// Gateway id translation
// ---------------------------------------------------------------------------

/** {@link GatewayConfig.modelPrefix} value selecting per-id vendor inference. */
export const GATEWAY_AUTO_PREFIX = "auto";

/** Tier map used for a gateway's tier words when it names no {@link GatewayConfig.tierProvider}. */
const DEFAULT_GATEWAY_TIER_PROVIDER: SupportedProvider = "anthropic";

/**
 * Translate an agent's *declared* id into the id this gateway expects.
 *
 * The contract this exists to keep: model selection is implementation-agnostic.
 * An agent declares `haiku` (or `claude-haiku-4-5`, or `gemini-3.1-flash-lite`)
 * once, and it runs on a direct provider AND through a gateway — the resolver
 * layer owns the naming, not the agent. A name we cannot translate fails HERE,
 * with the translation story, rather than reaching the gateway as a nonsense id.
 *
 * Precedence (first match wins):
 *   1. tier alias → canonical id. `opus`/`sonnet`/`haiku` are ladder rungs, not
 *      model ids; they are resolved through `tierProvider`'s tier map (the same
 *      `PROVIDERS[p].tiers` the direct path uses) BEFORE anything below. This is
 *      unconditional — every later rule sees a real model id.
 *   2. `gw.qualify()` — full caller control, given the canonical id.
 *   3. an id that already carries a `/` segment — passed through untouched. The
 *      caller namespaced it deliberately; we never double-prefix.
 *   4. `modelPrefix === "auto"` — infer the vendor segment per id → `«vendor»/«id»`.
 *      Unclassifiable ids throw (below): in auto mode a bare id is a translation
 *      failure, and a guess would 400 at the gateway with a worse message.
 *   5. a literal `modelPrefix` — prepended verbatim (single-vendor gateway).
 *   6. otherwise — the canonical id, bare. Gateways such as Bifrost and LiteLLM
 *      auto-resolve a bare canonical id against their own catalog (verified:
 *      `gemini-3.1-flash-lite` and `gpt-4o-mini` both resolve unprefixed), so
 *      prefixing is opt-in and this path stays byte-for-byte what shipped before.
 */
export function toGatewayModelId(modelId: string, gw: GatewayConfig): string {
  const tierProvider = PROVIDERS[gw.tierProvider ?? DEFAULT_GATEWAY_TIER_PROVIDER];
  const canonical = resolveTierAlias(modelId, tierProvider);

  if (gw.qualify) return gw.qualify(canonical);
  if (canonical.includes("/")) return canonical;

  if (gw.modelPrefix === GATEWAY_AUTO_PREFIX) {
    const vendor = inferProvider(canonical);
    if (!vendor) throw new Error(untranslatableGatewayIdError(modelId, canonical, gw));
    return `${vendor}/${canonical}`;
  }
  if (gw.modelPrefix) return `${gw.modelPrefix}${canonical}`;

  return canonical;
}

/**
 * The loud failure for `modelPrefix: "auto"` when no vendor rule claims the id.
 * Tells the whole translation story — what was declared, what it resolved to, and
 * each way to make it resolvable — because the alternative (shipping the bare id)
 * is exactly the nonsense-id 400 this translation layer exists to prevent.
 */
function untranslatableGatewayIdError(
  declared: string,
  canonical: string,
  gw: GatewayConfig,
): string {
  const tierProvider = gw.tierProvider ?? DEFAULT_GATEWAY_TIER_PROVIDER;
  const tried =
    declared === canonical
      ? `"${declared}" is not a tier alias (opus/sonnet/haiku), and it`
      : `"${declared}" resolved to "${canonical}" via the ${tierProvider} tier map, which then`;
  return [
    `ModelResolver: cannot translate model id "${declared}" for gateway ${gw.baseURL}.`,
    `${tried} matched no known vendor prefix`,
    "(claude-*, gpt-*/o1/o3/o4, gemini-*, grok-*, deepseek-*, mistral-*),",
    'so AP_GATEWAY_MODEL_PREFIX="auto" cannot derive the «vendor»/«model» segment this gateway needs.',
    "Fix with any one of:",
    `  • declare it already qualified (e.g. "openai/${canonical}") — slash ids pass through untouched;`,
    `  • register a profile — resolver.register("${declared}", { provider: "openai", model: "${canonical}" })`,
    "    or a models.yaml entry loaded with loadModelProfiles (profiles win over the gateway);",
    '  • set AP_GATEWAY_MODEL_PREFIX to a literal prefix (e.g. "openai/") for a single-vendor gateway.',
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Gateway → ResolvedLanguageModel
// ---------------------------------------------------------------------------

/**
 * The adapter package gateway routing loads (#478).
 *
 * Exported so the packaging-contract test can assert against the SAME string
 * the loader imports, rather than a second copy that can drift away from it.
 * Bundled for the same reason the three direct providers are (#472): a gateway
 * is a configuration, not an extra install, and an optional dependency here
 * means the recommended setup is the one that does not work out of the box.
 */
export const GATEWAY_PROVIDER_PACKAGE = "@ai-sdk/openai-compatible";

async function buildFromGateway(
  modelId: string,
  gw: GatewayConfig,
): Promise<ResolvedLanguageModel> {
  // Translate BEFORE loading the adapter: an untranslatable id is a config error
  // the caller should hear about whether or not the optional package is installed.
  const gatewayId = toGatewayModelId(modelId, gw);
  const apiKey = gw.apiKey ?? (gw.apiKeyEnv ? process.env[gw.apiKeyEnv] : undefined);
  const virtualKey =
    gw.virtualKey ?? (gw.virtualKeyEnv ? process.env[gw.virtualKeyEnv] : undefined);
  const derivedHeaders: Record<string, string> = {
    ...(virtualKey ? { [BIFROST_VK_HEADER]: virtualKey } : {}),
    ...(gw.guardrailIds?.length ? { [BIFROST_GUARDRAILS_HEADER]: gw.guardrailIds.join(",") } : {}),
  };
  const headers = { ...derivedHeaders, ...gw.headers };
  const mod = await importOptional(GATEWAY_PROVIDER_PACKAGE, "gateway routing (openai-compatible)");
  const provider = mod.createOpenAICompatible({
    name: "gateway",
    baseURL: gw.baseURL,
    ...(apiKey ? { apiKey } : {}),
    ...(Object.keys(headers).length ? { headers } : {}),
    // Provider-level in @ai-sdk/openai-compatible: gates whether the SDK SENDS the
    // json-schema `response_format` (default false → stripped). Opt-in per gateway.
    ...(gw.supportsStructuredOutputs ? { supportsStructuredOutputs: true } : {}),
    // #407: unconditional — the extractor self-neutralizes on non-Bifrost
    // bodies (returns `undefined`), so this is a no-op for every other
    // OpenAI-compatible gateway.
    metadataExtractor: bifrostMetadataExtractor,
  });
  return provider(gatewayId);
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

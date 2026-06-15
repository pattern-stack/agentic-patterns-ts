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
 *      `models.yaml` via {@link loadModelProfiles}. This is where
 *      `openai-compatible` endpoints (custom `baseURL` + auth, e.g. a gateway
 *      such as Bifrost, or direct-vendor with a BYO key) live.
 *   2. a pattern-matched well-known family (`gemini-*` → google, `gpt-*`/`o1`/`o3`
 *      → openai, `claude-*` → anthropic, …) — zero-config for the common clouds.
 *   3. a helpful error listing the known families + registered profiles.
 */

import type { LanguageModelV2 } from "@ai-sdk/provider";
import { z } from "zod";

import { PROVIDERS, type SupportedProvider } from "./index.js";

/**
 * Dynamically import an optional package, throwing an accurate,
 * package-manager-neutral error if it isn't installed. Unlike
 * providers/`importProvider`, this is not provider-framed — it's used by the
 * yaml loader and the openai-compatible adapter, which a consumer installs only
 * when they use those features.
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

/** Turns a declared model id into a live `LanguageModelV2`. */
export interface ModelResolver {
  resolve(modelId: string): Promise<LanguageModelV2>;
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

/** Provider kinds a profile may target — every {@link SupportedProvider} plus the custom-endpoint escape hatch. */
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
  "openai-compatible",
] as const;

/**
 * A single model profile — serializable, so it round-trips through `models.yaml`
 * and (later) a workflow config. `openai-compatible` is the only kind that
 * threads `baseURL`/auth through; the named `@ai-sdk/*` providers authenticate
 * from their own env vars (point a profile at one to alias/pin an id).
 */
export const ModelProfileSchema = z
  .object({
    /** Provider adapter to build from. */
    provider: z.enum(PROFILE_PROVIDERS),
    /** Upstream model id sent to the provider. Defaults to the profile key. */
    model: z.string().optional(),
    /** Endpoint base URL — required for `openai-compatible`. */
    baseURL: z.string().url().optional(),
    /** Inline API key. Prefer {@link ModelProfileSchema.shape.apiKeyEnv} to keep secrets out of yaml. */
    apiKey: z.string().optional(),
    /** Name of an env var holding the API key (read at resolve time). */
    apiKeyEnv: z.string().optional(),
    /** Extra request headers (e.g. a gateway auth header). Openai-compatible only. */
    headers: z.record(z.string()).optional(),
  })
  .strict();

export type ModelProfile = z.infer<typeof ModelProfileSchema>;

/** A map of `{ id → ModelProfile }` — the `models.yaml` document shape. */
export const ModelProfilesSchema = z.record(ModelProfileSchema);
export type ModelProfiles = z.infer<typeof ModelProfilesSchema>;

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
}

/**
 * Resolver implementing the profile → pattern → error precedence. Resolved
 * models are memoised by id (the build is async and provider-package loads are
 * not free); a failed build is evicted so a later call can retry.
 */
export class HybridModelResolver implements ModelResolver {
  private readonly _profiles = new Map<string, ModelProfile>();
  private readonly _cache = new Map<string, Promise<LanguageModelV2>>();

  constructor(opts: HybridModelResolverOptions = {}) {
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

  resolve(modelId: string): Promise<LanguageModelV2> {
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
      'e.g. { provider: "openai-compatible", baseURL: "https://gateway/v1", model: "…" }.',
    ].join("\n");
  }
}

// ---------------------------------------------------------------------------
// Profile → LanguageModelV2
// ---------------------------------------------------------------------------

async function buildFromProfile(id: string, profile: ModelProfile): Promise<LanguageModelV2> {
  const upstreamId = profile.model ?? id;
  const apiKey = profile.apiKey ?? (profile.apiKeyEnv ? process.env[profile.apiKeyEnv] : undefined);

  if (profile.provider === "openai-compatible") {
    if (!profile.baseURL) {
      throw new Error(
        `ModelResolver: profile "${id}" uses provider "openai-compatible" but has no baseURL.`,
      );
    }
    const mod = await importOptional("@ai-sdk/openai-compatible", 'provider "openai-compatible"');
    const provider = mod.createOpenAICompatible({
      name: id,
      baseURL: profile.baseURL,
      ...(apiKey ? { apiKey } : {}),
      ...(profile.headers ? { headers: profile.headers } : {}),
    });
    return provider(upstreamId);
  }

  // Named @ai-sdk/* providers authenticate from their own env vars and their
  // loader takes only a model id. Reject custom-endpoint/auth fields rather than
  // silently dropping them — otherwise an `openai` profile aimed at a gateway
  // would validate and then quietly hit the cloud with the real key.
  if (profile.baseURL || profile.apiKey || profile.apiKeyEnv || profile.headers) {
    throw new Error(
      [
        `ModelResolver: profile "${id}" sets baseURL/apiKey/apiKeyEnv/headers, which only apply to`,
        `provider "openai-compatible". Named providers ("${profile.provider}") authenticate from their`,
        'own env vars — use provider: "openai-compatible" for a custom endpoint or BYO key.',
      ].join(" "),
    );
  }
  return PROVIDERS[profile.provider].load(upstreamId);
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
}

/** Build a {@link HybridModelResolver}, optionally loading profiles from a `models.yaml`. */
export async function createModelResolver(
  opts: CreateModelResolverOptions = {},
): Promise<HybridModelResolver> {
  const fromYaml = opts.modelsPath ? await loadModelProfiles(opts.modelsPath) : {};
  return new HybridModelResolver({ profiles: { ...fromYaml, ...opts.profiles } });
}

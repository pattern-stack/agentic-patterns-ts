# Runner & Provider Strategy — ADR

Status: accepted — implementation follows in a separate PR
Target package: `@agentic-patterns/runtime`
Scope: a `createRunner()` factory + documentation clarifying when to use each of the four existing runners.

**Decisions ratified before drafting:**
1. `AgentRunner` (Vercel AI SDK) is preferred whenever an API key is present — it emits the full canonical event vocabulary. `ClaudeCodeAPIRunner` is a zero-config fallback only.
2. OSS local execution uses `ollama-ai-provider` through `AgentRunner`. The recommended 3-tier Qwen3 stack for a 16GB-class GPU (4080 Super target) is defined in §2.4.
3. Explicit opts beat env vars; env vars beat CLI probes; `MockRunner` is opt-in only (never a silent fallback).

---

## 1. Summary

The runtime today ships four runners behind a single `RunnerProtocol`: `AgentRunner` (Vercel AI SDK, multi-provider, full 20-event vocabulary), `ClaudeCodeRunner` (Claude Agent SDK subprocess, native file/bash tools), `ClaudeCodeAPIRunner` (same subprocess with Code-native tools disabled), and `MockRunner` (scripted, no LLM). The Vercel AI SDK is effectively the "LiteLLM of TypeScript" — there are ~20 first-party `@ai-sdk/*` packages spanning every major hosted and local provider, and `AgentRunner` already drives it through `generateText` / `streamText`, so picking a provider is just picking an `@ai-sdk/*` package. Right now there is no ergonomic entry point: every consumer has to know which runner to instantiate and wire it up by hand (see `packages/agent-server/examples/live-demo.ts`). This doc proposes `createRunner(options?)` with an explicit-beats-env-beats-CLI priority order, dynamic imports so unused provider packages are never loaded, and a one-page "Runners" docs matrix. The major caveat: `ClaudeCodeAPIRunner` is attractive as a zero-config default (works with a Claude Max subscription, no explicit API key), but it does not emit `agent.iteration.*` events and emits tool start/end via hooks rather than the canonical tool-call flow — so we want `AgentRunner` preferred whenever an API key is present, with `ClaudeCodeAPIRunner` as the "you have `claude` on PATH and nothing else" fallback.

---

## 2. Vercel AI SDK provider matrix + current usage

### 2.1 First-party `@ai-sdk/*` provider packages (as of April 2026)

All of these implement `LanguageModelV1` and drop straight into `new AgentRunner(provider("model-id"))`. Capability columns reflect what the provider's model class advertises — not every model from a provider supports every feature.

| Package | Providers / models | Stream | Tool calls | Structured output | Image input | Reasoning | Prompt caching |
|---|---|---|---|---|---|---|---|
| `@ai-sdk/anthropic` | Claude 3.5/3.7/4 Opus/Sonnet/Haiku | yes | yes | yes | yes | yes (extended thinking) | yes (cache_control) |
| `@ai-sdk/openai` | GPT-4o, GPT-4.1, o1, o3, o4-mini | yes | yes | yes (json_schema) | yes | yes (o-series `reasoning`) | yes (automatic) |
| `@ai-sdk/google` | Gemini 1.5/2.0/2.5 Flash/Pro | yes | yes | yes | yes (+ audio, video) | yes (2.5 thinking) | yes (implicit + explicit) |
| `@ai-sdk/google-vertex` | Same as Google, via Vertex AI auth | yes | yes | yes | yes | yes | yes |
| `@ai-sdk/mistral` | Mistral Large/Small, Codestral | yes | yes | yes | limited (Pixtral) | no | no |
| `@ai-sdk/cohere` | Command-R / Command-R+ | yes | yes | yes | no | no | no |
| `@ai-sdk/groq` | Llama 3.x, Mixtral, Gemma on Groq LPU | yes | yes | yes | yes (vision models) | no | no |
| `@ai-sdk/amazon-bedrock` | Anthropic/Meta/Cohere/Mistral/Titan via Bedrock | yes | yes | yes (model-dependent) | yes (model-dependent) | yes (Claude on Bedrock) | yes (Claude on Bedrock) |
| `@ai-sdk/azure` | Azure-hosted OpenAI deployments | yes | yes | yes | yes | yes | yes |
| `@ai-sdk/xai` | Grok-2, Grok-3, Grok-4 | yes | yes | yes | yes | yes (Grok-4) | no |
| `@ai-sdk/fireworks` | Llama, Qwen, DeepSeek, Mixtral on Fireworks | yes | yes | yes | yes | varies | no |
| `@ai-sdk/togetherai` | Together-hosted open models | yes | yes | yes | yes | varies | no |
| `@ai-sdk/perplexity` | Sonar online / offline | yes | limited | limited | no | no | no |
| `@ai-sdk/deepseek` | DeepSeek-Chat, DeepSeek-Reasoner | yes | yes | yes | no | yes (Reasoner) | yes |
| `@ai-sdk/cerebras` | Llama-3.x on Cerebras WSE | yes | yes | yes | no | no | no |
| `@ai-sdk/replicate` | Hosted OSS models on Replicate | yes (polling) | partial | partial | varies | no | no |
| `@ai-sdk/openai-compatible` | Generic OpenAI-compatible endpoints | yes | yes | yes | varies | varies | varies |

### 2.2 Community providers for local + niche

These are community packages implementing the SDK spec — they drop in identically.

| Package | Providers | Notes |
|---|---|---|
| `ollama-ai-provider` | Any local Ollama model | Best choice for "run on my laptop" |
| `@openrouter/ai-sdk-provider` | OpenRouter gateway (150+ models) | Good fallback for models with no first-party SDK |
| `chrome-ai` | Chrome built-in Gemini Nano | Browser-only |
| `@friendliai/ai-provider` | FriendliAI endpoints | |
| `lmstudio-ai-provider` | Local LM Studio | Also OpenAI-compatible, so `@ai-sdk/openai-compatible` works too |

### 2.3 OSS local tier recommendations (Qwen3 via Ollama)

For operators running locally on a 16GB-class consumer GPU (tested on an NVIDIA 4080 Super, 16GB VRAM), we standardize on the **Qwen3** family. Qwen's team explicitly prioritizes function-calling and agentic use, and the MoE variants were built for exactly this hardware class. Same tool-call grammar across every tier, so agents scale up/down without prompt changes.

| Tier | Ollama model | VRAM (Q4) | Throughput | When to pick |
|---|---|---|---|---|
| **opus** | `qwen3:30b-a3b` | ~14 GB | 50–80 tok/s | Complex multi-step tool use, planning, long contexts. 30B MoE activating only 3B/token — fits 16GB *and* stays fast. |
| **sonnet** | `qwen3:14b` | ~9 GB | 30–50 tok/s | Default all-rounder. Dense 14B, lots of context headroom for tool calls. |
| **haiku** | `qwen3:4b` | ~3 GB | 100+ tok/s | Routers / classifiers / short simple turns. Same tool syntax as siblings, zero grammar drift between tiers. |

Alternates if you want to experiment:
- **sonnet-tier alt:** `mistral-small:22b` — slightly higher single-turn quality, slower, solid tool calling.
- **haiku-tier alt:** `llama3.2:3b` — ecosystem default; Qwen is more consistent for tool output.

**Factory integration:** `createRunner()` defaults the `ollama` provider to `qwen3:14b` (sonnet-tier). Explicit overrides via `OLLAMA_MODEL` env var or the `options.modelId` / `options.tier` parameter (the latter is a follow-up — see Open Questions §7.4).

### 2.4 What `AgentRunner` actually uses from the SDK

From `packages/agent-runtime/src/runner/agent-runner.ts`:

* `generateText({ model, system, messages, tools, maxSteps: 1 })` in `run()`
* `streamText({ ... })` + `.fullStream` iteration in `stream()` — consumes `text-delta`, `tool-call`, `step-finish`, `error`
* `ToolCallPart`, `ToolResultPart`, `CoreMessage` types for message construction
* `generateId()` for trace/run/span IDs
* `maxSteps: 1` is deliberate — it makes the tool loop live in our code so gates can intercept `agent.tool.intent` between the LLM turn and the tool execution

### 2.5 SDK features we are **not** using today (gaps)

These are not required for `createRunner()` but worth tracking — some of them meaningfully improve provider-specific UX.

1. **`generateObject` / `streamObject`** — structured-output path. We could use this for agents whose whole job is producing a validated Zod object. Today, agents emulate this through tool calls.
2. **Provider-specific `providerOptions`** — e.g. `providerOptions.anthropic.thinking = { type: "enabled", budgetTokens: 10_000 }` to turn on extended thinking, or `providerOptions.openai.reasoningEffort = "high"`. `AgentRunner` accepts only the raw `LanguageModelV1` and never forwards these, so agents that want reasoning have to bake it into the model factory themselves. Not a blocker, but a future `RunOptions.providerOptions` passthrough is cheap.
3. **Reasoning deltas** — `fullStream` emits `reasoning` parts for extended-thinking models. `AgentRunner.stream()`'s switch statement drops them on the floor. We already have `agent.reasoning` in the event vocabulary and `ClaudeCodeRunner` emits it from `thinking` blocks — `AgentRunner` should do the same. (Tracked separately; mentioned here so we don't forget when we land the factory.)
4. **Image / multimodal inputs** — `CoreMessage` content can be `{ type: "image", image: ... }`. Our `CanonicalMessage` shape is text-only. Out of scope for this doc.
5. **Prompt caching headers** — The Anthropic SDK supports `cacheControl` per message part; we don't set it. For long system prompts this is a real cost win. Out of scope, but flagged.
6. **`experimental_telemetry`** — The SDK can emit OTel spans on its own. We emit our own event stream; duplicating is undesirable. Leave as-is.
7. **`abortSignal`** — `RunOptions` has no `signal`. Adding one later and forwarding to `generateText`/`streamText` is trivial.

**Net:** `AgentRunner` uses the SDK correctly for the single-step-with-intercepted-tool-loop pattern. The main missing bits are `reasoning` events and a `providerOptions` passthrough. The factory does not need to solve these; it just needs to pick the right `LanguageModelV1`.

---

## 3. `ClaudeCodeAPIRunner` as zero-config default — feasibility

### 3.1 Does it satisfy `RunnerProtocol` for real `Agent` instances?

Yes, with a caveat about types. `ClaudeCodeRunner.run()` is typed to take `AgentLikeForBridge`, which is structurally a superset of `AgentLike` (it adds `role.capabilities: ReadonlyArray<Capability>` and narrows `getTools()` to `ToolSchema[]`). Any `Agent` built via `AgentBuilder` satisfies `AgentLikeForBridge` — `role.capabilities` is always present on built roles, and `getTools()` always returns `ToolSchema[]`. So `new ClaudeCodeAPIRunner().run(agent, msg)` works at runtime.

The subtle type issue: `RunnerProtocol.run` declares `agent: AgentLike`. `ClaudeCodeRunner.run` declares `agent: AgentLikeForBridge`. TypeScript treats method parameters contravariantly only under `strictFunctionTypes`, and interface method signatures are bivariant — so the assignment `const r: RunnerProtocol = new ClaudeCodeAPIRunner()` compiles. Calling `r.run(someAgentLike, ...)` would bypass the type-level guarantee that capabilities exist, but every real consumer in this repo hands over a full `Agent`. The factory's return type should be `RunnerProtocol`, and we should document that the Claude-Code runners expect "real" built agents with capabilities. No code change required.

### 3.2 Prerequisites

`@anthropic-ai/claude-agent-sdk`'s `query()` runs Claude Code as a subprocess. As of SDK `0.3.x` the SDK **bundles its own platform-specific executable**: it ships a per-platform package (`@anthropic-ai/claude-agent-sdk-<os>-<arch>`, one of its `optionalDependencies`, pinned to the SDK's own version) and "uses the built-in executable if `pathToClaudeCodeExecutable` is not specified." The SDK↔Claude-Code pair is therefore pinned by the lockfile, and the committed contract fixture (`packages/agent-runtime/src/runner/__fixtures__/claude-agent-sdk-contract.json`, asserted by `sdk-contract.test.ts` in CI) records the tested pair (SDK `0.3.215` ↔ CC `2.1.215`). So in practice:

1. **The SDK must be installed.** `@anthropic-ai/claude-agent-sdk` is a **hard dependency** of `@agentic-patterns/runtime` (pulled in transitively — *not* an optional peer dep). It brings its own executable, so a separately-installed `claude` on PATH is **not required** to run the Claude-Code runners. Since 0.3 the SDK also declares `@anthropic-ai/sdk` and `@modelcontextprotocol/sdk` as peer deps; `@agentic-patterns/runtime` absorbs both as direct dependencies so consumer installs stay whole.
2. Auth is one of:
   * An active `claude` login in `~/.claude/` (Max subscription OAuth token) — via `claude login`.
   * `ANTHROPIC_API_KEY` exported in the environment.
   * `CLAUDE_CODE_OAUTH_TOKEN` (programmatic OAuth) — e.g. for isolated-config runs (see `cc-config.ts`).
3. A host `claude` binary on PATH is **optional**: it is consulted only by the hooks telemetry bridge and by `createRunner`'s `hasClaudeCli()` probe. That PATH probe can false-negative a perfectly runnable bundled-SDK setup, so treat it as a fallback-selection heuristic, not a hard prerequisite.

If auth is missing (or the bundled executable can't launch) the SDK errors the first time the async iterator is consumed — not when `new ClaudeCodeAPIRunner()` is constructed, and not when `query()` returns. From the consumer's perspective, `runner.run(...)` rejects. That's recoverable — the factory can probe launch/auth readiness up-front and fall through to the next choice rather than constructing a doomed runner. Without probing, the error surfaces at first use, which is acceptable but worse DX.

### 3.3 Event-emission gaps vs `AgentRunner`

Running the same agent through both runners, here's what each emits:

| Event | `AgentRunner` | `ClaudeCodeRunner` / `ClaudeCodeAPIRunner` |
|---|---|---|
| `agent.conversation.start` | stream only | no |
| `agent.message.start` | yes | yes |
| `agent.iteration.start` / `agent.iteration.end` | yes (one per tool-loop turn) | **no** (Claude Code owns the loop; exposed as a single iteration) |
| `agent.llm.start` / `agent.llm.end` | yes — with `model`, `inputTokens`, `outputTokens`, `durationMs`, `finishReason`, `hasToolCalls` | **no** — token usage surfaces only on `agent.message.complete` from the final `result` SDK message |
| `agent.message.chunk` | yes (text deltas) | yes (in `stream()` only, from `stream_event` messages) |
| `agent.reasoning` | **no** (SDK emits reasoning parts, runner drops them) | yes (from `thinking` blocks in assistant messages) |
| `agent.tool.intent` | yes | yes (emitted from `PreToolUse` hook, runs through gate chain with `permissionDecision: "deny"` fallback) |
| `agent.tool.start` | yes | yes (from `PreToolUse`, after gate check) |
| `agent.tool.end` | yes — with `durationMs`, `resultTokens` | yes (from `PostToolUse`) — **`durationMs` always 0**, `resultTokens` always 0 |
| `agent.tool.rejected` | emitted by gate chain | emitted by gate chain |
| `agent.message.complete` | yes — `inputTokens`, `outputTokens`, `model` | yes — `inputTokens`, `outputTokens`, `model` |
| `agent.conversation.end` | stream only | no |
| `agent.error` | yes | yes |

**Observable gaps that matter for the dashboard / observability stack:**

1. **No per-LLM-call tokens**: tokens are only available at message-complete, so latency charts keyed on `llm.end` show nothing.
2. **No iteration markers**: "how many tool-loop turns did Claude Code take?" is invisible. It reports `iterations: 1` regardless of how many tool calls happened.
3. **Tool call `durationMs: 0`**: `PostToolUse` hook doesn't give us a start timestamp. To fix, we'd need to stash `Date.now()` in `tcSpanIds` alongside the span id. Cheap followup, not in this PR.
4. **`finishReason` always `"stop"`** — no visibility into `max_turns`, tool-error, etc.

These don't break correctness but they do degrade the admin dashboard's usefulness when `ClaudeCodeAPIRunner` is the active runner. Documented; the factory should prefer `AgentRunner` over `ClaudeCodeAPIRunner` when both are possible (see §4).

### 3.4 Conclusion: use it as last-resort default, not first-choice

Use `ClaudeCodeAPIRunner` as the fallback when no API key is set but the user has a Claude Max login via the CLI. Prefer `AgentRunner + @ai-sdk/anthropic` when `ANTHROPIC_API_KEY` is available, since it gives richer events and doesn't require a subprocess.

---

## 4. `createRunner()` factory — proposed implementation

### 4.1 API surface

```ts
// packages/agent-runtime/src/runner/create-runner.ts
import type { LanguageModelV1 } from "ai";

import type { AgentEventBus } from "../events/agent-event-bus.js";
import type { RunnerProtocol } from "./types.js";

/** Providers the factory knows how to auto-wire. */
export type SupportedProvider =
  | "anthropic"
  | "openai"
  | "google"
  | "groq"
  | "mistral"
  | "xai"
  | "deepseek"
  | "openrouter"
  | "ollama";

export interface CreateRunnerOptions {
  /**
   * Explicit runner instance. If present, wins over everything else.
   * Useful for tests (`runner: new MockRunner()`) or bespoke setups.
   */
  runner?: RunnerProtocol;

  /**
   * Explicit provider. Overrides env-based detection.
   * Requires the corresponding `@ai-sdk/*` package to be installed.
   */
  provider?: SupportedProvider;

  /**
   * Model id for the chosen provider. Falls through to a sensible per-provider default.
   * Ignored if `runner` or `model` is given.
   */
  modelId?: string;

  /**
   * Pre-constructed `LanguageModelV1`. Short-circuits provider resolution —
   * the factory wraps it in `AgentRunner`. Useful if you want custom provider
   * options (reasoning, caching) the factory doesn't expose.
   */
  model?: LanguageModelV1;

  /** Optional event bus (otherwise runner uses the global default). */
  eventBus?: AgentEventBus;

  /** Log the runner-selection decision to console. Defaults to true in dev, false otherwise. */
  verbose?: boolean;

  /**
   * If nothing matches, fall back to MockRunner instead of throwing.
   * Defaults to false.
   */
  fallbackToMock?: boolean;
}

export interface RunnerSelection {
  runner: RunnerProtocol;
  /** Human-readable explanation of why this runner was chosen. */
  reason: string;
  /** Tag for logs/metrics. */
  source:
    | "explicit-runner"
    | "explicit-model"
    | "explicit-provider"
    | "env-anthropic"
    | "env-openai"
    | "env-google"
    | "env-groq"
    | "env-mistral"
    | "env-xai"
    | "env-deepseek"
    | "env-openrouter"
    | "env-ollama"
    | "claude-cli"
    | "mock-fallback";
}

/**
 * Create a runner with environment-aware defaults.
 *
 * Priority (first match wins):
 *   1. options.runner                               → as-is
 *   2. options.model                                → AgentRunner(model)
 *   3. options.provider + modelId                   → AgentRunner(provider(modelId))
 *   4. ANTHROPIC_API_KEY                            → AgentRunner(anthropic(...))
 *   5. OPENAI_API_KEY                               → AgentRunner(openai(...))
 *   6. GOOGLE_GENERATIVE_AI_API_KEY                 → AgentRunner(google(...))
 *   7. GROQ_API_KEY                                 → AgentRunner(groq(...))
 *   8. MISTRAL_API_KEY                              → AgentRunner(mistral(...))
 *   9. XAI_API_KEY                                  → AgentRunner(xai(...))
 *  10. DEEPSEEK_API_KEY                             → AgentRunner(deepseek(...))
 *  11. OPENROUTER_API_KEY                           → AgentRunner(openrouter(...))
 *  12. OLLAMA_HOST                                  → AgentRunner(ollama(...))
 *  13. `claude` CLI on PATH                         → ClaudeCodeAPIRunner
 *  14. options.fallbackToMock                       → MockRunner
 *  15. throw
 *
 * Provider packages are imported dynamically — the factory only requires
 * the `@ai-sdk/*` package that matches the selected provider.
 */
export async function createRunner(
  options: CreateRunnerOptions = {},
): Promise<RunnerSelection> {
  const log = options.verbose ?? process.env.NODE_ENV !== "production";

  // 1. Explicit runner
  if (options.runner) {
    return report(log, {
      runner: options.runner,
      source: "explicit-runner",
      reason: "options.runner was provided",
    });
  }

  // 2. Explicit pre-built model
  if (options.model) {
    const { AgentRunner } = await import("./agent-runner.js");
    return report(log, {
      runner: new AgentRunner(options.model, options.eventBus),
      source: "explicit-model",
      reason: "options.model (LanguageModelV1) was provided",
    });
  }

  // 3. Explicit provider
  if (options.provider) {
    const model = await loadProvider(options.provider, options.modelId);
    const { AgentRunner } = await import("./agent-runner.js");
    return report(log, {
      runner: new AgentRunner(model, options.eventBus),
      source: "explicit-provider",
      reason: `options.provider = "${options.provider}"`,
    });
  }

  // 4–12. Env-based provider detection (ordered)
  const envMatch = detectEnvProvider();
  if (envMatch) {
    const model = await loadProvider(envMatch.provider, options.modelId);
    const { AgentRunner } = await import("./agent-runner.js");
    return report(log, {
      runner: new AgentRunner(model, options.eventBus),
      source: envMatch.source,
      reason: `${envMatch.envVar} is set`,
    });
  }

  // 13. claude CLI
  if (await hasClaudeCli()) {
    const { ClaudeCodeAPIRunner } = await import("./claude-code-api-runner.js");
    return report(log, {
      runner: new ClaudeCodeAPIRunner({ eventBus: options.eventBus }),
      source: "claude-cli",
      reason:
        "No API key env var found, but `claude` CLI is on PATH. " +
        "Using ClaudeCodeAPIRunner (Claude Max auth). " +
        "Note: this runner does not emit per-iteration or per-LLM-call events.",
    });
  }

  // 14. Mock fallback
  if (options.fallbackToMock) {
    const { MockRunner } = await import("./mock-runner.js");
    return report(log, {
      runner: new MockRunner(),
      source: "mock-fallback",
      reason:
        "No API key, no `claude` CLI found. Using MockRunner (options.fallbackToMock was true).",
    });
  }

  throw new Error(
    [
      "createRunner: no runnable configuration found.",
      "Provide one of:",
      "  • options.runner (a RunnerProtocol instance)",
      "  • options.model (a LanguageModelV1)",
      "  • options.provider + the matching @ai-sdk/* package installed",
      "  • ANTHROPIC_API_KEY / OPENAI_API_KEY / GOOGLE_GENERATIVE_AI_API_KEY / GROQ_API_KEY /",
      "    MISTRAL_API_KEY / XAI_API_KEY / DEEPSEEK_API_KEY / OPENROUTER_API_KEY in env",
      "  • `claude` CLI on PATH (Claude Max login or ANTHROPIC_API_KEY)",
      "  • options.fallbackToMock = true",
    ].join("\n"),
  );
}

// ---------------------------------------------------------------------------
// Provider loading (dynamic imports so unused providers stay uninstalled)
// ---------------------------------------------------------------------------

const DEFAULT_MODELS: Record<SupportedProvider, string> = {
  anthropic: "claude-sonnet-4-5",
  openai: "gpt-4o",
  google: "gemini-2.5-flash",
  groq: "llama-3.3-70b-versatile",
  mistral: "mistral-large-latest",
  xai: "grok-3",
  deepseek: "deepseek-chat",
  openrouter: "anthropic/claude-sonnet-4-5",
  ollama: "qwen3:14b", // sonnet-tier; see §2.3 for the 3-tier table
};

async function loadProvider(
  provider: SupportedProvider,
  modelId?: string,
): Promise<LanguageModelV1> {
  const id = modelId ?? DEFAULT_MODELS[provider];

  switch (provider) {
    case "anthropic": {
      const mod = await importOrFail("@ai-sdk/anthropic", provider);
      return mod.anthropic(id);
    }
    case "openai": {
      const mod = await importOrFail("@ai-sdk/openai", provider);
      return mod.openai(id);
    }
    case "google": {
      const mod = await importOrFail("@ai-sdk/google", provider);
      return mod.google(id);
    }
    case "groq": {
      const mod = await importOrFail("@ai-sdk/groq", provider);
      return mod.groq(id);
    }
    case "mistral": {
      const mod = await importOrFail("@ai-sdk/mistral", provider);
      return mod.mistral(id);
    }
    case "xai": {
      const mod = await importOrFail("@ai-sdk/xai", provider);
      return mod.xai(id);
    }
    case "deepseek": {
      const mod = await importOrFail("@ai-sdk/deepseek", provider);
      return mod.deepseek(id);
    }
    case "openrouter": {
      const mod = await importOrFail("@openrouter/ai-sdk-provider", provider);
      return mod.openrouter(id);
    }
    case "ollama": {
      const mod = await importOrFail("ollama-ai-provider", provider);
      return mod.ollama(id);
    }
  }
}

// biome-ignore lint/suspicious/noExplicitAny: dynamic provider module shape
async function importOrFail(pkg: string, provider: SupportedProvider): Promise<any> {
  try {
    return await import(/* @vite-ignore */ pkg);
  } catch (e) {
    throw new Error(
      `createRunner: provider "${provider}" requires "${pkg}" to be installed. ` +
        `Run: bun add ${pkg}`,
      { cause: e },
    );
  }
}

// ---------------------------------------------------------------------------
// Env detection
// ---------------------------------------------------------------------------

interface EnvMatch {
  provider: SupportedProvider;
  envVar: string;
  source: RunnerSelection["source"];
}

function detectEnvProvider(): EnvMatch | undefined {
  const env = process.env;
  if (env.ANTHROPIC_API_KEY)
    return { provider: "anthropic", envVar: "ANTHROPIC_API_KEY", source: "env-anthropic" };
  if (env.OPENAI_API_KEY)
    return { provider: "openai", envVar: "OPENAI_API_KEY", source: "env-openai" };
  if (env.GOOGLE_GENERATIVE_AI_API_KEY)
    return { provider: "google", envVar: "GOOGLE_GENERATIVE_AI_API_KEY", source: "env-google" };
  if (env.GROQ_API_KEY)
    return { provider: "groq", envVar: "GROQ_API_KEY", source: "env-groq" };
  if (env.MISTRAL_API_KEY)
    return { provider: "mistral", envVar: "MISTRAL_API_KEY", source: "env-mistral" };
  if (env.XAI_API_KEY)
    return { provider: "xai", envVar: "XAI_API_KEY", source: "env-xai" };
  if (env.DEEPSEEK_API_KEY)
    return { provider: "deepseek", envVar: "DEEPSEEK_API_KEY", source: "env-deepseek" };
  if (env.OPENROUTER_API_KEY)
    return { provider: "openrouter", envVar: "OPENROUTER_API_KEY", source: "env-openrouter" };
  if (env.OLLAMA_HOST)
    return { provider: "ollama", envVar: "OLLAMA_HOST", source: "env-ollama" };
  return undefined;
}

// ---------------------------------------------------------------------------
// Claude CLI probe
// ---------------------------------------------------------------------------

async function hasClaudeCli(): Promise<boolean> {
  try {
    const { spawn } = await import("node:child_process");
    return await new Promise<boolean>((resolve) => {
      const child = spawn("claude", ["--version"], { stdio: "ignore" });
      child.on("error", () => resolve(false));
      child.on("exit", (code) => resolve(code === 0));
      // Safety timeout — don't hang startup if the binary is broken
      setTimeout(() => {
        child.kill();
        resolve(false);
      }, 2000);
    });
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function report(log: boolean, selection: RunnerSelection): RunnerSelection {
  if (log) {
    // biome-ignore lint/suspicious/noConsole: intentional dev log
    console.log(`[createRunner] selected ${selection.source}: ${selection.reason}`);
  }
  return selection;
}
```

Export from `packages/agent-runtime/src/runner/index.ts`:

```ts
export { createRunner } from "./create-runner.js";
export type {
  CreateRunnerOptions,
  RunnerSelection,
  SupportedProvider,
} from "./create-runner.js";
```

### 4.2 Design decisions — called out explicitly

| Decision | Choice | Why |
|---|---|---|
| Explicit > env? | **Yes.** `options.runner` and `options.provider` both beat env vars. | Tests and bespoke setups must win. Env is ambient, not authoritative. |
| `AgentRunner` vs `ClaudeCodeAPIRunner` when both possible? | **Prefer `AgentRunner`.** `ANTHROPIC_API_KEY` ranks higher than the `claude` CLI probe. | Richer events (`iteration.*`, per-call tokens, `reasoning`), no subprocess, no Code-tool confusion. |
| Log the selection? | **Yes, in dev; off in production.** Controllable via `options.verbose`. | First-run debuggability is huge. Silencing in prod avoids log noise. |
| Return sync or async? | **Async.** | We need dynamic `import()` for provider packages and a subprocess probe for `claude --version`. |
| Sync wrapper? | Not in v1. If someone needs it we can ship `createRunnerSync(options)` that skips the CLI probe and requires an explicit provider/model/runner. | Keeps the surface small. |
| Pass `eventBus` through? | **Yes**, via `options.eventBus`. | Server needs it for SSE; live-demo.ts already wires one explicitly. |
| `modelId`? | Yes, optional, with per-provider defaults. | Most callers want "sonnet, whatever that means this month." Per-provider defaults are updatable in one place. |
| Dynamic imports? | **Yes**, for every `@ai-sdk/*` provider and for `ClaudeCodeAPIRunner`. | `@agentic-patterns/runtime` must stay light; we should not force users who want `@ai-sdk/openai` to also install `@ai-sdk/anthropic`. The `peerDependencies` in package.json already marks `@anthropic-ai/claude-agent-sdk` optional — providers should follow the same pattern (added as `optionalPeerDependencies` in the package.json update that ships with this factory). |
| Rich return type (`{runner, reason, source}`) vs just `RunnerProtocol`? | **Rich.** Callers that just want the runner destructure `{ runner } = await createRunner()`. | `source` is useful for metrics / admin dashboard ("currently running on: env-anthropic"). Adds negligible complexity. |
| Throw vs MockRunner fallback when nothing found? | **Throw by default, MockRunner opt-in.** | Silent mock is a footgun in production. Tests opt in explicitly. |

### 4.3 Selection priority (decision tree)

```
createRunner(options)
│
├─ options.runner present?
│    └─ yes → use it (source: "explicit-runner")
│
├─ options.model present?
│    └─ yes → wrap in AgentRunner (source: "explicit-model")
│
├─ options.provider present?
│    └─ yes → dynamic import @ai-sdk/<provider>, AgentRunner (source: "explicit-provider")
│
├─ ANTHROPIC_API_KEY              → AgentRunner + anthropic     (source: "env-anthropic")
├─ OPENAI_API_KEY                 → AgentRunner + openai        (source: "env-openai")
├─ GOOGLE_GENERATIVE_AI_API_KEY   → AgentRunner + google        (source: "env-google")
├─ GROQ_API_KEY                   → AgentRunner + groq          (source: "env-groq")
├─ MISTRAL_API_KEY                → AgentRunner + mistral       (source: "env-mistral")
├─ XAI_API_KEY                    → AgentRunner + xai           (source: "env-xai")
├─ DEEPSEEK_API_KEY               → AgentRunner + deepseek      (source: "env-deepseek")
├─ OPENROUTER_API_KEY             → AgentRunner + openrouter    (source: "env-openrouter")
├─ OLLAMA_HOST                    → AgentRunner + ollama        (source: "env-ollama")
│
├─ `claude --version` exits 0     → ClaudeCodeAPIRunner         (source: "claude-cli")
│
├─ options.fallbackToMock === true → MockRunner                  (source: "mock-fallback")
│
└─ throw with the "no runnable configuration found" message.
```

---

## 5. Documentation section — "Runners"

> Drop-in for the runtime README / docs site.

### Runners

`@agentic-patterns/runtime` ships four runners. They all implement `RunnerProtocol` — any agent runs under any runner. Pick based on what you care about: multi-provider support, Claude Code's native tools, your Claude Max subscription, or deterministic tests.

#### Choice matrix

| Need | Use | Why |
|---|---|---|
| Zero-config dev on a Claude Max subscription | `createRunner()` (falls through to `ClaudeCodeAPIRunner`) | No API key needed; uses the `claude` CLI login. |
| Any hosted provider (OpenAI, Gemini, Groq, Mistral, xAI, DeepSeek, …) | `AgentRunner` + `@ai-sdk/<provider>` | Full event vocabulary, native streaming, tool calls. |
| Local model (Ollama) | `AgentRunner` + `ollama-ai-provider` | Same event surface as hosted. |
| Deterministic unit tests | `MockRunner` | No network, scripted responses, full event emission. |
| Agents that actually run `Read`/`Write`/`Bash` | `ClaudeCodeRunner` | Claude Code's built-in tools are enabled. |

#### `createRunner()` — the easy path

```ts
import { createRunner } from "@agentic-patterns/runtime";

// Zero-config: picks up ANTHROPIC_API_KEY, OPENAI_API_KEY, etc., or falls back to Claude CLI.
const { runner, reason } = await createRunner();
console.log(reason); // "ANTHROPIC_API_KEY is set"

// Explicit provider
const { runner } = await createRunner({
  provider: "openai",
  modelId: "gpt-4o",
});

// Pre-built model with your own provider options
import { anthropic } from "@ai-sdk/anthropic";
const { runner } = await createRunner({
  model: anthropic("claude-sonnet-4-5"),
});

// In tests
import { MockRunner } from "@agentic-patterns/runtime";
const { runner } = await createRunner({
  runner: new MockRunner().addResponse("*", { content: "ok" }),
});
```

#### `AgentRunner` — multi-provider via Vercel AI SDK

```ts
import { AgentRunner } from "@agentic-patterns/runtime";
import { openai } from "@ai-sdk/openai";

const runner = new AgentRunner(openai("gpt-4o"));
const result = await runner.run(agent, "What is 2 + 2?");

// Streaming — yields the full 20-event vocabulary
for await (const event of runner.stream!(agent, "Explain recursion")) {
  if (event.type === "agent.message.chunk") process.stdout.write(event.delta);
}
```

Emits the full event vocabulary including `agent.iteration.*` and per-call `agent.llm.start` / `agent.llm.end` with token counts — making it the best choice when you want rich observability in the admin dashboard.

#### `ClaudeCodeAPIRunner` — zero-config Claude Max

```ts
import { ClaudeCodeAPIRunner } from "@agentic-patterns/runtime";

const runner = new ClaudeCodeAPIRunner();
const result = await runner.run(agent, "What is 2 + 2?");
```

Uses the Claude Agent SDK subprocess but blocks Claude Code's native tools (`Read`, `Write`, `Bash`, `WebFetch`, etc.). MCP tools from agent capabilities still work. Requires the `claude` CLI installed and logged in (or `ANTHROPIC_API_KEY`).

**Trade-off:** does not emit `agent.iteration.*` events; token usage and reasoning are reported only at message-complete time; `agent.tool.end.durationMs` is always 0. Use `AgentRunner + @ai-sdk/anthropic` if you want per-call timing in the admin dashboard.

#### `ClaudeCodeRunner` — Claude Code's native tools

```ts
import { ClaudeCodeRunner } from "@agentic-patterns/runtime";

const runner = new ClaudeCodeRunner();
await runner.run(agent, "Review the last commit and fix the typo in README.md");
```

Same as the API runner but leaves Claude Code's native tools (`Read`, `Write`, `Bash`, etc.) enabled. Use this when you actually want Claude Code to do file-system work.

#### `MockRunner` — deterministic tests

```ts
import { MockRunner } from "@agentic-patterns/runtime";

const runner = new MockRunner()
  .addResponse("add", {
    content: "Sure, adding.",
    toolCalls: [{ name: "add", arguments: { a: 1, b: 2 }, result: { result: 3 } }],
  })
  .addResponse("*", { content: "I don't know." });

const result = await runner.run(agent, "please add 1 and 2");
expect(runner.callHistory).toHaveLength(1);
```

Supports substring triggers and `"*"` wildcard. Emits the full streaming event lifecycle so gates and exporters under test see what they'd see in production.

#### Environment variables recognized by `createRunner()`

| Env var | Selects |
|---|---|
| `ANTHROPIC_API_KEY` | `@ai-sdk/anthropic` |
| `OPENAI_API_KEY` | `@ai-sdk/openai` |
| `GOOGLE_GENERATIVE_AI_API_KEY` | `@ai-sdk/google` |
| `GROQ_API_KEY` | `@ai-sdk/groq` |
| `MISTRAL_API_KEY` | `@ai-sdk/mistral` |
| `XAI_API_KEY` | `@ai-sdk/xai` |
| `DEEPSEEK_API_KEY` | `@ai-sdk/deepseek` |
| `OPENROUTER_API_KEY` | `@openrouter/ai-sdk-provider` |
| `OLLAMA_HOST` | `ollama-ai-provider` |
| `AP_GATEWAY_BASE_URL` | Routes every agent's declared model through one OpenAI-compatible gateway (Bifrost, LiteLLM, vLLM, …) instead of a single bound provider |
| `AP_GATEWAY_API_KEY` | Gateway bearer key — sent as `Authorization: Bearer` |
| `AP_GATEWAY_BASIC_USER` + `AP_GATEWAY_BASIC_PASS` | Gateway HTTP Basic auth (e.g. a Bifrost deployment fronted by Basic, which 401s on Bearer) — sent as a precomputed `Authorization: Basic <base64>`. Use this **or** `AP_GATEWAY_API_KEY`, not both |
| `AP_GATEWAY_MODEL_PREFIX` | Optional id prefix qualifying the agent's declared model to the gateway's namespace (e.g. `anthropic/` turns `claude-sonnet-4-5` into `anthropic/claude-sonnet-4-5`) |
| _(none, `claude` on PATH)_ | `ClaudeCodeAPIRunner` |

**Gateway is a routing override, not a fallback.** `envGateway()` (`create-runner.ts`) is read at step "2.5" of the priority list — before `options.provider` and before the env-var rows above — and, when set, builds a resolver-backed runner (`HybridModelResolver`) that dispatches **each agent's own declared model** through the gateway at call time, rather than binding one model up front. That also means `tier`/`modelId` are ignored on this path: the gateway receives whatever each agent declares (optionally prefixed), so one `AP_GATEWAY_BASE_URL` is enough to route an entire multi-agent project through Bifrost (or any OpenAI-compatible endpoint) with no per-provider key. See `providers/model-resolver.ts` (`GatewayConfig`, `HybridModelResolver`) for the resolution precedence (profile → gateway → pattern-matched family → error).

#### Credential preflight (`ap` CLI)

§3.4 above treats `ClaudeCodeAPIRunner` as `createRunner()`'s last-resort default — fine for local dev on a Claude Max subscription, but a deploy trap: a real deployment has no `claude` binary, no interactive login, and gets the degraded event vocabulary from §3.3. The CLI package (`@agentic-patterns/cli`) puts a credential preflight in front of that fallback so it's a loud, explicit choice rather than a silent one.

`packages/agent-cli/src/services/execution-service.ts` exports `ExecutionService`, which `ap eval`, `ap run`, and `ap playground` now all construct and call instead of `createRunner()` directly:

```ts
const svc = new ExecutionService({ configRoot });
const selection = await svc.resolveRunner(runnerOpts, agents);
```

`resolveRunner()` forwards `runnerOpts` (each command's existing `CreateRunnerOptions` — eval's `tier`, run's env ladder, playground's `resolveAgentModel`/tier override) to `createRunner()` **verbatim**; the service changes nothing about resolution policy, it only adds a check beforehand:

1. **`inspect(agents)`** — pure, no side effects. For every discovered agent it reads the declared model (`agent.getModel()`), classifies it with `inferProvider()`, and checks whether that provider's env var(s) (`PROVIDERS[provider].envVars`) are set. The result is a `CredentialReport`: providers implied by the agents, any unclassified model ids, and `hasCredential` — true if `AP_GATEWAY_BASE_URL` is set **or** any provider key is present at all (even one no agent declared, since the env-priority ladder in `createRunner` could still pick it up).
2. **No credential found** → a framed warning goes to `stderr`: which providers the agents declare, which models didn't classify, and the fix (`ap config set`, or point at a gateway). This fires whether or not the process is interactive — CI logs still show it.
3. **Interactive (TTY, and neither `AP_NO_PROMPT` nor `CI=true`)** → a `@clack/prompts` menu offers to set `ANTHROPIC_API_KEY`, set `OPENAI_API_KEY`, configure a gateway (base URL, Basic-vs-Bearer auth, optional model prefix), continue on the Claude subscription anyway (explicit, dev-only), or quit. Answers are written to `.env` via the same `upsertEnvFile` helper `ap config set` uses, so they land in the project's `.env` (under `configRoot`, threaded from `cli.ts`'s `config.root` — the nearest `package.json` directory) and take effect immediately via `process.env` for the rest of the run.
4. **Non-interactive (CI / non-TTY / `AP_NO_PROMPT=1`)** → warns once and continues; no hard block. `createRunner()` still runs its own ladder afterwards, so a non-interactive run with no credential at all still falls through to the CC subscription (or throws, per §4's step 7) exactly as before this preflight existed.

`ap config` / `ap config set` is the persistent surface for the same variables: `TRACKED_ENV` (`commands/config.ts`) now lists the `AP_GATEWAY_*` keys alongside the provider keys, so `ap config`'s status view and `ap config set`'s picker cover gateway setup too — not just the interactive prompt above.

**Parked follow-up:** `run`/`eval` still resolve one bound model up front (tier or env ladder); only `playground` opts into resolver mode (`resolveAgentModel: true`) by default. Whether `run`/`eval` should also default to per-agent resolver mode is an open question, not addressed by this change.

---

## 6. Open questions / risks

1. **Sync vs async return.** `createRunner()` is async (dynamic imports + CLI probe). Most consumers are already in async context (`main()`, route handlers). If a caller is in a sync constructor we'll want a `createRunnerSync` variant — but it would have to refuse the `claude` CLI fallback (no sync subprocess probe) and dynamic imports become `require()`, which breaks pure-ESM builds. **Recommendation: don't ship a sync variant in v1.** Revisit if someone asks.

2. **Ordering of env vars.** We picked `ANTHROPIC → OPENAI → GOOGLE → ...`. If a user has both `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` set (common) they'll always get Anthropic. Is that right? Anthropic-first matches the repo's center of gravity (it's agentic-patterns, Claude Code SDK is a peer dep). Document the order prominently; let `options.provider` override trivially. **No change needed.**

3. **`@ai-sdk/*` as optional peer deps vs just "install what you need".** Currently `ai` and `@anthropic-ai/claude-agent-sdk` are the only peer deps. The factory needs `@ai-sdk/*` packages to be resolvable at runtime when `createRunner` loads them. Options: (a) add all nine as `optionalPeerDependencies`; (b) document "install the provider package you want"; (c) do nothing and let the `importOrFail` error guide the user. **Recommendation: (c)** — same pattern as `@anthropic-ai/claude-agent-sdk`, the error message is helpful, and we don't bloat the peer-dep list. Revisit if users hit it often.

4. **Claude CLI probe is blocking on `createRunner()`.** 2s timeout worst case. Acceptable for a one-time server-startup call. If it shows up in hot paths we'll cache the probe result at module scope.

5. **`hasClaudeCli()` on Windows.** `spawn("claude")` without `.cmd` extension can fail on Windows. Node 20+'s `spawn` does some auto-extension handling with `shell: true` but it's flaky. Fix: try `claude --version` with `shell: true` on `process.platform === "win32"`. Non-blocking; handle in implementation PR.

6. **`AgentRunner` dropping reasoning deltas.** Flagged in §2.4. Not a `createRunner` concern, but users who `createRunner({ provider: "anthropic", modelId: "claude-opus-4" })` and expect extended-thinking events will be surprised. File a follow-up issue to teach `AgentRunner.stream()` to handle `reasoning` parts from `fullStream`.

7. **Event parity between runners.** Documented in §3.3. We should consider a small normalization layer — e.g. `ClaudeCodeRunner` synthesizing `agent.iteration.start/end` events around each tool-use/tool-result pair so the dashboard shows a unified view. Probably a separate PR once this factory lands.

8. **Telemetry / metric on `source`.** The `RunnerSelection.source` field is a free metric dimension (`runner_source="env-anthropic"`). If we add Prometheus/OTel metrics later, label runs with this. No action now, just noted.

9. **Server integration.** `packages/agent-server/examples/live-demo.ts` hard-codes `new ClaudeCodeAPIRunner(...)`. The implementation PR should update it to `const { runner } = await createRunner({ eventBus })` so the demo picks up whatever the user has set. Same story for any other places that instantiate runners directly — grep for `new AgentRunner`, `new ClaudeCodeRunner`, `new ClaudeCodeAPIRunner`.

10. **Should `createRunner` also register the event bus globally?** Today `AgentEventBus` has a `getAgentEventBus()` singleton accessor. If the caller passes `options.eventBus`, should we also set it as the default? **Recommendation: no.** Keep `createRunner` pure; let the caller decide about globals.

11. **Tier-based model selection (`options.tier`).** Called out in §2.3 — the idea is `createRunner({ tier: "opus" })` picks the provider's "opus equivalent" (Claude Opus / GPT-4.1 / `qwen3:30b-a3b`) automatically. Keeps agent code portable across providers and sizes. **Defer to a follow-up PR** once the factory shape is in use; deciding the cross-provider tier map (what's the "haiku" of OpenAI, Gemini 2.5 Flash-8B vs Flash?) deserves its own conversation. For v1, caller passes `modelId` explicitly when they want anything other than the per-provider default.

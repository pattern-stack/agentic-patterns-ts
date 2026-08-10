---
title: "ADR 0010 — Ship the three common @ai-sdk/* providers as real dependencies of @agentic-patterns/runtime"
description: "The anthropic, openai, and google AI SDK providers become runtime dependencies so the common path works on install; adapters declare packageName/bundled and missing packages fail with a typed ProviderPackageError."
sidebar:
  label: "ADR 0010 — Bundled Providers"
---

- **Status:** ACCEPTED — implemented in the PR that lands this file.
- **Date:** 2026-08-10
- **Context owner:** Doug
- **Issue:** [#472](https://github.com/pattern-stack/agentic-patterns-ts/issues/472)
- **Scope:**
  - `packages/agent-runtime/package.json` — `@ai-sdk/anthropic`, `@ai-sdk/openai`, `@ai-sdk/google` move into `dependencies` (anthropic was a devDependency; the other two were absent).
  - `packages/agent-runtime/src/providers/types.ts` — `ProviderProtocol` gains `packageName` and `bundled`; `importProvider` gains a `bundled` argument and throws the new `ProviderPackageError`.
  - `packages/agent-runtime/src/providers/*.ts` — all nine adapters declare `packageName` / `bundled`.
  - `packages/agent-runtime/src/providers/index.ts` — `BUNDLED_PROVIDERS`, `BUNDLED_PROVIDER_ENV_VARS`, both derived from the registry.
  - `packages/agent-runtime/src/runner/create-runner.ts` — `loadProviderModel()` wraps every `provider.load()` call; the `claude` CLI rung's `reason` is rewritten.
  - `packages/agent-core` — **untouched**. The layering rule holds: core never imports runtime, and neither reaches for a vendor SDK.

## Context

`createRunner()` imported every provider package dynamically and `@agentic-patterns/runtime` shipped none of them. A consuming app that installed the runtime and set `OPENAI_API_KEY` had no `@ai-sdk/openai` on disk, so no model could be constructed.

That would be an ordinary missing-dependency papercut except for what sits at the bottom of the ladder. `ClaudeCodeAPIRunner` has **no read site for `options.messageHistory`** — the `CodingAgentRunner` → `ClaudeCodeRunner` → `ClaudeCodeAPIRunner` chain never reads it; only `AgentRunner`'s message assembly does. So an app with no provider package installed and `claude` on PATH was pinned to the one runner that drops conversation history, and nothing said so. It answered. It just had amnesia.

Measured in swe-brain on 2026-08-10: every reply to a stored thread produced *"I don't have a prior brief or message history to reference."* Installing `@ai-sdk/openai` and setting `AGENT_MODEL` fixed it outright — verified with a passphrase-recall control and monotonic input-token growth across the thread.

Doug's framing:

> agentic patterns should be packaging all of this. It should be enabling the single package of agentic patterns and allowing the calling application to pick the model it so chooses.
>
> We can start with just Google Gemini, Anthropic and OpenAI to begin with.

## Decision 1 — the three scoped providers ship as real `dependencies`

`@ai-sdk/anthropic`, `@ai-sdk/openai`, `@ai-sdk/google` are declared in `dependencies` of `@agentic-patterns/runtime`. Setting any of `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GOOGLE_GENERATIVE_AI_API_KEY` reaches `AgentRunner` with nothing installed beyond the runtime.

**Why this and not the alternatives.**

| Option | Verdict | Reasoning |
|---|---|---|
| **Real `dependencies` (chosen)** | ✅ | Delivers the asked-for contract literally: one package, name a model, go. Install weight is near-zero (below). Precedent already exists in this package — `ollama-ai-provider-v2`, `ai`, `@anthropic-ai/claude-agent-sdk`, `@modelcontextprotocol/sdk` are all real dependencies. |
| Optional `peerDependencies` + a loud preflight | ❌ as the packaging answer | An optional peer is *absent by default*. It converts silent amnesia into a legible error, which is necessary — but it does not make the thing work, and the ask was that it work. We took its preflight anyway (Decision 3): the two are orthogonal, and every argument for the preflight survives bundling. |
| A `@agentic-patterns/providers` companion package | ❌ | Still a second package to discover — the exact failure mode of the report, moved one hop. It also creates a version-skew surface (runtime ↔ providers) for no gain, since the three packages are thin. |
| Document it | ❌ | Leaves a trap whose symptom is a *plausible wrong answer*, not an error. Documentation does not defend against that. |

**Install weight is not the objection it looks like.** All three packages depend on exactly `@ai-sdk/provider@4.0.7` and `@ai-sdk/provider-utils@5.0.25` — both already direct dependencies of the runtime. They add no transitive tree, only three small provider modules. Nothing is imported at module load: `createRunner` still reaches them through `await import()`, so a consumer who never touches Gemini never evaluates `@ai-sdk/google`.

**Version pinning is a real, accepted cost.** Bundling pins the provider major for every consumer (`^4.0.0` today). A consumer needing a different major must override it. Accepted: the three move in lockstep with `ai@7`, and `options.model` remains a total escape hatch — pass your own constructed model and the runtime never loads a provider at all.

**The other six providers stay unbundled.** `groq`, `mistral`, `xai`, `deepseek`, `openrouter` remain dynamic-import-only and name their package when they can't be loaded. `ollama` was already a real dependency and is now labelled as such. Reassessing the list is a follow-up, not a blocker.

## Decision 2 — `bundled` is a declared, tested property, not a comment

`ProviderProtocol` gains `packageName` (the npm package `load()` imports) and `bundled` (whether the runtime ships it). `providers/__tests__/bundled-providers.test.ts` asserts both directions against the real `package.json`: every `bundled: true` provider is in `dependencies`, and no `bundled: false` provider secretly is. A devDependency — the state `@ai-sdk/anthropic` was in, which made workspace tests pass while every published consumer got nothing — now fails CI.

This is a **type-level breaking change** for anyone implementing `ProviderProtocol` outside this repo (two new required fields). Judged acceptable: the interface is a registry adapter shape, not a consumer-facing one, and the error copy depends on `packageName` being present rather than re-derived.

## Decision 3 — a present credential with an unloadable package fails loudly, always

Every `provider.load()` call in `createRunner` goes through `loadProviderModel()`, which converts any load failure into an error naming: the credential that selected the provider, the provider, the package, the fix (reinstall for a bundled package, install for an unbundled one), and — the sentence that would have saved the debugging cycle — that `ClaudeCodeAPIRunner` does not carry `messageHistory`.

The principle: **a present credential is a statement of intent.** It means the caller wanted `AgentRunner`. Serving a lesser runner instead of an error is answering a question the caller didn't ask. So the ladder does not continue past a failed load.

## Decision 4 — the `claude` CLI rung stops lying

The old `reason` read:

> using ClaudeCodeAPIRunner (claude CLI on PATH) — limited event vocabulary; set ANTHROPIC_API_KEY for AgentRunner with full events

In the reported failure the key **was** set and the package was missing, so the advice was not merely incomplete — it pointed at something already done. It also omitted the consequence that mattered most.

The rung is now reachable only when no provider credential was found at all (Decision 3 guarantees the other case throws), and its `reason` says so, states the history-loss consequence, and lists every env var that works on a stock install — derived from `BUNDLED_PROVIDER_ENV_VARS`, so it cannot recommend a provider the runtime does not ship.

It also calls out provider env vars that are **defined but empty**. `OPENAI_API_KEY=` in a `.env` is falsy, so detection skips it exactly as if it were unset — a second silent skip, indistinguishable from "I configured nothing".

## Decision 5 — `PROVIDER_PRIORITY` order is pinned by test

Shipping three real provider dependencies changes what a bare `createRunner()` picks when several keys are present: all three rungs are now genuinely reachable, where before only an installed one was. The documented order (`anthropic → openai → google → … → ollama`) is therefore observable behaviour for ordinary consumers, and is pinned in `runner/__tests__/create-runner.test.ts` rather than asserted in a comment.

## Consequences

- A consumer installs `@agentic-patterns/runtime`, sets one key, names a model, and reaches `AgentRunner` with full events and `messageHistory`. This is asserted by unstubbed tests that load the real packages offline.
- Provider majors for the three are pinned by the runtime; `options.model` is the escape hatch.
- `ap init` still writes the matching provider package into scaffolded projects. Redundant now, harmless, and it keeps generated projects explicit about their provider. Removing it is a follow-up.

## Follow-ups

- Re-assess whether `groq` / `mistral` / `xai` / `deepseek` / `openrouter` should join the bundle, or whether the current five-unbundled split is the stable answer.
- `ClaudeCodeAPIRunner` still ignores `options.messageHistory`. This ADR makes that legible; it does not fix it. Deciding whether that runner should carry history — or should refuse a run that passes history it cannot honour — is its own issue.

---
title: "Gateway routing"
description: "Route every agent's declared model through one OpenAI-compatible gateway: the AP_GATEWAY_* variables, resolver mode, Bifrost virtual keys and guardrails, and the caveats."
sidebar:
  label: "Gateway routing"
---

Setting one environment variable routes every agent in a project through a single
OpenAI-compatible gateway — Bifrost, LiteLLM, vLLM, anything that speaks the protocol:

```sh
AP_GATEWAY_BASE_URL=https://gateway.internal/v1
```

No code change, no per-provider key. This page is the operational reference. The reasoning
behind the selection ladder lives in [Runner & provider strategy](../runners.md); the
packaging decision is [ADR 0010](../adr/0010-bundled-provider-packages.md).

## Why this matters for ambient agents

On the direct-key path, `createRunner()` binds **one** model up front and `AgentRunner`
uses it regardless of what an agent declares. That is fine when a human is driving one
agent. It is a problem for an ambient fleet: every scheduled agent runs on whatever
`AGENT_MODEL` says, and the model recorded on the run row may not be the model that
actually answered.

**With a gateway configured, this inverts.** Gateway config triggers *resolver mode*, which
resolves **each agent's own declared model** per run. Declared equals used, and the run row
tells the truth.

The trade comes with two edges, both worth knowing before you flip it:

- **`tier`/`modelId` are ignored on this path.** The gateway receives whatever each agent
  declares (optionally prefixed). `AGENT_MODEL` stops being the lever.
- **An agent with no declared model fails loud** under a gateway. There is nothing to
  resolve. That is better than the alternative, but it will surface every unpinned agent
  in your project at once.

Precedence between an explicit override and gateway resolution is still open —
[#243](https://github.com/pattern-stack/agentic-patterns-ts/issues/243).

## The variables

| Variable | Purpose |
|---|---|
| `AP_GATEWAY_BASE_URL` | **Required.** The gateway endpoint. Setting it is what enables everything else. |
| `AP_GATEWAY_API_KEY` | Bearer token — sent as `Authorization: Bearer` |
| `AP_GATEWAY_BASIC_USER` + `AP_GATEWAY_BASIC_PASS` | HTTP Basic auth, sent as a precomputed `Authorization: Basic <base64>`. Use this **or** `AP_GATEWAY_API_KEY`, not both |
| `AP_GATEWAY_MODEL_PREFIX` | Qualifies declared ids into the gateway's namespace. A literal prefix (`anthropic/`), or `auto` to derive `«vendor»/«model»` per id |
| `AP_GATEWAY_TIER_PROVIDER` | Whose tier map turns `haiku`/`sonnet`/`opus` into a real id. Defaults to `anthropic`. A typo throws rather than silently picking a real-but-unintended model |
| `AP_GATEWAY_STRUCTURED_OUTPUTS` | `1`/`true`/`yes` → the gateway forwards json-schema structured outputs |
| `AP_GATEWAY_VIRTUAL_KEY` | Bifrost governance — sent as `x-bf-vk`. **Governed instances 401 without it** |
| `AP_GATEWAY_GUARDRAIL_IDS` | Comma-separated guardrail profile ids → `x-bf-guardrail-ids` |

`ap config` and `ap config set` cover these alongside the provider keys, so gateway setup
has a persistent surface rather than living only in your shell.

### Auth, three ways, and they are not alternatives

This trips people up. There are two *transport* auth forms and one *governance* header:

- `Authorization: Bearer` (from `AP_GATEWAY_API_KEY`) — or —
- `Authorization: Basic` (from `AP_GATEWAY_BASIC_USER` + `AP_GATEWAY_BASIC_PASS`)
- **plus**, orthogonally, `x-bf-vk` (from `AP_GATEWAY_VIRTUAL_KEY`)

A governed Bifrost behind an HTTP Basic proxy needs Basic **and** a virtual key. Both are
sent. The library does not auto-map a virtual key into `Authorization` — `x-bf-vk` is the
canonical header, and `Authorization` stays free for the fronting proxy.

## Resolution order

Resolver mode resolves each declared id in this order:

1. **Profile** — an in-code `ModelProfiles` entry or a `models.yaml` row
2. **Gateway** — route the declared id (optionally prefixed) at the gateway
3. **Pattern-matched family** — infer the provider from the id's shape
4. **Error** — nothing matched, and it says so

## Bifrost governance

Two Bifrost-specific behaviors surface as first-class events rather than opaque failures.

**Guardrail violations** — a configured guardrail blocked the request. Emitted as
`agent.guardrail.violation` *before* the enriched `agent.error`, carrying `guardrailId`,
`category`, `severity`, and a `message` that prefers a structured summary over the
provider's free-text prose (that free text is not guaranteed redaction-safe).

**Redactions** — Presidio-style PII redaction detected on a response, emitted as
`agent.guardrail.redaction` with **entity-type counts only, never raw values**.

One caveat on counting redaction events: they fire once per *scan boundary*, and the
boundary differs by entrypoint. `run()` scans after every LLM call, so a multi-iteration
tool loop can emit several per run. `stream()` scans the full accumulated text once before
`message.complete`. `runStructured()` scans the finalized output once, post-validation. Do
not assume one redaction event equals one LLM response.

Both register in the UX and DEBUG event profiles; violations also reach OBSERVABILITY via
the enriched `agent.error`. See the [SSE event reference](../reference/events.md).

## Packaging

The gateway path needs `@ai-sdk/openai-compatible`. It ships as a real dependency of
`@agentic-patterns/runtime` as of **0.40.0** — before that it was a devDependency, so
workspace tests passed while consumers setting `AP_GATEWAY_BASE_URL` hit:

```
ModelResolver: gateway routing (openai-compatible) needs the optional
package "@ai-sdk/openai-compatible".
```

The recommended configuration was the one that did not work out of the box. It is fixed,
and the failure was at least loud and named the package — which is exactly the behavior
[ADR 0010](../adr/0010-bundled-provider-packages.md) introduced, and why it cost minutes
rather than the silent multi-turn history loss the same class of bug caused on the direct
provider path.

If you are pinned below 0.40.0, `bun add @ai-sdk/openai-compatible` is the workaround.

## Operational notes

- **The base path matters.** Bifrost's API is at `/v1`. Point at the wrong path and a SPA
  may serve HTML for unknown routes, so a misconfigured base URL fails confusingly rather
  than 404ing.
- **Check the catalog before assuming a model exists.** Gateways differ — two deployments
  of the same product can carry entirely different model sets, and an agent declaring a
  model the gateway lacks fails on its first run. List the models the virtual key actually
  grants before wiring a fleet to it.
- **A 429 from an upstream vendor is not a gateway error.** Exhausted credits on the
  vendor's side surface through the gateway as an upstream status; the gateway, its auth,
  and the virtual key can all be working correctly.
- **An env var set to the empty string is falsy** and detected as unset — a papercut worth
  knowing when a credential "is set" but nothing picks it up.

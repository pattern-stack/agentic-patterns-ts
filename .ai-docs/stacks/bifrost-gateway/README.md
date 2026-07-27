# Stack — bifrost-gateway

Native-Bifrost affordances on the existing OpenAI-compatible gateway path
(`providers/model-resolver.ts` `GatewayConfig` / `buildFromGateway`).

**Scope (deliberate):** injection + awareness ONLY — not the full native-Bifrost
feature set (no Bifrost SDK, no model-catalog discovery, no admin API, no
redaction-reveal UI).

| Issue | Title | Direction |
|---|---|---|
| [#406](https://github.com/pattern-stack/agentic-patterns-ts/issues/406) | Bifrost gateway injection: virtual keys, guardrail selection, run correlation | request-side (headers out) |
| [#407](https://github.com/pattern-stack/agentic-patterns-ts/issues/407) | Bifrost gateway awareness (part 2) | response-side (metadata back) |

#406 blocks #407. Ground truth for wire shapes: live probes of the user's
Bifrost instance captured 2026-07-27 in the #406 issue body — authoritative
over Bifrost docs where they disagree.

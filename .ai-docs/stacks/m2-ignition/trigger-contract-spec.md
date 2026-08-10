# M2 · Framework-tier trigger contract — spec draft (pre-review)

> Status: DRAFT — awaiting shape review (the one thing #437's brief says to escalate).
> Arc: M2 Ignition (#437, program #414). Prototype evidence: sdlc-patterns#360/#361
> (swe-brain ignition wire — `agent.run` capability → durable `agent-run` job →
> `RunAgentUseCase.runTriggered`, provenance in `agent_runs.run_context`).

## The contract in one line

**named agent + input + trigger source → run** — the seam M3's `AgencyHost.runFromTrigger()`
formalizes; designed so AgencyHost *wraps* it, never replaces it.

## What the survey established (file:line in the full map)

- Nothing trigger-shaped exists in any package. Three parallel agent-identity notions
  (CLI `DiscoveredAgent.id`, server `AgentRegistration.id`, runner `role.name`) and the
  runtime layer has none of them — `RunRow.agentName` stores the role name, so a run
  cannot be joined back to `dealbrain/pm`.
- The de-facto run-started event is `agent.message.start`; nothing anywhere records *why*
  a run happened.
- `POST /eval/runs` starts runs by skipping `instantiate` + scope — the #268 bug class.
  The trigger path must not copy it.
- AP-29 F1: `RunOptions.runId` exists but only `NodeBackedRunner` honors it; `AgentRunner`
  mints its own — hosts can't pre-correlate a run.

## Proposed pieces (layer-law-clean)

### 1. `TriggerSource` — core, `src/atoms/` (L0)

Frozen, Zod-validated, `toPrompt()`-bearing. Core because an agent may legitimately
*know* what woke it (Awareness/render territory — same precedent as `SessionScope`
living in core while only hosts parse it).

```ts
TriggerSourceSchema = z.object({
  kind: z.enum(['schedule', 'webhook', 'message', 'manual', 'agent', 'system']),
  sourceId: z.string().optional(),      // schedule row id, webhook delivery id…
  label: z.string().optional(),         // 'morning-brief', '#eng-alerts' — prompt-safe
  firedAt: z.string().datetime(),
  correlationId: z.string().optional(), // host join key (job_run id, delivery id)
  summary: z.string().optional(),       // small prompt-safe excerpt, NEVER the event body
})
```

App-level notions (directive ids, slot, schedule name) ride `sourceId`/`label`/host
metadata — the framework enum stays transport-shaped, not app-shaped. (swe-brain's
`TriggerOrigin` maps on: `kind:'schedule'|'event'` → `'schedule'|'message'/'webhook'`,
directive identity → `sourceId`+`label`.)

### 2. Runtime plumbing — additive, no migrations

- `RunOptions.trigger?: TriggerSource` (same posture as `host`/`publishArtifacts`).
- Runner copies it onto `MessageStartEvent.trigger?` (additive optional, mirrors
  `agentConfig?`); `RunStoreExporter` stamps it into `RunMeta.metadata.trigger` — the bag
  documented for exactly this.
- **F1 fix riding along:** `AgentRunner` honors a caller-provided `RunOptions.runId`
  (NodeBackedRunner already does) — hosts pre-correlate runs with their own job ids.

### 3. `AgentRegistry` protocol — runtime, `src/runtime/` (L9)

The missing home for "named agent" below server/CLI. Structural, duck-typed (the
dist-boundary lesson):

```ts
interface AgentRef { id: string; name: string; description?: string }
interface AgentRegistry {
  list(): AgentRef[];
  resolve(id: string, scope?: Record<string, unknown>): Promise<AgentLike>;
  // resolve = find + scope.parse + instantiate — the ADR-0004 seam, NOT reg.agent
}
```

Server `AgentRegistration[]` and CLI `DiscoveredAgent[]` become thin adapters
(follow-up, not this arc). `RunMeta` gains `agentId` alongside `agentName` so runs
finally join back to registrations.

### 4. `runFromTrigger()` — runtime, `src/runtime/` (L9)

```ts
runFromTrigger(opts: {
  registry: AgentRegistry;
  runner: RunnerProtocol;
  agentId: string;
  input: string;                       // v1: string; typed-in via Node targets later
  trigger: TriggerSource;
  scope?: Record<string, unknown>;
  runId?: string;                      // host correlation (F1)
  eventBus?: AgentEventBus;
  signal?: AbortSignal;
}): Promise<{ runId: string; result: RunResult }>
```

Guarantees: resolves through the registry (instantiate + scope.parse + `buildScopeHost`
— never the eval shortcut), stamps `trigger` + `runId` into RunOptions, returns the
correlatable run. M3's AgencyHost holds a registry + runner and exposes this as a
method; the free function is the contract.

Deliberately NOT in scope: conversation continuity across triggers (needs scope
persistence + rehydration — M3), queue/reject policy for busy conversations (M3,
`AgentNode`'s queue is the prior art), server route (thin `POST /agents/:id/runs`
can come with M3/M4 ingress).

## PR slicing (agentic-patterns-ts, off main, bottom-up)

1. core: `TriggerSource` atom + tests.
2. runtime: `RunOptions.trigger` → `MessageStartEvent.trigger` → run-store stamp; AgentRunner honors caller `runId`.
3. runtime: `AgentRegistry` protocol + `runFromTrigger()` + MockRunner-backed tests.

## Open shape questions (for Doug)

1. `kind` vocabulary — is `'message'` distinct from `'webhook'` worth having from day 1
   (Slack DM vs raw webhook), or collapse to `'webhook'` until M4 channels?
2. `TriggerSource` as atom (renders via `toPrompt`, injectable into Awareness) vs
   molecule (pure data, never renders). I propose **atom** — "you were woken by the
   09:00 morning-brief schedule" is exactly ambient-agent Awareness.
3. Does `runFromTrigger` land in M2 (my recommendation — #437 lists the contract as an
   M2 checkbox, and the function is small) or do only pieces 1–2 land now, with the
   function deferred to M3's AgencyHost?

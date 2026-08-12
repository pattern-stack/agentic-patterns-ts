/**
 * Executable twin for `docs/ambient/*` — proves every code fence on the ambient
 * pages against the real packages.
 *
 * This exists because of the docs truth gate (see
 * `.claude/skills/docs-management/SKILL.md`, gate 3): any executable block in a
 * doc must be proven against the built packages before it is committed. Keeping
 * the twin here rather than in a throwaway script means it stays re-runnable —
 * and it is the natural input for automated fence checking (#457 slice 3).
 *
 * No API key required: it runs on `MockRunner`, so the assertions are about the
 * framework's seams, not about model behavior.
 *
 * Usage: bun run examples/ambient-trigger.ts
 */

import {
  type Agent,
  AgentBuilder,
  Awareness,
  Mission,
  Persona,
  RoleBuilder,
  TriggerSource,
  type TriggerSourceData,
} from "@agentic-patterns/core";
import {
  type AgentLike,
  type AgentRef,
  type AgentRegistry,
  Conversation,
  type Exchange,
  InMemoryConversationStore,
  MockRunner,
  type RunOptions,
  type RunnerProtocol,
  runFromTrigger,
} from "@agentic-patterns/runtime";

/**
 * Records the `RunOptions` each call was made with.
 *
 * Needed because `MockRunner`'s own `callHistory` (`MockCall`) captures only
 * `message`/`agentName`/`model`/`maxIterations` — it cannot observe
 * `trigger`, `runId`, or `messageHistory`, so a host cannot unit-test that it
 * wired the #437 trigger contract through. Filed as a follow-up; until then a
 * wrapper is how you assert on it.
 */
function recordingRunner(inner: RunnerProtocol): RunnerProtocol & {
  readonly optionsSeen: RunOptions[];
} {
  const optionsSeen: RunOptions[] = [];
  return new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === "optionsSeen") return optionsSeen;
      if (prop === "run" || prop === "stream" || prop === "runStructured") {
        const original = Reflect.get(target, prop, receiver) as (...args: unknown[]) => unknown;
        return (...args: unknown[]) => {
          optionsSeen.push((args[2] ?? {}) as RunOptions);
          return original.apply(target, args);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as RunnerProtocol & { readonly optionsSeen: RunOptions[] };
}

// ---------------------------------------------------------------------------
// A tiny agent to resolve. Prose-only — no capabilities, so it runs tool-less.
// ---------------------------------------------------------------------------

function buildBriefAgent(): Agent {
  const role = new RoleBuilder("morning-brief")
    .withPersona(
      new Persona({
        identity: "An operations analyst who writes short overnight summaries",
        tone: "concise",
      }),
    )
    .build();

  return new AgentBuilder(role)
    .withMission(new Mission({ objective: "Summarize what changed overnight" }))
    .withModel("claude-haiku-4-5-20251001")
    .build();
}

/**
 * docs/ambient/triggers.md § "Making the agent aware of its trigger".
 *
 * The runtime never renders the trigger, and `registry.resolve(id, scope)` does
 * not receive it — so a trigger-aware composition needs a registry that closes
 * over the firing.
 */
function triggerAware(base: AgentRegistry, trigger: TriggerSourceData): AgentRegistry {
  return {
    list: () => base.list(),
    resolve: async (id, scope) => {
      const agent = (await base.resolve(id, scope)) as Agent;
      return new AgentBuilder(agent.role)
        .withBackground(agent.background)
        .withMission(agent.mission)
        .withAwareness(
          new Awareness({
            domains: [
              {
                name: "Trigger",
                description: new TriggerSource(trigger).toPrompt(),
                accessMethod: "provided at ignition",
              },
            ],
          }),
        )
        .build();
    },
  };
}

// ---------------------------------------------------------------------------
// docs/ambient/triggers.md § "Adapting an existing store"
// ---------------------------------------------------------------------------

class DemoRegistry implements AgentRegistry {
  constructor(private readonly rows: Array<{ id: string; name: string }>) {}

  list(): readonly AgentRef[] {
    return this.rows.map((r) => ({ id: r.id, name: r.name }));
  }

  async resolve(id: string, _scope?: Record<string, unknown>): Promise<AgentLike> {
    const row = this.rows.find((r) => r.id === id);
    // Reject unknown ids — an ambient caller has no user to show a 404 to.
    if (!row) throw new Error(`Unknown agent: ${id}`);
    return buildBriefAgent();
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

async function main(): Promise<void> {
  // -------------------------------------------------------------------------
  // 1. TriggerSource — docs/ambient/triggers.md § "TriggerSource"
  // -------------------------------------------------------------------------
  const jobRunId = "job_0001";
  const firedAt = "2026-08-12T09:00:00Z";

  // The seams take plain `TriggerSourceData` and validate it themselves; the
  // class is for validating at your own boundary, and for rendering.
  const trigger = {
    kind: "schedule",
    sourceId: "sched_01HQ",
    label: "morning-brief",
    firedAt,
    correlationId: jobRunId,
    summary: "Weekday cadence, 09:00 America/New_York",
  } satisfies TriggerSourceData;

  const rendered = new TriggerSource(trigger).toPrompt();
  console.log(`[1] TriggerSource.toPrompt():\n${rendered}\n`);
  assert(
    rendered.startsWith("This run was started by a schedule ('morning-brief') at"),
    "trigger prompt line matches the docs",
  );
  assert(rendered.includes("Weekday cadence"), "summary renders on its own line");

  // -------------------------------------------------------------------------
  // 2. runFromTrigger — docs/ambient/index.md § "The one function"
  // -------------------------------------------------------------------------
  const registry = new DemoRegistry([{ id: "ops/morning-brief", name: "Morning brief" }]);
  const runner = recordingRunner(
    new MockRunner().addResponse("*", { content: "Two deploys, no incidents." }),
  );

  const handle = await runFromTrigger(
    { registry, runner },
    {
      agentId: "ops/morning-brief",
      input: "Summarize what changed overnight.",
      trigger,
      runId: jobRunId,
    },
  );

  console.log(`[2] runId=${handle.runId} agentId=${handle.agentId}`);
  console.log(`    response=${handle.result.response}\n`);
  assert(handle.runId === jobRunId, "caller-supplied runId is honored (pre-correlation)");
  assert(handle.agentId === "ops/morning-brief", "handle names the agent that ran");

  // The trigger reaches the runner verbatim on RunOptions.
  const opts = runner.optionsSeen[0];
  assert(opts !== undefined, "the runner was actually called");
  assert(opts.trigger?.label === "morning-brief", "trigger rides RunOptions.trigger");
  assert(opts.trigger?.kind === "schedule", "trigger kind survives the seam");
  assert(opts.runId === jobRunId, "runId rides RunOptions.runId");

  // -------------------------------------------------------------------------
  // 3. Validation at the seam — docs/ambient/triggers.md § "The guarantees"
  // -------------------------------------------------------------------------
  let rejected = false;
  try {
    await runFromTrigger(
      { registry, runner },
      {
        agentId: "ops/morning-brief",
        input: "…",
        // `kind` is not in TRIGGER_KINDS and firedAt is not a datetime.
        trigger: { kind: "cron", firedAt: "yesterday" } as never,
      },
    );
  } catch {
    rejected = true;
  }
  console.log(`[3] malformed trigger rejected at entry: ${rejected}\n`);
  assert(rejected, "a malformed trigger fails loud at the seam, not three layers down");

  // -------------------------------------------------------------------------
  // 3b. Trigger-aware composition — docs/ambient/triggers.md
  //     The runtime does NOT render the trigger; a host that wants the agent to
  //     know what woke it wraps the registry.
  // -------------------------------------------------------------------------
  const plain = await registry.resolve("ops/morning-brief");
  assert(
    !(plain as Agent).renderInitialPrompt().includes("morning-brief"),
    "baseline: the trigger does NOT reach the prompt on its own",
  );

  const aware = await triggerAware(registry, trigger).resolve("ops/morning-brief");
  const awarePrompt = (aware as Agent).renderInitialPrompt();
  console.log(
    `[3b] trigger-aware prompt mentions the trigger: ${awarePrompt.includes("morning-brief")}\n`,
  );
  assert(
    awarePrompt.includes("This run was started by a schedule ('morning-brief')"),
    "the documented wrapper puts the trigger line in the system prompt",
  );

  // Unknown agent ids are rejected too.
  let unknownRejected = false;
  try {
    await runFromTrigger({ registry, runner }, { agentId: "ops/nope", input: "…", trigger });
  } catch {
    unknownRejected = true;
  }
  assert(unknownRejected, "unknown agent id rejects rather than silently no-opping");

  // -------------------------------------------------------------------------
  // 4. Conversation + rehydration — docs/ambient/conversations.md
  // -------------------------------------------------------------------------
  const store = new InMemoryConversationStore();
  const agent = buildBriefAgent();
  const chatRunner = recordingRunner(
    new MockRunner()
      .addResponse("passphrase", { content: "The passphrase is ZEBRA-7741." })
      .addResponse("*", { content: "Acknowledged." }),
  );

  const conversation = new Conversation(agent, chatRunner, { store });
  await conversation.send("Remember the passphrase ZEBRA-7741.");
  const second = await conversation.send("What was the passphrase?");

  console.log(
    `[4] exchanges=${conversation.exchangeCount} tokens=${conversation.totalTokens.total}`,
  );
  assert(conversation.exchangeCount === 2, "both exchanges recorded");
  assert(second.assistant.includes("ZEBRA-7741"), "the second exchange answered");

  // Turn 2 carried turn 1 — this is the mechanism the docs describe.
  const secondOpts = chatRunner.optionsSeen[1];
  assert(secondOpts !== undefined, "second call happened");
  assert(
    (secondOpts.messageHistory?.length ?? 0) > 0,
    "send() builds messageHistory from prior exchanges",
  );

  // Seeding a NEW conversation with prior exchanges — the rehydration hook.
  const history: Exchange[] = conversation.history;
  const resumed = new Conversation(agent, chatRunner, { id: conversation.id, store, history });
  console.log(`    resumed with ${resumed.exchangeCount} prior exchanges\n`);
  assert(resumed.exchangeCount === 2, "history injection seeds a resumed conversation");

  const thirdCall = await resumed.send("Anything else?");
  assert(thirdCall.number === 3, "the resumed conversation continues the exchange count");

  console.log("All ambient doc fences verified.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

/**
 * broken-model — the permanent N5 canary.
 *
 * DELIBERATELY BROKEN. `.withModel("bogus-model-9000")` names a model id
 * that matches no known vendor prefix (claude, gpt, o1, o3, o4, gemini,
 * grok, deepseek, mistral) and has no registered profile, so under
 * the playground's default resolver mode (`resolveAgentModel: true`) every
 * turn hits `ModelResolver`'s unknown-id throw (`model-resolver.ts:299`)
 * BEFORE the runner yields a single event — the exact pre-token failure
 * window that N5 (#340) fixes on the wire:
 *
 *   conversation.start -> conversation.end{reason:"error"} -> error -> done
 *
 * This is a regression probe, not a mistake — do NOT "fix" the model id or
 * remove this agent. It is the Gate A manual repro and the R1 `contracttest`
 * canary for the four-frame torn-stream contract, and it stays permanently
 * visible in the playground picker on purpose (name + this header make its
 * purpose self-evident so nobody "fixes" it).
 *
 * Discovery: `ap playground examples` picks this up via the wrapper default
 * export ({ id, name, description, agent }), same shape as `support-desk`
 * and `scope-echo`.
 */

import { AgentBuilder, Mission, Persona, RoleBuilder } from "@agentic-patterns/core";

function buildBrokenModelAgent() {
  const role = new RoleBuilder("broken-model")
    .withPersona(
      new Persona({
        identity: "a deliberately misconfigured agent that never gets to speak",
        tone: "n/a — every turn fails before the first token",
        priorities: ["exist as a reliable pre-token model-resolution failure repro"],
      }),
    )
    .build();

  const mission = new Mission({
    objective: "Fail before the first token, every time, on purpose",
    successCriteria: ["Never resolves a model — proves the N5 error+done wire contract holds"],
  });

  return new AgentBuilder(role).withMission(mission).withModel("bogus-model-9000").build();
}

export default {
  id: "broken-model",
  name: "Broken Model (N5 canary)",
  description:
    "Deliberately broken — pre-token model-resolution failure canary for the N5 torn-stream contract. Do not fix.",
  agent: buildBrokenModelAgent(),
};

import { describe, expect, it } from "vitest";
import * as core from "../index.js";

/**
 * Public-surface guard for the protocol-layer removal (#490).
 *
 * `src/protocols/` was a project-tracker domain — sprints, tasks, tags,
 * reactions, users — sitting in the public API of an agent framework. It had
 * exactly one consumer in the repo: the core barrel re-exporting it. This test
 * exists so it cannot drift back in, and so a future addition to core's root
 * namespace has to be a deliberate act.
 */
describe("core public surface — the protocol layer stays gone (#490)", () => {
  // A representative slice, not the full 104: the ones a downstream
  // `import type` would most plausibly have named.
  const REMOVED = [
    "SprintSchema",
    "CreateSprintInputSchema",
    "TaskSchema",
    "ReactionSchema",
    "ProjectSchema",
    "UserSchema",
    "TeamSchema",
    "DocumentSchema",
    "TagSchema",
    "EnvironmentSchema",
    "PrioritySchema",
    "IssueTypeSchema",
    "ProtocolModel",
  ] as const;

  it.each(REMOVED)("no longer exports %s", (name) => {
    expect(core).not.toHaveProperty(name);
  });

  it("still exports the composition primitives the framework is actually about", () => {
    for (const name of ["Agent", "AgentBuilder", "RoleBuilder", "Persona", "Mission", "Toolbox"]) {
      expect(core).toHaveProperty(name);
    }
  });

  it("AgenticModel survives — only the ProtocolModel subclass was removed", () => {
    expect(core).toHaveProperty("AgenticModel");
  });
});

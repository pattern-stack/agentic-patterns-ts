/**
 * Pins the node → real-provenance mapping the inspector's Provenance tab uses.
 * Agent/sub-agent nodes take the role's (persona) chip; capability + tool nodes
 * take their capability's chip; a role without slots (a promoted pipeline) yields
 * an empty map (the tab falls back to the derived algebra).
 */
import { describe, expect, it } from "vitest";
import { type CompositionRole, buildProvenanceMap } from "../constellation/NodeInspector";
import type { ConstNode } from "../graph/constellation-model";

const node = (id: string, kind: ConstNode["data"]["kind"], capabilityName?: string): ConstNode =>
  ({
    id,
    type: kind,
    position: { x: 0, y: 0 },
    data: { kind, label: id, capabilityName },
  }) as ConstNode;

const ROLE: CompositionRole = {
  persona: { provenance: { tier: "preset", sourcePath: "presets/analyst.ts" } },
  capabilities: [
    { name: "query-surface", provenance: { tier: "builder", sourcePath: "roles/retrieval.ts" } },
  ],
};

describe("buildProvenanceMap", () => {
  it("keys agent → persona chip; capability + its tools → the capability chip", () => {
    const nodes = [
      node("agent", "agent"),
      node("cap:query-surface", "capability", "query-surface"),
      node("tool:query-surface:search", "tool", "query-surface"),
      node("tool:other:x", "tool", "other"), // no matching capability → absent
    ];
    const map = buildProvenanceMap(nodes, ROLE);
    expect(map.agent).toEqual({ tier: "preset", sourcePath: "presets/analyst.ts" });
    expect(map["cap:query-surface"]).toEqual({ tier: "builder", sourcePath: "roles/retrieval.ts" });
    expect(map["tool:query-surface:search"]).toEqual({
      tier: "builder",
      sourcePath: "roles/retrieval.ts",
    });
    expect(map["tool:other:x"]).toBeUndefined();
  });

  it("is empty for a role without slots (e.g. a promoted pipeline)", () => {
    expect(buildProvenanceMap([node("agent", "agent")], undefined)).toEqual({});
    expect(buildProvenanceMap([node("agent", "agent")], {})).toEqual({});
  });
});

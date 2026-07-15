/**
 * NodeInspector's I/O-tab "Scope context" section (#268) — run detail renders
 * `RunMeta.context` (the redacted effective context a run executed under,
 * sourced from `RunRow.metadata.context` by `RunSurfacePage`) plus a
 * redaction badge, but ONLY when the row actually carries the `context` key
 * — a live/demo/no-stamp run must never fabricate a "(no scope)" it has no
 * record for (see `RunMeta.context`'s doc comment).
 */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { NodeInspector } from "../constellation/NodeInspector";
import type { ConstNode } from "../graph/constellation-model";

const AGENT_NODE: ConstNode = {
  id: "agent",
  type: "agent",
  position: { x: 0, y: 0 },
  data: { kind: "agent", label: "agent" },
} as ConstNode;

describe("NodeInspector Scope context section (#268)", () => {
  afterEach(() => cleanup());

  it("renders the run's context + a redaction badge when the row carries both", () => {
    const { getByText, container } = render(
      <NodeInspector
        node={AGENT_NODE}
        steps={[]}
        runMeta={{
          context: { tenant: "acme", userId: "[redacted]" },
          contextRedacted: ["userId"],
        }}
        onClose={() => {}}
      />,
    );

    expect(getByText("Scope context")).toBeTruthy();
    expect(container.textContent).toContain('"tenant": "acme"');
    expect(container.textContent).toContain('"userId": "[redacted]"');
    expect(getByText("redacted: userId")).toBeTruthy();
  });

  it('renders the honest "(no scope)" for a hook-bearing run whose effective context resolved to null — not a blank/missing section', () => {
    const { getByText, queryByText } = render(
      <NodeInspector node={AGENT_NODE} steps={[]} runMeta={{ context: null }} onClose={() => {}} />,
    );

    expect(getByText("Scope context")).toBeTruthy();
    expect(getByText("(no scope)")).toBeTruthy();
    expect(queryByText(/redacted:/)).toBeNull();
  });

  it("omits the section entirely when the row carries no context key at all (live/demo/no-stamp runs)", () => {
    const { queryByText } = render(
      <NodeInspector
        node={AGENT_NODE}
        steps={[]}
        runMeta={{ request: "hi", answer: "hello" }}
        onClose={() => {}}
      />,
    );

    expect(queryByText("Scope context")).toBeNull();
  });
});

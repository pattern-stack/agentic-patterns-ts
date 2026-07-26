/**
 * Render artifacts (ADR-0006) — a `table` artifact renders a real DataTable;
 * an unknown `displayType` (or a `table` whose `data` fails the shape guard)
 * degrades to the existing JSON/CodeBlock fallback, never a crash; a ceiling
 * marker (`data` absent) renders an honest placeholder, never a partial or
 * fabricated table. Testing-library render, per `state-delta-parts.test.tsx`.
 */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { __resetMediaQueryCacheForTests } from "../../hooks/useMediaQuery";
import type { ChatArtifact } from "../model";
import type { Part } from "../model";
import { ArtifactBlock, PartView } from "../parts";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  __resetMediaQueryCacheForTests();
});

// PartView's `role` prop is the chat role, not an ARIA role.
const ROLE = "assistant" as const;

const renderPart = (part: Part) =>
  render(
    <div className="chat-root">
      <PartView part={part} role={ROLE} />
    </div>,
  );

/** Stubs matchMedia so `useBreakpoint` reports a phone viewport — pattern
 *  mirrors `TokensPage.responsive.test.tsx`'s `stubPhone()`. */
function stubPhone() {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: /max-width:\s*(639|899)px/.test(query),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }));
}

const tableArtifact: ChatArtifact = {
  id: "crm_table:abc",
  displayType: "table",
  title: "May deals",
  data: {
    columns: ["Name", "Amount"],
    rows: [
      ["Acme", 4200],
      ["Globex", 1800],
    ],
  },
};

describe("ArtifactBlock — table", () => {
  it("renders a real table with the given headers and cell text", () => {
    const { container } = render(<ArtifactBlock artifact={tableArtifact} />);
    const table = container.querySelector("table");
    expect(table).not.toBeNull();
    expect(container.textContent).toContain("Name");
    expect(container.textContent).toContain("Amount");
    expect(container.textContent).toContain("Acme");
    expect(container.textContent).toContain("4200");
    expect(container.textContent).toContain("May deals");
  });

  it("still renders without throwing on a phone viewport (delegates scroll fallback to DataTable)", () => {
    stubPhone();
    const { container } = render(<ArtifactBlock artifact={tableArtifact} />);
    expect(container.querySelector("table")).not.toBeNull();
  });

  it("shows the truncated chip when the producer flagged it", () => {
    const { container } = render(
      <ArtifactBlock artifact={{ ...tableArtifact, truncated: true }} />,
    );
    expect(container.querySelector(".artifact-chip")?.textContent).toBe("truncated");
  });

  it("omits the truncated chip when absent", () => {
    const { container } = render(<ArtifactBlock artifact={tableArtifact} />);
    expect(container.querySelector(".artifact-chip")).toBeNull();
  });
});

describe("ArtifactBlock — ceiling marker (data absent)", () => {
  it("renders an honest placeholder, never a table", () => {
    const marker: ChatArtifact = { id: "crm_table:big", displayType: "table", truncated: true };
    const { container } = render(<ArtifactBlock artifact={marker} />);
    expect(container.querySelector("table")).toBeNull();
    expect(container.querySelector(".artifact-placeholder")?.textContent).toBe(
      "table — too large to display",
    );
  });
});

describe("ArtifactBlock — unknown displayType", () => {
  it("degrades to the JSON fallback (CodeBlock), never crashes", () => {
    const chart: ChatArtifact = {
      id: "chart:1",
      displayType: "chart",
      data: { kind: "bar", values: [1, 2, 3] },
    };
    const { container } = render(<ArtifactBlock artifact={chart} />);
    expect(container.querySelector("table")).toBeNull();
    const code = container.querySelector(".chat-code");
    expect(code).not.toBeNull();
    expect(code?.textContent).toContain("bar");
  });
});

describe("ArtifactBlock — table displayType with malformed data", () => {
  it("degrades to the JSON fallback rather than crashing DataTable", () => {
    const malformed: ChatArtifact = {
      id: "crm_table:bad",
      displayType: "table",
      data: { columns: "not-an-array", rows: [] },
    };
    const { container } = render(<ArtifactBlock artifact={malformed} />);
    expect(container.querySelector("table")).toBeNull();
    expect(container.querySelector(".chat-code")).not.toBeNull();
  });
});

describe("PartView — standalone artifacts part (message.complete path)", () => {
  it("renders as a sibling of any tool card, not nested inside one", () => {
    const { container } = renderPart({ kind: "artifacts", items: [tableArtifact] });
    const wrap = container.querySelector(".chat-artifacts");
    expect(wrap).not.toBeNull();
    expect(wrap?.closest(".chat-tool")).toBeNull();
    expect(wrap?.querySelector("table")).not.toBeNull();
  });
});

describe("PartView — tool_call carrying artifacts", () => {
  it("renders the artifacts section inside the tool card", () => {
    const { container } = renderPart({
      kind: "tool_call",
      id: "t1",
      name: "listDeals",
      result: "23 deals",
      artifacts: [tableArtifact],
    });
    const card = container.querySelector(".chat-tool");
    expect(card).not.toBeNull();
    const wrap = card?.querySelector(".chat-artifacts");
    expect(wrap).not.toBeNull();
    expect(wrap?.querySelector("table")).not.toBeNull();
  });

  it("renders no artifacts section when the tool_call carries none", () => {
    const { container } = renderPart({
      kind: "tool_call",
      id: "t1",
      name: "listDeals",
      result: "ok",
    });
    expect(container.querySelector(".chat-artifacts")).toBeNull();
  });

  // A card carrying an artifact opens itself: leaving a table behind a
  // collapsed summary means the reader must already know it is there, which
  // defeats "inserted immediately" (ADR-0006).
  it("auto-expands a tool card that carries artifacts", () => {
    const { container } = renderPart({
      kind: "tool_call",
      id: "t1",
      name: "listDeals",
      result: "23 deals",
      artifacts: [tableArtifact],
    });
    expect(container.querySelector<HTMLDetailsElement>(".chat-tool")?.open).toBe(true);
  });

  it("leaves an ordinary tool card collapsed", () => {
    const { container } = renderPart({
      kind: "tool_call",
      id: "t1",
      name: "listDeals",
      result: "ok",
    });
    expect(container.querySelector<HTMLDetailsElement>(".chat-tool")?.open).toBe(false);
  });

  it("still opens an errored card that carries no artifacts", () => {
    const { container } = renderPart({
      kind: "tool_call",
      id: "t1",
      name: "listDeals",
      error: "boom",
    });
    expect(container.querySelector<HTMLDetailsElement>(".chat-tool")?.open).toBe(true);
  });
});

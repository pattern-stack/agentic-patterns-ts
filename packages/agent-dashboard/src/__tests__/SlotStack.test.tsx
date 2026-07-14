/**
 * SlotStack — a role's persona/judgment/responsibility/capability text is
 * markdown by construction (`toPrompt()` output: headings, bold, lists).
 * Regression coverage for the raw-`### Tone`-as-literal-text bug: markdown-
 * shaped text renders through the shared `Markdown` component, while plain
 * prose (no markdown markers) stays a plain, pre-wrapped text node.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { CapabilityBlock, Slot } from "../api/composition";
import { SlotStack } from "../components/organisms/SlotStack";

afterEach(cleanup);

const capability: CapabilityBlock = {
  name: "search",
  description: "Looks things up.",
  toolbox: { name: "search-toolbox", description: "", tools: [] },
  manual: null,
  playbook: null,
};

describe("SlotStack — markdown slot text", () => {
  it("renders markdown-shaped persona text as HTML, not literal syntax", () => {
    const persona: Slot = {
      name: "persona",
      text: "### Tone\n\nDirect and structured.\n\n**Heuristics:**\n- one\n- two",
    };
    render(<SlotStack persona={persona} judgments={[]} responsibilities={[]} capabilities={[]} />);
    expect(screen.getByRole("heading", { level: 4, name: "Tone" })).toBeTruthy();
    expect(screen.getByText("Heuristics:").tagName).toBe("STRONG");
    expect(screen.getAllByRole("listitem").map((li) => li.textContent)).toEqual(["one", "two"]);
    expect(screen.queryByText(/### Tone/)).toBeNull();
    expect(screen.queryByText(/\*\*Heuristics:\*\*/)).toBeNull();
  });

  it("leaves plain, non-markdown persona text as a plain text node", () => {
    const persona: Slot = { name: "persona", text: "Just a plain sentence, nothing fancy." };
    render(<SlotStack persona={persona} judgments={[]} responsibilities={[]} capabilities={[]} />);
    expect(screen.getByText("Just a plain sentence, nothing fancy.").tagName).toBe("DIV");
    expect(screen.queryByRole("heading")).toBeNull();
  });

  it("gates capability description the same way", () => {
    render(
      <SlotStack
        persona={{ name: "persona", text: "" }}
        judgments={[]}
        responsibilities={[]}
        capabilities={[{ ...capability, description: "## Purpose\n\nFinds stuff." }]}
      />,
    );
    expect(screen.getByRole("heading", { level: 3, name: "Purpose" })).toBeTruthy();
  });
});

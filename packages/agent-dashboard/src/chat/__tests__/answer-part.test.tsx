/**
 * Structured terminal answer (ADR-0006 §9) — a `{ kind: "answer" }` part
 * (substituted by `model.ts`'s `applyStructuredContent` for the raw-JSON text
 * part a structured terminal result used to render as). A plain object with
 * exactly one recognized prose key renders as markdown prose + a collapsed
 * disclosure for any remaining fields; anything else degrades to the
 * JSON/CodeBlock fallback, never a crash. Testing-library render, per
 * `render-artifacts.test.tsx`'s conventions.
 */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Part } from "../model";
import { PartView } from "../parts";

afterEach(() => {
  cleanup();
});

const ROLE = "assistant" as const;

const renderPart = (part: Part) =>
  render(
    <div className="chat-root">
      <PartView part={part} role={ROLE} />
    </div>,
  );

describe("AnswerPart — a single recognized prose key", () => {
  it("renders the prose string as markdown and discloses the remaining field", () => {
    const { container } = renderPart({
      kind: "answer",
      value: { answer: "We closed 23 deals.", ref: "crm_table:e891" },
    });
    expect(container.textContent).toContain("We closed 23 deals.");
    const details = container.querySelector("details.answer-fields");
    expect(details).not.toBeNull();
    expect(details?.querySelector(".chat-code")?.textContent).toContain("crm_table:e891");
    // The prose key itself must not leak into the disclosed remainder.
    expect(details?.querySelector(".chat-code")?.textContent).not.toContain("We closed 23 deals.");
  });

  it("omits the disclosure entirely when there are no remaining fields", () => {
    const { container } = renderPart({ kind: "answer", value: { answer: "Just this." } });
    expect(container.textContent).toContain("Just this.");
    expect(container.querySelector("details.answer-fields")).toBeNull();
  });

  it("linkifies [#N] cite chips inside the extracted prose", () => {
    const { container } = renderPart({
      kind: "answer",
      value: { answer: "See [#1] for details.", ref: "x" },
    });
    expect(container.querySelector(".cite")).not.toBeNull();
  });

  it("recognizes any of the well-known prose keys (text/response/message/summary)", () => {
    for (const key of ["text", "response", "message", "summary"] as const) {
      const { container, unmount } = renderPart({
        kind: "answer",
        value: { [key]: `prose via ${key}`, extra: 1 },
      });
      expect(container.textContent).toContain(`prose via ${key}`);
      expect(container.querySelector("details.answer-fields")).not.toBeNull();
      unmount();
    }
  });
});

describe("AnswerPart — falls back to JSON/CodeBlock", () => {
  it("no recognized prose key present", () => {
    const { container } = renderPart({ kind: "answer", value: { ref: "x", count: 3 } });
    expect(container.querySelector(".chat-code")).not.toBeNull();
    expect(container.textContent).toContain("ref");
    expect(container.querySelector("details.answer-fields")).toBeNull();
  });

  it("more than one candidate prose key present — ambiguous, no guessing", () => {
    const { container } = renderPart({
      kind: "answer",
      value: { answer: "a", summary: "b" },
    });
    const code = container.querySelector(".chat-code");
    expect(code).not.toBeNull();
    expect(code?.textContent).toContain("a");
    expect(code?.textContent).toContain("b");
  });

  it("a prose key present but with a non-string value", () => {
    const { container } = renderPart({ kind: "answer", value: { answer: 42 } });
    const code = container.querySelector(".chat-code");
    expect(code).not.toBeNull();
    expect(code?.textContent).toContain("42");
  });

  it("a non-object value (string) never crashes", () => {
    const { container } = renderPart({ kind: "answer", value: "just a string" });
    expect(container.querySelector(".chat-code")?.textContent).toContain("just a string");
  });

  it("a non-object value (number) never crashes", () => {
    const { container } = renderPart({ kind: "answer", value: 42 });
    expect(container.querySelector(".chat-code")?.textContent).toContain("42");
  });

  it("a non-object value (null) never crashes and renders nothing fabricated", () => {
    const { container } = renderPart({ kind: "answer", value: null });
    expect(container.querySelector(".chat-code")).toBeNull();
  });

  it("an array value never crashes (arrays are not treated as prose-bearing objects)", () => {
    const { container } = renderPart({ kind: "answer", value: [1, 2, 3] });
    const code = container.querySelector(".chat-code");
    expect(code).not.toBeNull();
    expect(code?.textContent).toContain("1");
  });
});

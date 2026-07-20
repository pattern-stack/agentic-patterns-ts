/**
 * Shared eval cells (slice 4) — TwoLensCell det/judge pill semantics,
 * EvidenceText [evidence-N] highlighting (incl. the code-block exclusion),
 * BarCell magnitude bars, DeltaCell signed coloring.
 */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { BarCell } from "../pages/eval/components/BarCell";
import { DeltaCell } from "../pages/eval/components/DeltaCell";
import { EvidenceText } from "../pages/eval/components/EvidenceText";
import { TwoLensCell } from "../pages/eval/components/TwoLensCell";
import type { RunSummary } from "../pages/eval/families/types";

afterEach(cleanup);

describe("TwoLensCell", () => {
  it("renders det % plus a mean judge pill", () => {
    const summary: RunSummary = {
      detPassRate: 0.83,
      judgeLens: { kind: "mean", value: 0.84 },
    };
    render(<TwoLensCell summary={summary} />);
    expect(screen.getByText("det 83%")).toBeTruthy();
    expect(screen.getByText("judge 0.84")).toBeTruthy();
  });

  it("renders a ratio judge pill as num/den", () => {
    const summary: RunSummary = {
      detPassRate: 1,
      judgeLens: { kind: "ratio", value: 0.8, num: 12, den: 15 },
    };
    render(<TwoLensCell summary={summary} />);
    expect(screen.getByText("judge 12/15")).toBeTruthy();
  });

  it("omits the judge pill entirely when judgeLens is absent (det-only state)", () => {
    render(<TwoLensCell summary={{ detPassRate: 0.5 }} />);
    expect(screen.getByText("det 50%")).toBeTruthy();
    expect(screen.queryByText(/judge/)).toBeNull();
  });

  it("falls back to the detPassRate prop when there is no summary", () => {
    render(<TwoLensCell detPassRate={0.25} />);
    expect(screen.getByText("det 25%")).toBeTruthy();
  });

  it("still shows the det pill (as unknown) with no data at all", () => {
    render(<TwoLensCell />);
    expect(screen.getByText("det —")).toBeTruthy();
    expect(screen.queryByText(/judge/)).toBeNull();
  });
});

describe("EvidenceText", () => {
  it("renders markdown and wraps [evidence-N] markers with class + title", () => {
    const { container } = render(
      <EvidenceText content={"**Bold claim** backed by [evidence-2] and [evidence-10]."} />,
    );
    expect(container.querySelector("strong")).toBeTruthy();
    const marks = container.querySelectorAll("mark.evidence-marker");
    expect(marks.length).toBe(2);
    expect(marks[0]?.getAttribute("title")).toBe("Evidence 2");
    expect(marks[0]?.textContent).toBe("[evidence-2]");
    expect(marks[1]?.getAttribute("title")).toBe("Evidence 10");
  });

  it("leaves markers inside fenced and inline code un-highlighted", () => {
    const content = [
      "```",
      "[evidence-1]",
      "```",
      "",
      "Inline `[evidence-3]` stays raw, but [evidence-4] is wrapped.",
    ].join("\n");
    const { container } = render(<EvidenceText content={content} />);
    const marks = container.querySelectorAll("mark.evidence-marker");
    expect(marks.length).toBe(1);
    expect(marks[0]?.textContent).toBe("[evidence-4]");
    expect(container.querySelector("pre code")?.textContent).toContain("[evidence-1]");
  });

  it("renders plain text without markers unchanged", () => {
    const { container } = render(<EvidenceText content={"No markers here."} />);
    expect(container.querySelectorAll("mark.evidence-marker").length).toBe(0);
    expect(screen.getByText("No markers here.")).toBeTruthy();
  });
});

describe("BarCell", () => {
  it("renders a proportional fill plus the formatted value", () => {
    const { container } = render(<BarCell value={0.5} />);
    expect(screen.getByText("0.50")).toBeTruthy();
    expect(container.querySelector('span[style*="50%"]')).toBeTruthy();
  });

  it("normalizes against max while showing the raw value", () => {
    const { container } = render(<BarCell value={3} max={4} />);
    expect(screen.getByText("3")).toBeTruthy();
    expect(container.querySelector('span[style*="75%"]')).toBeTruthy();
  });

  it("shows an em dash and no fill for null", () => {
    const { container } = render(<BarCell value={null} />);
    expect(screen.getByText("—")).toBeTruthy();
    expect(container.querySelector('span[style*="%"]')).toBeNull();
  });
});

describe("DeltaCell", () => {
  it("colors a positive delta green with an up glyph (higherIsBetter default)", () => {
    render(<DeltaCell value={0.12} />);
    const el = screen.getByText("▲ +0.12");
    expect((el as HTMLElement).style.color).toBe("var(--green)");
    expect(el.getAttribute("title")).toBe("improvement");
  });

  it("colors a negative delta red with a down glyph", () => {
    render(<DeltaCell value={-0.12} />);
    const el = screen.getByText("▼ -0.12");
    expect((el as HTMLElement).style.color).toBe("var(--red)");
    expect(el.getAttribute("title")).toBe("regression");
  });

  it("flips semantics when higherIsBetter is false", () => {
    render(<DeltaCell value={0.12} higherIsBetter={false} />);
    const el = screen.getByText("▲ +0.12");
    expect((el as HTMLElement).style.color).toBe("var(--red)");
    expect(el.getAttribute("title")).toBe("regression");
  });

  it("is neutral (muted, glyph-free) at ~0 and for null", () => {
    render(<DeltaCell value={0} />);
    const zero = screen.getByText("0.00");
    expect((zero as HTMLElement).style.color).toBe("var(--fg-muted)");
    expect(zero.getAttribute("title")).toBe("no change");
    cleanup();
    render(<DeltaCell value={null} />);
    expect((screen.getByText("—") as HTMLElement).style.color).toBe("var(--fg-muted)");
  });

  it("respects a custom formatValue", () => {
    render(<DeltaCell value={0.031} formatValue={(v) => `${(v * 100).toFixed(1)}pp`} />);
    expect(screen.getByText("▲ 3.1pp")).toBeTruthy();
  });
});

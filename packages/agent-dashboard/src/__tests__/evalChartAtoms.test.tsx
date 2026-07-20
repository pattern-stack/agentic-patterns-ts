/**
 * Chart atoms (slice 4) — Histogram / ScatterPlot / MeterCell render with
 * realistic props, self-hide (null) on empty/malformed data, and the
 * FrontierScatter relocation keeps the old panels/ import path resolving to
 * the same component with its aria-label intact.
 */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { FrontierPoint } from "../lib/evalAggregates";
import { FrontierScatter as FrontierScatterFromCharts } from "../pages/eval/charts/FrontierScatter";
import { Histogram } from "../pages/eval/charts/Histogram";
import { MeterCell } from "../pages/eval/charts/MeterCell";
import { ScatterPlot } from "../pages/eval/charts/ScatterPlot";
import { FrontierScatter } from "../pages/eval/panels/FrontierScatter";

afterEach(cleanup);

describe("Histogram", () => {
  it("renders bars with tooltips and an accessible name", () => {
    const { container } = render(
      <Histogram values={[0.1, 0.2, 0.9, 0.9]} bins={2} label="hybrid scores" />,
    );
    expect(screen.getByRole("img", { name: "hybrid scores" })).toBeTruthy();
    const bars = container.querySelectorAll("rect");
    expect(bars.length).toBe(2); // both bins occupied
    const titles = [...container.querySelectorAll("rect > title")].map((t) => t.textContent);
    expect(titles.some((t) => t?.includes("n=2"))).toBe(true);
  });

  it("returns null on empty or all-non-finite input (no NaN axes)", () => {
    expect(Histogram({ values: [] })).toBeNull();
    expect(Histogram({ values: [Number.NaN, Number.POSITIVE_INFINITY] })).toBeNull();
  });

  it("survives a zero-span distribution (all values equal)", () => {
    const { container } = render(<Histogram values={[0.5, 0.5, 0.5]} />);
    expect(screen.getByRole("img", { name: "Histogram" })).toBeTruthy();
    expect(container.querySelectorAll("rect").length).toBe(1);
    expect(container.innerHTML).not.toContain("NaN");
  });
});

describe("ScatterPlot", () => {
  const pts = [
    { x: 100, y: 0.9, label: "A", emphasis: true },
    { x: 500, y: 0.7, label: "B", emphasis: true },
    { x: 900, y: 0.4, label: "C" },
  ];

  it("double-encodes emphasis: filled circles vs cross marks", () => {
    const { container } = render(<ScatterPlot points={pts} xLabel="tokens" yLabel="survival" />);
    expect(screen.getByRole("img", { name: "survival versus tokens scatter" })).toBeTruthy();
    expect(container.querySelectorAll("circle").length).toBe(2); // emphasized ●
    // the dominated point is a ✕ (two crossing lines in one group)
    const cross = container.querySelector("g[stroke='var(--fg-muted)']");
    expect(cross).toBeTruthy();
    expect(cross?.querySelectorAll("line").length).toBe(2);
    expect(cross?.querySelector("title")?.textContent).toContain("C");
  });

  it("renders all points as plain dots when nothing is emphasized", () => {
    const plain = pts.map(({ x, y, label }) => ({ x, y, label }));
    const { container } = render(<ScatterPlot points={plain} xLabel="x" yLabel="y" />);
    expect(container.querySelectorAll("circle").length).toBe(3);
    expect(container.querySelectorAll("g[stroke='var(--fg-muted)'] line").length).toBe(0);
  });

  it("returns null on empty or non-finite points", () => {
    expect(ScatterPlot({ points: [], xLabel: "x", yLabel: "y" })).toBeNull();
    expect(ScatterPlot({ points: [{ x: Number.NaN, y: 1 }], xLabel: "x", yLabel: "y" })).toBeNull();
  });
});

describe("MeterCell", () => {
  it("renders label, formatted value, and a proportional fill", () => {
    const { container } = render(<MeterCell value={0.9} label="hybrid" />);
    expect(screen.getByText("hybrid")).toBeTruthy();
    expect(screen.getByText("0.90")).toBeTruthy();
    const fill = container.querySelector('span[style*="90%"]');
    expect(fill).toBeTruthy();
  });

  it("normalizes against max for the bar while showing the raw value", () => {
    const { container } = render(<MeterCell value={3} max={4} format={(v) => String(v)} />);
    expect(screen.getByText("3")).toBeTruthy();
    expect(container.querySelector('span[style*="75%"]')).toBeTruthy();
  });

  it("shows an em dash and empty meter for a null value", () => {
    render(<MeterCell value={null} label="axis" />);
    expect(screen.getByText("—")).toBeTruthy();
  });
});

describe("FrontierScatter relocation", () => {
  it("panels/ shim re-exports the exact charts/ component", () => {
    expect(FrontierScatter).toBe(FrontierScatterFromCharts);
  });

  it("still renders with the original aria-label through the old path", () => {
    const points: FrontierPoint[] = [
      { configId: "A", survival: 0.9, tokens: 100, n: 3, onFrontier: true },
    ];
    render(<FrontierScatter points={points} />);
    expect(screen.getByRole("img", { name: /Curation frontier/ })).toBeTruthy();
  });
});

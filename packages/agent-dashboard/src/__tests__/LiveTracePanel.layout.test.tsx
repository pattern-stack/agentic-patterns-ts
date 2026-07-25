/**
 * LiveTracePanel's `layout` prop contract (W1-LiveRun) — "side" (default) is
 * the fixed 372px right rail; "stacked" is a full-width block with a capped
 * height, used by `RunSurfacePage` below the `md` breakpoint. Component-level
 * test (no page mocking) per `NodeInspector.scopeContext.test.tsx`'s pattern.
 */
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { LiveTracePanel } from "../constellation/LiveTracePanel";
import type { TraceStep } from "../graph/types";

const STEPS: TraceStep[] = [
  { seq: 0, iter: 0, kind: "context", label: "Setup", ms: 10 },
  { seq: 1, iter: 1, kind: "model", label: "Thinking", ms: 20 },
];

// jsdom has no scrollIntoView — TraceRow's "keep active step in view" effect
// calls it unconditionally, unrelated to the layout prop under test here.
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

describe("LiveTracePanel — layout prop", () => {
  afterEach(() => cleanup());

  it('defaults to "side": fixed width, no maxHeight', () => {
    const { container } = render(<LiveTracePanel steps={[]} cursor={-1} onSeek={() => {}} />);
    const aside = container.querySelector('[data-layout="side"]') as HTMLElement | null;
    expect(aside).toBeTruthy();
    expect(aside?.style.width).toBe("372px");
    expect(aside?.style.maxHeight).toBe("");
  });

  it('layout="stacked": full width, capped height', () => {
    const { container } = render(
      <LiveTracePanel steps={[]} cursor={-1} onSeek={() => {}} layout="stacked" />,
    );
    const aside = container.querySelector('[data-layout="stacked"]') as HTMLElement | null;
    expect(aside).toBeTruthy();
    expect(aside?.style.width).toBe("100%");
    expect(aside?.style.maxHeight).toBe("420px");
  });

  it("behavior invariance: rows render and clicking a row calls onSeek(index) identically in both layouts", () => {
    const onSeekSide = vi.fn();
    const { container: sideContainer, unmount: unmountSide } = render(
      <LiveTracePanel steps={STEPS} cursor={0} onSeek={onSeekSide} />,
    );
    const sideButtons = sideContainer.querySelectorAll('[data-layout="side"] button');
    expect(sideButtons.length).toBe(STEPS.length);
    fireEvent.click(sideButtons[1] as Element);
    expect(onSeekSide).toHaveBeenCalledWith(1);
    unmountSide();

    const onSeekStacked = vi.fn();
    const { container: stackedContainer } = render(
      <LiveTracePanel steps={STEPS} cursor={0} onSeek={onSeekStacked} layout="stacked" />,
    );
    const stackedButtons = stackedContainer.querySelectorAll('[data-layout="stacked"] button');
    expect(stackedButtons.length).toBe(STEPS.length);
    fireEvent.click(stackedButtons[1] as Element);
    expect(onSeekStacked).toHaveBeenCalledWith(1);
  });
});

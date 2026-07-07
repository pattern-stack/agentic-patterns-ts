/**
 * Pins useSortedRows under <StrictMode> — the app renders inside it
 * (main.tsx), and StrictMode double-invokes state updaters in dev. A
 * same-column direction toggle implemented as a set-inside-an-updater
 * cancels itself under double-invoke; these tests fail on that shape.
 */
import { act, renderHook } from "@testing-library/react";
import { StrictMode } from "react";
import { describe, expect, it } from "vitest";
import { useSortedRows } from "../hooks/useSortedRows";

const ROWS = [
  { name: "beta", count: "2" },
  { name: "alpha", count: "10" },
  { name: "gamma", count: "1" },
];

function renderSorted(initialKey: string, initialDir?: "asc" | "desc") {
  return renderHook(() => useSortedRows(ROWS, initialKey, initialDir), {
    wrapper: StrictMode,
  });
}

describe("useSortedRows (StrictMode)", () => {
  it("toggles direction on repeated clicks of the active column", () => {
    const { result } = renderSorted("name", "desc");
    expect(result.current.sortDir).toBe("desc");

    act(() => result.current.handleSort("name"));
    expect(result.current.sortDir).toBe("asc");

    act(() => result.current.handleSort("name"));
    expect(result.current.sortDir).toBe("desc");
  });

  it("switches column and resets direction to initialDir", () => {
    const { result } = renderSorted("name", "desc");
    act(() => result.current.handleSort("name")); // now asc
    expect(result.current.sortDir).toBe("asc");

    act(() => result.current.handleSort("count"));
    expect(result.current.sortKey).toBe("count");
    expect(result.current.sortDir).toBe("desc");
  });

  it("sorts numerically-aware and honors direction", () => {
    const { result } = renderSorted("count", "asc");
    expect(result.current.sorted.map((r) => r.count)).toEqual(["1", "2", "10"]);

    act(() => result.current.handleSort("count"));
    expect(result.current.sorted.map((r) => r.count)).toEqual(["10", "2", "1"]);
  });
});

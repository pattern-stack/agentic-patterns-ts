/**
 * RunSurfacePage's responsive stack (W1-LiveRun): below the `md` breakpoint the
 * main row goes column (graph on top, trace stacked full-width beneath), the
 * phone input floors shrink, and desktop stays byte-for-byte the pre-existing
 * layout (F1's jsdom-desktop `useBreakpoint` fallback guarantees this).
 *
 * Real deps that aren't jsdom-viable are mocked: `api/chat-client` (network),
 * `lib/runsApi` (network), `constellation/ConstellationGraph` (React Flow
 * needs real layout/measurement it can't get in jsdom).
 */
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetMediaQueryCacheForTests } from "../hooks/useMediaQuery";

vi.mock("../api/chat-client", () => ({
  listAgents: vi.fn(async () => []),
  fetchAgentCapabilities: vi.fn(async () => ({ capabilities: [] })),
  fetchAgentComposition: vi.fn(async () => null),
  createConversation: vi.fn(async () => ({ id: "conv-1" })),
  streamMessage: vi.fn(async function* () {}),
}));

vi.mock("../lib/runsApi", () => ({
  fetchRuns: vi.fn(async () => ({ kind: "unconfigured" }) as const),
  fetchRun: vi.fn(async () => ({ kind: "unconfigured" }) as const),
  fetchRunEvents: vi.fn(async () => ({ kind: "unconfigured" }) as const),
}));

vi.mock("../constellation/ConstellationGraph", () => ({
  ConstellationGraph: () => <div data-testid="graph" />,
}));

import { RunSurfacePage } from "../pages/RunSurfacePage";

/** Stub a viewport: max-width queries match ⇔ the bound ≥ `width`. */
function stubViewport(width: number) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: width < Number(/max-width:\s*(\d+)px/.exec(query)?.[1] ?? 0) + 1,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
}

function renderPage() {
  return render(
    <MemoryRouter>
      <RunSurfacePage />
    </MemoryRouter>,
  );
}

describe("RunSurfacePage — responsive stack", () => {
  beforeEach(() => {
    __resetMediaQueryCacheForTests();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    __resetMediaQueryCacheForTests();
  });

  it("narrow (800px): main row stacks column, graph box floors at 320px, trace stacks full-width", async () => {
    stubViewport(800);
    renderPage();
    const graph = await screen.findByTestId("graph");
    const graphBox = graph.parentElement as HTMLElement;
    const mainRow = graphBox.parentElement as HTMLElement;

    expect(mainRow.style.flexDirection).toBe("column");
    expect(graphBox.style.minHeight).toBe("320px");

    const trace = mainRow.querySelector('[data-layout="stacked"]') as HTMLElement | null;
    expect(trace).toBeTruthy();
    expect(trace?.style.width).toBe("100%");
  });

  it("desktop (1280px): main row stays row, today's layout byte-for-byte", async () => {
    stubViewport(1280);
    renderPage();
    const graph = await screen.findByTestId("graph");
    const graphBox = graph.parentElement as HTMLElement;
    const mainRow = graphBox.parentElement as HTMLElement;

    expect(mainRow.style.flexDirection).toBe("row");
    expect(mainRow.style.minHeight).toBe("540px");

    const trace = mainRow.querySelector('[data-layout="side"]') as HTMLElement | null;
    expect(trace).toBeTruthy();
    expect(trace?.style.width).toBe("372px");
  });

  it("phone (390px): agent select and message input floors shrink", async () => {
    stubViewport(390);
    renderPage();
    await screen.findByTestId("graph");

    const select = document.querySelector("select") as HTMLSelectElement | null;
    const input = document.querySelector("input") as HTMLInputElement | null;
    expect(select?.style.minWidth).toBe("120px");
    expect(input?.style.minWidth).toBe("140px");
  });

  it("desktop (1280px): agent select and message input keep their original floors", async () => {
    stubViewport(1280);
    renderPage();
    await screen.findByTestId("graph");

    const select = document.querySelector("select") as HTMLSelectElement | null;
    const input = document.querySelector("input") as HTMLInputElement | null;
    expect(select?.style.minWidth).toBe("170px");
    expect(input?.style.minWidth).toBe("220px");
  });
});

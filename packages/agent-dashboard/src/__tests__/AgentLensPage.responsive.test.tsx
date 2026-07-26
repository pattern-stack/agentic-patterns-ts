/**
 * AgentLensPage responsive reflow (W2-AgentLens): the Overview two-column grid
 * (instance delta | prompt + inherited identity) collapses to one column below
 * `md` (900px), and the Runs lens's 6-stat strip reflows to a two-row `3×2`
 * grid on phone (see `.claude/specs/2026-07-26-responsive-agent-lens.md`).
 *
 * jsdom has no `matchMedia`, so per the foundation contract `useBreakpoint()`
 * resolves desktop by default — this file stubs `matchMedia` (the Wave-1
 * `EvalComparePage.responsive.test.tsx` / `RunSurfacePage.responsive.test.tsx`
 * pattern) to exercise the narrow/phone branches, plus one explicit desktop
 * guard pinning today's byte-for-byte values.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentComposition } from "../api/composition";
import type { RunSummary } from "../api/types";
import { __resetMediaQueryCacheForTests } from "../hooks/useMediaQuery";
import { fetchRuns } from "../lib/runsApi";
import { AgentLensPage } from "../pages/build/AgentLensPage";

vi.mock("../lib/runsApi", () => ({
  fetchRuns: vi.fn(),
  fetchRun: vi.fn(async () => ({ kind: "unconfigured" }) as const),
  fetchRunEvents: vi.fn(async () => ({ kind: "unconfigured" }) as const),
}));

/** Stub `matchMedia`: `matchesFor` decides whether a given query string
 *  matches. Mirrors the foundation (F1) pattern used across the Wave-1
 *  responsive suites. */
function stubViewport(matchesFor: (query: string) => boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: matchesFor(query),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
}

const DESKTOP = () => false;
/** "narrow but not phone" — only the `md` (899px) query matches. */
const NARROW_NOT_PHONE = (q: string) => q === "(max-width: 899px)";
/** phone — both `sm` (639px) and `md` (899px) queries match. */
const PHONE = (q: string) => q === "(max-width: 639px)" || q === "(max-width: 899px)";

const FIXTURE: AgentComposition = {
  id: "demo-agent",
  name: "Demo Agent",
  description: "A fixture agent for the Agent lens responsive suite.",
  model: "claude-sonnet",
  role: {
    name: "demo-role",
    defaultModel: "claude-sonnet",
    persona: { name: "persona", text: "A helpful demo persona." },
    judgments: [],
    responsibilities: [],
    capabilities: [],
  },
  instance: {
    background: null,
    awareness: null,
    mission: null,
    modelOverride: null,
  },
  prompt: { renderPath: "sections", sections: [] },
  coherence: { heuristic: false, warnings: [] },
  evals: [],
};

function mkFetchResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    json: async () => body,
  };
}

function stubCompositionFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith(`/agents/${FIXTURE.id}/composition`)) {
        return mkFetchResponse(200, FIXTURE);
      }
      return mkFetchResponse(404, { error: "unhandled in test" });
    }),
  );
}

function mkRun(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    runId: "run-1",
    traceId: null,
    tsStart: "2026-01-01T00:00:00.000Z",
    tsEnd: "2026-01-01T00:00:05.000Z",
    agentName: FIXTURE.name,
    model: "claude-sonnet",
    status: "ok",
    finishReason: "stop",
    toolCalls: 2,
    iterations: 3,
    inputTokens: 100,
    outputTokens: 50,
    elapsedMs: 5000,
    answerLength: 42,
    hasPrompt: true,
    ...overrides,
  };
}

function renderPage(path = `/agents/${FIXTURE.id}`) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/agents/:id" element={<AgentLensPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  __resetMediaQueryCacheForTests();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  __resetMediaQueryCacheForTests();
});

describe("AgentLensPage — Overview grid collapse", () => {
  it("desktop (guard): the 5fr/7fr split renders byte-for-byte unchanged", async () => {
    stubViewport(DESKTOP);
    stubCompositionFetch();
    renderPage();

    await screen.findAllByText(FIXTURE.name);
    expect(screen.getByTestId("agent-lens-grid").style.gridTemplateColumns).toBe(
      "minmax(0, 5fr) minmax(0, 7fr)",
    );
  });

  it("narrow-not-phone: collapses to a single column at the md threshold", async () => {
    stubViewport(NARROW_NOT_PHONE);
    stubCompositionFetch();
    renderPage();

    await screen.findAllByText(FIXTURE.name);
    expect(screen.getByTestId("agent-lens-grid").style.gridTemplateColumns).toBe("1fr");
  });

  it("phone: also a single column (md governs, not sm)", async () => {
    stubViewport(PHONE);
    stubCompositionFetch();
    renderPage();

    await screen.findAllByText(FIXTURE.name);
    expect(screen.getByTestId("agent-lens-grid").style.gridTemplateColumns).toBe("1fr");
  });
});

describe("AgentLensPage — Runs lens 6-stat strip reflow", () => {
  it("desktop (guard): repeat(6, auto), and only the last cell drops borderRight", async () => {
    stubViewport(DESKTOP);
    stubCompositionFetch();
    vi.mocked(fetchRuns).mockResolvedValue({ kind: "ok", data: [] });

    renderPage();
    await screen.findAllByText(FIXTURE.name);
    fireEvent.click(screen.getByRole("tab", { name: "Runs" }));

    const grid = await screen.findByTestId("run-stat-grid");
    expect(grid.style.gridTemplateColumns).toBe("repeat(6, auto)");
    const cells = grid.children;
    expect(cells).toHaveLength(6);
    // jsdom's CSSOM rejects the shorthand value `border-right: none` outright
    // (the attribute simply isn't set), so "no border" reads back as "" —
    // the same as never having set the property, not the literal word "none".
    for (let i = 0; i < 5; i++) {
      expect((cells[i] as HTMLElement).style.borderRight).toBe("1px solid var(--line-2)");
    }
    expect((cells[5] as HTMLElement).style.borderRight).toBe("");
    // borderBottom is a phone-only addition — unset on desktop for every cell.
    for (let i = 0; i < 6; i++) {
      expect((cells[i] as HTMLElement).style.borderBottom).toBe("");
    }
  });

  it("phone: reflows to repeat(3, auto), two rows of 3", async () => {
    stubViewport(PHONE);
    stubCompositionFetch();
    vi.mocked(fetchRuns).mockResolvedValue({ kind: "ok", data: [] });

    renderPage();
    await screen.findAllByText(FIXTURE.name);
    fireEvent.click(screen.getByRole("tab", { name: "Runs" }));

    const grid = await screen.findByTestId("run-stat-grid");
    expect(grid.style.gridTemplateColumns).toBe("repeat(3, auto)");
    const cells = grid.children;
    expect(cells).toHaveLength(6);
    // row 1 (0,1,2): borderBottom present; index 2 is the row-end, no borderRight
    // ("no border" reads back as "" in jsdom — see the desktop test's note).
    expect((cells[0] as HTMLElement).style.borderBottom).toBe("1px solid var(--line-2)");
    expect((cells[1] as HTMLElement).style.borderBottom).toBe("1px solid var(--line-2)");
    expect((cells[2] as HTMLElement).style.borderBottom).toBe("1px solid var(--line-2)");
    expect((cells[0] as HTMLElement).style.borderRight).toBe("1px solid var(--line-2)");
    expect((cells[2] as HTMLElement).style.borderRight).toBe("");
    // row 2 (3,4,5): no borderBottom; index 5 (last) is also a row-end, no borderRight.
    expect((cells[3] as HTMLElement).style.borderBottom).toBe("");
    expect((cells[3] as HTMLElement).style.borderRight).toBe("1px solid var(--line-2)");
    expect((cells[5] as HTMLElement).style.borderRight).toBe("");
  });
});

describe("AgentLensPage — run picker <select> floor", () => {
  it("desktop (guard): minWidth 260px, flex unset", async () => {
    stubViewport(DESKTOP);
    stubCompositionFetch();
    vi.mocked(fetchRuns).mockResolvedValue({
      kind: "ok",
      data: [mkRun({ runId: "run-1" }), mkRun({ runId: "run-2" })],
    });

    renderPage();
    await screen.findAllByText(FIXTURE.name);
    fireEvent.click(screen.getByRole("tab", { name: "Runs" }));

    const select = await screen.findByRole("combobox");
    expect(select.style.minWidth).toBe("260px");
    expect(select.style.flex).toBe("");
  });

  it("phone: minWidth drops to 0 and flex:1 takes over", async () => {
    stubViewport(PHONE);
    stubCompositionFetch();
    vi.mocked(fetchRuns).mockResolvedValue({
      kind: "ok",
      data: [mkRun({ runId: "run-1" }), mkRun({ runId: "run-2" })],
    });

    renderPage();
    await screen.findAllByText(FIXTURE.name);
    fireEvent.click(screen.getByRole("tab", { name: "Runs" }));

    const select = await screen.findByRole("combobox");
    // React's inline-style writer doesn't append "px" to a literal 0 (its
    // dangerousStyleValue short-circuits on `value === 0`), and jsdom expands
    // the `flex` shorthand's getter to its longhand triple.
    expect(select.style.minWidth).toBe("0");
    expect(select.style.flex).toBe("1 1 0%");
  });
});

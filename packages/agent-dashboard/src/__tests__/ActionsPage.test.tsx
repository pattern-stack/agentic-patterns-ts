/**
 * /actions — Quick Actions page.
 *
 * The page renders one card per declared quick action (`quick_actions` on
 * `GET /agents`), with the prompt TEMPLATE visible (the demo's whole point),
 * and Run navigates to that agent's chat carrying the prompt in router STATE
 * — never a query param, so a refresh or Back can't re-fire a real run.
 *
 * `GET /agents` is stubbed the way the other page suites stub their fetches
 * (`ChatPage.scopeChip.test.tsx`'s router precedent).
 */
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActionsPage } from "../pages/ActionsPage";

const BRIEF_PROMPT = "Summarize overnight listings and flag anything under $400.";

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => body,
  } as unknown as Response;
}

function stubAgents(agents: unknown[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/agents") return jsonResponse(agents);
      throw new Error(`unmocked fetch: ${url}`);
    }),
  );
}

/** Renders the page inside a router and reports where a Run navigated to,
 *  plus what it carried in navigation state. */
function renderPage() {
  const seen: { pathname: string; state: unknown } = { pathname: "/actions", state: null };
  function Probe() {
    const location = useLocation();
    seen.pathname = location.pathname;
    seen.state = location.state;
    return <div>chat surface</div>;
  }
  const utils = render(
    <MemoryRouter initialEntries={["/actions"]}>
      <Routes>
        <Route path="/actions" element={<ActionsPage />} />
        <Route path="/chat/:agentId" element={<Probe />} />
      </Routes>
    </MemoryRouter>,
  );
  return { ...utils, seen };
}

describe("ActionsPage", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("renders a card per quick action with its prompt template visible; agents without actions don't appear", async () => {
    stubAgents([
      {
        id: "companion",
        name: "Companion",
        description: "",
        quick_actions: [
          {
            id: "morning-brief",
            label: "Run Morning Brief",
            description: "The 9am ambient brief",
            prompt: BRIEF_PROMPT,
          },
        ],
      },
      { id: "quiet", name: "Quiet Agent", description: "", quick_actions: [] },
    ]);

    const { findByText, queryByText, getByRole } = renderPage();

    expect(await findByText("Run Morning Brief")).toBeTruthy();
    expect(await findByText("The 9am ambient brief")).toBeTruthy();
    // The agent it runs on, and the template itself — both on screen.
    expect(getByRole("button", { name: "Run Run Morning Brief" })).toBeTruthy();
    expect(await findByText(BRIEF_PROMPT)).toBeTruthy();
    // An agent with no actions contributes no card.
    expect(queryByText("Quiet Agent")).toBeNull();
  });

  it("Run navigates to the agent's chat with the prompt in router state (not the URL)", async () => {
    stubAgents([
      {
        id: "companion",
        name: "Companion",
        description: "",
        quick_actions: [
          {
            id: "morning-brief",
            label: "Run Morning Brief",
            description: null,
            prompt: BRIEF_PROMPT,
          },
        ],
      },
    ]);

    const { findByRole, seen } = renderPage();
    fireEvent.click(await findByRole("button", { name: "Run Run Morning Brief" }));

    await waitFor(() => expect(seen.pathname).toBe("/chat/companion"));
    expect(seen.state).toEqual({ autoSend: BRIEF_PROMPT });
  });

  it("shows a quiet empty state when no registration declares any action (incl. an older server that omits the field)", async () => {
    stubAgents([{ id: "a1", name: "Agent One", description: "" }]);

    const { findByText } = renderPage();
    expect(await findByText("No quick actions")).toBeTruthy();
  });
});

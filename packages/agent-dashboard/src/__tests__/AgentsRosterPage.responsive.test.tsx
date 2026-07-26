/**
 * AgentsRosterPage (`/agents`) — role-header row wrap fix (W2-Build). The
 * role-disclosure button (chevron + role name + count/readiness chips) sits
 * inside a Card with `overflow: "hidden"`, so without `flexWrap` a long role
 * name plus two chips would clip silently at phone widths instead of
 * dropping to a second line. The fix is a pure style addition — the button's
 * `flexWrap` is "wrap" regardless of breakpoint (a no-op when content
 * already fits on one line, which is every case at desktop width).
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RosterAgent } from "../api/composition";
import { __resetMediaQueryCacheForTests } from "../hooks/useMediaQuery";
import { AgentsRosterPage } from "../pages/build/AgentsRosterPage";

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

function mkFetchResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    json: async () => body,
  };
}

const agents: RosterAgent[] = [
  {
    id: "curator-1",
    name: "dealbrain/curator",
    description: "Curates the deal bank.",
    role: { id: "curator", name: "Curator" },
    readiness: { ready: true, missing: [] },
  },
];

function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => mkFetchResponse(200, agents)),
  );
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/agents"]}>
      <AgentsRosterPage />
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  __resetMediaQueryCacheForTests();
});

describe("AgentsRosterPage — role-header row wrap", () => {
  it("desktop: the role-header button wraps (no-op at full width, byte-for-byte otherwise unchanged)", async () => {
    stubFetch();
    renderPage();

    let button: HTMLElement;
    await waitFor(() => {
      button = screen.getByRole("button", { expanded: false, name: /Curator/ });
    });
    expect(button!.style.flexWrap).toBe("wrap");
  });

  it("phone: the role-header button also wraps", async () => {
    stubPhone();
    stubFetch();
    renderPage();

    let button: HTMLElement;
    await waitFor(() => {
      button = screen.getByRole("button", { expanded: false, name: /Curator/ });
    });
    expect(button!.style.flexWrap).toBe("wrap");
  });
});

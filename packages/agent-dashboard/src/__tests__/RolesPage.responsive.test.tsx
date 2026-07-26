/**
 * RolesPage detail view (`/roles/:id`) — instantiation matrix column pruning
 * (W2-Build). Desktop (jsdom default, no `matchMedia` stub) renders all five
 * columns unchanged; phone drops `Background`/`Awareness` to keep `Agent`,
 * `Model`, `Mission` from wrapping into crushed multi-line cells.
 */
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RoleDetail } from "../api/composition";
import { __resetMediaQueryCacheForTests } from "../hooks/useMediaQuery";
import { RolesPage } from "../pages/build/RolesPage";

/**
 * Stubs `window.matchMedia` so `useBreakpoint` resolves to a phone viewport
 * (isPhone AND isNarrow true). Matches both `maxWidthQuery("sm")` (639px) and
 * `maxWidthQuery("md")` (899px) from `ui/breakpoints.ts`.
 */
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

function stubFetch(detail: RoleDetail) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith(`/roles/${detail.id}`)) return mkFetchResponse(200, detail);
      return mkFetchResponse(404, { error: "unhandled in test" });
    }),
  );
}

function renderDetail(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/roles/:id" element={<RolesPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

const baseDetail: RoleDetail = {
  id: "curator",
  name: "Curator",
  defaultModel: "sonnet",
  similarTo: [],
  agents: [],
  persona: { name: "Persona", text: "" },
  judgments: [],
  responsibilities: [],
  capabilities: [],
};

const instanceDetail: RoleDetail = {
  ...baseDetail,
  agents: [
    {
      id: "curator-1",
      name: "dealbrain/curator",
      model: "sonnet",
      background: { org: "dealbrain" },
      awareness: { domains: ["listings", "pricing"] },
      mission: { objective: "Curate the deal bank" },
    },
  ],
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  __resetMediaQueryCacheForTests();
});

describe("RolesPage detail — instantiation matrix responsive column pruning", () => {
  it("desktop: Agent/Model/Background/Awareness/Mission are all present", async () => {
    stubFetch(instanceDetail);
    renderDetail("/roles/curator");

    let table: HTMLElement;
    await waitFor(() => {
      table = screen.getByRole("table");
    });
    const headers = within(table!);
    expect(headers.getByRole("columnheader", { name: "Agent" })).toBeTruthy();
    expect(headers.getByRole("columnheader", { name: "Model" })).toBeTruthy();
    expect(headers.getByRole("columnheader", { name: "Background" })).toBeTruthy();
    expect(headers.getByRole("columnheader", { name: "Awareness" })).toBeTruthy();
    expect(headers.getByRole("columnheader", { name: "Mission" })).toBeTruthy();

    // Row data for the pruned columns is present on desktop.
    expect(headers.getByText("1 keys")).toBeTruthy();
    expect(headers.getByText("2 domains")).toBeTruthy();
  });

  it("phone: Background/Awareness are pruned; Agent/Model/Mission remain", async () => {
    stubPhone();
    stubFetch(instanceDetail);
    renderDetail("/roles/curator");

    let table: HTMLElement;
    await waitFor(() => {
      table = screen.getByRole("table");
    });
    const headers = within(table!);
    expect(headers.getByRole("columnheader", { name: "Agent" })).toBeTruthy();
    expect(headers.getByRole("columnheader", { name: "Model" })).toBeTruthy();
    expect(headers.getByRole("columnheader", { name: "Mission" })).toBeTruthy();

    expect(headers.queryByRole("columnheader", { name: "Background" })).toBeNull();
    expect(headers.queryByRole("columnheader", { name: "Awareness" })).toBeNull();

    // The pruned columns' row data is gone from the DOM too, not just hidden headers.
    expect(headers.queryByText("1 keys")).toBeNull();
    expect(headers.queryByText("2 domains")).toBeNull();
  });

  it("phone, no instances: empty-state colSpan matches the pruned (3) header count", async () => {
    stubPhone();
    stubFetch(baseDetail);
    renderDetail("/roles/curator");

    let emptyCell: HTMLElement;
    await waitFor(() => {
      emptyCell = screen.getByText("No agents instantiate this role.");
    });
    expect(emptyCell!.getAttribute("colspan")).toBe("3");
  });

  it("desktop, no instances: empty-state colSpan matches the full (5) header count", async () => {
    stubFetch(baseDetail);
    renderDetail("/roles/curator");

    let emptyCell: HTMLElement;
    await waitFor(() => {
      emptyCell = screen.getByText("No agents instantiate this role.");
    });
    expect(emptyCell!.getAttribute("colspan")).toBe("5");
  });
});

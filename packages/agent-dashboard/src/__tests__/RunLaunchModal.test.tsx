/**
 * RunLaunchModal — the set-detail "Run eval" affordance. Wraps the shared
 * `RunLaunchForm` in a Modal with the set locked to the page's set. Stubbed
 * fetch (the `RunLauncher.test.tsx` URL-aware idiom), wrapped in `MemoryRouter`
 * since a 202 navigates. Portalled content is queried via `screen` (document body).
 */

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RunLaunchModal } from "../pages/eval/RunLaunchModal";

const agents = [{ id: "dealbrain/curator", name: "curator", description: "" }];

const scorers = [
  { id: "exact-match", description: "" },
  { id: "set-membership", description: "" },
  { id: "none", description: "" },
];

function mkFetchResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    json: async () => body,
  };
}

function stubFetch(opts: { postStatus?: number; postBody?: unknown } = {}) {
  const postStatus = opts.postStatus ?? 202;
  const postBody = opts.postBody ?? { runId: "run-preset", total: 4 };

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (method === "POST" && url.includes("/eval/runs")) {
      return mkFetchResponse(postStatus, postBody);
    }
    if (url.includes("/eval/scorers")) return mkFetchResponse(200, { scorers });
    if (url.includes("/eval/sets")) return mkFetchResponse(200, { sets: [] });
    if (url.includes("/agents")) return mkFetchResponse(200, agents);
    return mkFetchResponse(404, { error: "unhandled in test" });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function LocationDisplay() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}</div>;
}

function renderModal(onClose = () => {}) {
  return render(
    <MemoryRouter initialEntries={["/eval/sets/bank"]}>
      <Routes>
        <Route
          path="/eval/sets/bank"
          element={<RunLaunchModal setId="bank" setLabel="Bank" onClose={onClose} />}
        />
        <Route path="/eval/runs/:id" element={<LocationDisplay />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("RunLaunchModal", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("locks the set to a static label and never fetches the full set list", async () => {
    const fetchMock = stubFetch();
    renderModal();

    const setField = await screen.findByLabelText("Set");
    expect(setField.tagName).not.toBe("SELECT");
    expect(setField.textContent).toBe("Bank");

    // Targets still load; the all-sets list is never fetched in preset mode.
    await waitFor(() => {
      expect(
        within(screen.getByLabelText("Target") as HTMLSelectElement).getByText("curator"),
      ).toBeTruthy();
    });
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/eval/sets"))).toBe(false);
  });

  it("Run posts the preset setId and a 202 navigates to the run", async () => {
    const fetchMock = stubFetch({ postStatus: 202, postBody: { runId: "run-preset", total: 4 } });
    renderModal();

    await waitFor(() => {
      expect(
        within(screen.getByLabelText("Target") as HTMLSelectElement).getByText("curator"),
      ).toBeTruthy();
    });
    fireEvent.change(screen.getByLabelText("Target"), { target: { value: "dealbrain/curator" } });
    fireEvent.click(screen.getByRole("button", { name: "Run" }));

    await waitFor(() => {
      expect(screen.getByTestId("location").textContent).toBe("/eval/runs/run-preset");
    });
    const postCall = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
    const body = JSON.parse((postCall?.[1] as RequestInit).body as string);
    expect(body).toEqual({ setId: "bank", targetId: "dealbrain/curator", scorer: "exact-match" });
  });

  it("closes on the modal's ✕", async () => {
    stubFetch();
    const onClose = vi.fn();
    renderModal(onClose);
    await screen.findByLabelText("Set");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});

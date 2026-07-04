/**
 * RunLauncher — set/target/variant/split picker + allowTest affordance for
 * `POST /eval/runs` (#139, E5c). Stubbed fetch (the `EvalRunsPage.test.tsx`
 * URL-aware idiom), wrapped in `MemoryRouter` since a 202 navigates.
 */

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RunLauncher } from "../pages/eval/RunLauncher";

const sets = [
  {
    id: "bank",
    name: "Bank",
    description: null,
    createdTs: "2026-07-01T00:00:00Z",
    caseCount: 4,
    splitCounts: { train: 2, dev: 1, "": 1 },
  },
];

const agents = [{ id: "dealbrain/curator", name: "curator", description: "" }];

function mkFetchResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    json: async () => body,
  };
}

interface StubOptions {
  postStatus?: number;
  postBody?: unknown;
}

function stubFetch(opts: StubOptions = {}) {
  const postStatus = opts.postStatus ?? 202;
  const postBody = opts.postBody ?? { runId: "run-new", total: 4 };

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (method === "POST" && url.includes("/eval/runs")) {
      return mkFetchResponse(postStatus, postBody);
    }
    if (url.includes("/eval/sets")) {
      return mkFetchResponse(200, { sets });
    }
    if (url.includes("/agents")) {
      return mkFetchResponse(200, agents);
    }
    return mkFetchResponse(404, { error: "unhandled in test" });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function LocationDisplay() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}</div>;
}

function renderLauncher() {
  return render(
    <MemoryRouter initialEntries={["/eval"]}>
      <Routes>
        <Route path="/eval" element={<RunLauncher />} />
        <Route path="/eval/runs/:id" element={<LocationDisplay />} />
      </Routes>
    </MemoryRouter>,
  );
}

async function openAndPopulate() {
  fireEvent.click(screen.getByRole("button", { name: "Run eval" }));
  await waitFor(() => {
    expect(
      within(screen.getByLabelText("Set") as HTMLSelectElement).getByText("bank (4)"),
    ).toBeTruthy();
  });
  await waitFor(() => {
    expect(
      within(screen.getByLabelText("Target") as HTMLSelectElement).getByText("curator"),
    ).toBeTruthy();
  });
}

describe("RunLauncher", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("starts collapsed behind a 'Run eval' button", () => {
    stubFetch();
    renderLauncher();
    expect(screen.getByRole("button", { name: "Run eval" })).toBeTruthy();
    expect(screen.queryByLabelText("Set")).toBeNull();
  });

  it("renders sets and targets from stubbed fetches", async () => {
    stubFetch();
    renderLauncher();
    await openAndPopulate();
  });

  it("choosing the test split reveals the allowTest checkbox; Run posts allowTest:true", async () => {
    const fetchMock = stubFetch();
    renderLauncher();
    await openAndPopulate();

    fireEvent.change(screen.getByLabelText("Set"), { target: { value: "bank" } });
    fireEvent.change(screen.getByLabelText("Target"), { target: { value: "dealbrain/curator" } });

    expect(screen.queryByText("Run the held-out test split")).toBeNull();
    fireEvent.change(screen.getByLabelText("Split"), { target: { value: "test" } });
    expect(screen.getByText("Run the held-out test split")).toBeTruthy();

    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Run" }));

    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(true);
    });
    const postCall = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
    const body = JSON.parse((postCall?.[1] as RequestInit).body as string);
    expect(body).toEqual({
      setId: "bank",
      targetId: "dealbrain/curator",
      split: "test",
      allowTest: true,
    });
  });

  it("202 navigates to /eval/runs/:runId", async () => {
    stubFetch({ postStatus: 202, postBody: { runId: "run-xyz", total: 4 } });
    renderLauncher();
    await openAndPopulate();

    fireEvent.change(screen.getByLabelText("Set"), { target: { value: "bank" } });
    fireEvent.change(screen.getByLabelText("Target"), { target: { value: "dealbrain/curator" } });
    fireEvent.click(screen.getByRole("button", { name: "Run" }));

    await waitFor(() => {
      expect(screen.getByTestId("location").textContent).toBe("/eval/runs/run-xyz");
    });
  });

  it("403 (held-out refusal) renders inline; no navigation", async () => {
    stubFetch({
      postStatus: 403,
      postBody: {
        error: 'case-bank: refusing the held-out "test" split — touch once, pre-ship only.',
        hint: 'retry with "allowTest": true',
      },
    });
    renderLauncher();
    await openAndPopulate();

    fireEvent.change(screen.getByLabelText("Set"), { target: { value: "bank" } });
    fireEvent.change(screen.getByLabelText("Target"), { target: { value: "dealbrain/curator" } });
    fireEvent.click(screen.getByRole("button", { name: "Run" }));

    await waitFor(() => {
      expect(screen.getByText(/refusing the held-out/)).toBeTruthy();
    });
    expect(screen.queryByTestId("location")).toBeNull();
  });
});

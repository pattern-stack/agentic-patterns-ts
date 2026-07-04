/**
 * CaseEditModal — the strict-JSON gate and the save round-trip. A stubbed
 * `fetch` stands in for `PUT /eval/sets/:id/cases/:caseId`.
 */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EvalCaseRow } from "../api/types";
import { CaseEditModal } from "../pages/eval/CaseEditModal";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function mkFetchResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    json: async () => body,
  };
}

describe("CaseEditModal", () => {
  it("blocks save on invalid input JSON with an inline error (no fetch)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    render(<CaseEditModal setId="bank" mode="create" onClose={() => {}} onSaved={() => {}} />);

    fireEvent.change(screen.getByLabelText("Case id"), { target: { value: "c1" } });
    // Unquoted bareword — invalid JSON.
    fireEvent.change(screen.getByLabelText("Case input"), { target: { value: "2+2?" } });
    fireEvent.click(screen.getByText("Save"));

    await waitFor(() => {
      expect(screen.getByText(/Input is not valid JSON/)).toBeTruthy();
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("PUTs a valid case and calls onSaved with the returned row", async () => {
    const saved: EvalCaseRow = {
      setId: "bank",
      caseId: "c1",
      input: "2+2?",
      expected: "4",
      tags: ["smoke"],
      split: "train",
    };
    const fetchMock = vi.fn(async () => mkFetchResponse(201, { case: saved }));
    vi.stubGlobal("fetch", fetchMock);
    const onSaved = vi.fn();

    render(<CaseEditModal setId="bank" mode="create" onClose={() => {}} onSaved={onSaved} />);

    fireEvent.change(screen.getByLabelText("Case id"), { target: { value: "c1" } });
    fireEvent.change(screen.getByLabelText("Case input"), { target: { value: '"2+2?"' } });
    fireEvent.change(screen.getByLabelText("Case expected"), { target: { value: '"4"' } });
    fireEvent.change(screen.getByLabelText("Case tags"), {
      target: { value: "smoke, regression" },
    });
    fireEvent.click(screen.getByText("Save"));

    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(saved));

    // Assert the request shape: PUT to the case route with parsed JSON body.
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/eval/sets/bank/cases/c1");
    expect(init.method).toBe("PUT");
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({ input: "2+2?", expected: "4", tags: ["smoke", "regression"] });
  });

  it("locks the case id in edit mode", () => {
    const initial: EvalCaseRow = {
      setId: "bank",
      caseId: "c1",
      input: { q: "2+2" },
      expected: "4",
      tags: null,
      split: "dev",
    };
    render(
      <CaseEditModal
        setId="bank"
        mode="edit"
        initial={initial}
        onClose={() => {}}
        onSaved={() => {}}
      />,
    );
    expect((screen.getByLabelText("Case id") as HTMLInputElement).disabled).toBe(true);
    // Input prefilled as pretty JSON.
    expect((screen.getByLabelText("Case input") as HTMLTextAreaElement).value).toContain('"q"');
  });
});

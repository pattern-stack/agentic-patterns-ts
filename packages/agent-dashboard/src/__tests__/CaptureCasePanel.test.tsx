/**
 * CaptureCasePanel — the "Capture eval case" affordance on ChatPage (#140,
 * E5d). Stubbed fetch (the `RunLauncher.test.tsx` URL-aware idiom), wrapped
 * in `MemoryRouter` for the confirmation Card's `/eval` link.
 */

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "../chat";
import { CaptureCasePanel } from "../pages/eval/CaptureCasePanel";

const oneExchange: ChatMessage[] = [
  { id: "m1", role: "user", parts: [{ kind: "text", content: "hello" }] },
  { id: "m2", role: "assistant", parts: [{ kind: "text", content: "hi there" }] },
];

const twoExchanges: ChatMessage[] = [
  { id: "m1", role: "user", parts: [{ kind: "text", content: "first question" }] },
  { id: "m2", role: "assistant", parts: [{ kind: "text", content: "first answer" }] },
  { id: "m3", role: "user", parts: [{ kind: "text", content: "second question" }] },
  { id: "m4", role: "assistant", parts: [{ kind: "text", content: "second answer" }] },
];

const defaultSets = [
  {
    id: "bank",
    name: "Bank",
    description: null,
    createdTs: "2026-07-01T00:00:00Z",
    caseCount: 4,
    splitCounts: { train: 4 },
  },
];

const defaultPostBody = {
  setId: "bank",
  caseId: "session-conv-1-1",
  created: true,
  input: "hello",
  expected: "hi there",
  tags: ["captured", "agent:echo"],
  split: "train",
};

function mkFetchResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    json: async () => body,
  };
}

interface StubOptions {
  setsStatus?: number;
  postStatus?: number;
  postBody?: unknown;
}

function stubFetch(opts: StubOptions = {}) {
  const setsStatus = opts.setsStatus ?? 200;
  const postStatus = opts.postStatus ?? 201;
  const postBody = opts.postBody ?? defaultPostBody;

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (method === "POST" && url.includes("/eval/cases/from-session")) {
      return mkFetchResponse(postStatus, postBody);
    }
    if (url.includes("/eval/sets")) {
      return mkFetchResponse(setsStatus, { sets: defaultSets });
    }
    return mkFetchResponse(404, { error: "unhandled in test" });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderPanel(props: {
  conversationId: string | null;
  messages: ChatMessage[];
  streaming?: boolean;
}) {
  return render(
    <MemoryRouter>
      <CaptureCasePanel
        conversationId={props.conversationId}
        messages={props.messages}
        streaming={props.streaming ?? false}
      />
    </MemoryRouter>,
  );
}

describe("CaptureCasePanel", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("starts collapsed; the toggle is disabled without a live conversation/exchange", () => {
    stubFetch();
    renderPanel({ conversationId: null, messages: [] });
    const button = screen.getByRole("button", { name: "Capture eval case" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it("enables the toggle once the conversation has a completed exchange", () => {
    stubFetch();
    renderPanel({ conversationId: "conv-1", messages: oneExchange });
    const button = screen.getByRole("button", { name: "Capture eval case" }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
  });

  it("disables the toggle while streaming", () => {
    stubFetch();
    renderPanel({ conversationId: "conv-1", messages: oneExchange, streaming: true });
    const button = screen.getByRole("button", { name: "Capture eval case" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it("opens with Expected pre-seeded from the assistant answer; no exchange picker for a single exchange", async () => {
    stubFetch();
    renderPanel({ conversationId: "conv-1", messages: oneExchange });
    fireEvent.click(screen.getByRole("button", { name: "Capture eval case" }));

    expect(screen.queryByLabelText("Exchange")).toBeNull();
    await waitFor(() => {
      expect((screen.getByLabelText("Expected") as HTMLTextAreaElement).value).toBe("hi there");
    });
  });

  it("shows an exchange picker for a multi-turn conversation; switching reseeds Expected", async () => {
    stubFetch();
    renderPanel({ conversationId: "conv-2", messages: twoExchanges });
    fireEvent.click(screen.getByRole("button", { name: "Capture eval case" }));

    await waitFor(() => {
      expect((screen.getByLabelText("Expected") as HTMLTextAreaElement).value).toBe("first answer");
    });

    fireEvent.change(screen.getByLabelText("Exchange"), { target: { value: "2" } });
    expect((screen.getByLabelText("Expected") as HTMLTextAreaElement).value).toBe("second answer");
  });

  it("submits conversationId/setId/exchange/expected/split; renders a 'Created' confirmation", async () => {
    const fetchMock = stubFetch({ postStatus: 201, postBody: defaultPostBody });
    renderPanel({ conversationId: "conv-1", messages: oneExchange });
    fireEvent.click(screen.getByRole("button", { name: "Capture eval case" }));

    await waitFor(() => {
      expect(
        within(screen.getByLabelText("Set") as HTMLSelectElement).getByText("bank (4)"),
      ).toBeTruthy();
    });
    fireEvent.change(screen.getByLabelText("Set"), { target: { value: "bank" } });
    fireEvent.click(screen.getByRole("button", { name: "Capture" }));

    await waitFor(() => {
      expect(screen.getByText(/Created/)).toBeTruthy();
    });
    expect(screen.getByText("session-conv-1-1")).toBeTruthy();

    const postCall = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
    const body = JSON.parse((postCall?.[1] as RequestInit).body as string);
    expect(body).toEqual({
      conversationId: "conv-1",
      setId: "bank",
      exchange: 1,
      expected: "hi there",
      split: "train",
    });
  });

  it("200 (re-capture) renders an 'Updated existing case' confirmation", async () => {
    stubFetch({
      postStatus: 200,
      postBody: { ...defaultPostBody, created: false, expected: "edited" },
    });
    renderPanel({ conversationId: "conv-1", messages: oneExchange });
    fireEvent.click(screen.getByRole("button", { name: "Capture eval case" }));

    await waitFor(() => {
      expect(screen.getByLabelText("Set")).toBeTruthy();
    });
    fireEvent.change(screen.getByLabelText("Set"), { target: { value: "bank" } });
    fireEvent.click(screen.getByRole("button", { name: "Capture" }));

    await waitFor(() => {
      expect(screen.getByText(/Updated existing case/)).toBeTruthy();
    });
  });

  it("creating a new set reveals id/name inputs and sends createSet", async () => {
    const fetchMock = stubFetch({
      postStatus: 201,
      postBody: { ...defaultPostBody, setId: "fresh" },
    });
    renderPanel({ conversationId: "conv-1", messages: oneExchange });
    fireEvent.click(screen.getByRole("button", { name: "Capture eval case" }));

    await waitFor(() => {
      expect(screen.getByLabelText("Set")).toBeTruthy();
    });
    fireEvent.change(screen.getByLabelText("Set"), { target: { value: "__new__" } });
    fireEvent.change(screen.getByLabelText("New set id"), { target: { value: "fresh" } });
    fireEvent.change(screen.getByLabelText("New set name"), { target: { value: "Fresh bank" } });
    fireEvent.click(screen.getByRole("button", { name: "Capture" }));

    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(true);
    });
    const postCall = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
    const body = JSON.parse((postCall?.[1] as RequestInit).body as string);
    expect(body).toEqual({
      conversationId: "conv-1",
      setId: "fresh",
      exchange: 1,
      expected: "hi there",
      split: "train",
      createSet: { name: "Fresh bank" },
    });
  });

  it("renders the persistence hint when eval sets are unconfigured (503)", async () => {
    stubFetch({ setsStatus: 503 });
    renderPanel({ conversationId: "conv-1", messages: oneExchange });
    fireEvent.click(screen.getByRole("button", { name: "Capture eval case" }));

    await waitFor(() => {
      expect(screen.getByText(/AP_PERSISTENCE/)).toBeTruthy();
    });
  });

  it("a non-2xx capture response renders the server error inline", async () => {
    stubFetch({
      postStatus: 404,
      postBody: {
        error: 'eval set "bank" not found',
        hint: 'retry with "createSet": {"name": …} to create it',
      },
    });
    renderPanel({ conversationId: "conv-1", messages: oneExchange });
    fireEvent.click(screen.getByRole("button", { name: "Capture eval case" }));

    await waitFor(() => {
      expect(screen.getByLabelText("Set")).toBeTruthy();
    });
    fireEvent.change(screen.getByLabelText("Set"), { target: { value: "bank" } });
    fireEvent.click(screen.getByRole("button", { name: "Capture" }));

    await waitFor(() => {
      expect(screen.getByText(/createSet/)).toBeTruthy();
    });
  });
});

/**
 * CaptureCasePanel — the `evalApi.test.ts` / `EvalRunsPage.test.tsx` idiom:
 * stubbed `fetch` (URL-aware), testing-library render + `fireEvent`.
 */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EvalSetSummary } from "../../api/types";
import { CaptureCasePanel } from "../CaptureCasePanel";
import type { ChatMessage } from "../model";

function mkFetchResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    json: async () => body,
  };
}

const sets: EvalSetSummary[] = [
  {
    id: "curator-bank",
    name: "Curator bank",
    description: null,
    createdTs: "2026-07-01T00:00:00Z",
    caseCount: 3,
    splitCounts: { train: 3 },
  },
];

interface StubOptions {
  setsStatus?: number;
  sets?: EvalSetSummary[];
  captureStatus?: number;
  captureBody?: unknown;
}

function stubFetch(opts: StubOptions = {}) {
  const { setsStatus = 200, sets: setsBody = sets, captureStatus = 201, captureBody } = opts;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/eval/cases/from-session")) {
      const body = captureBody ?? {
        setId: "curator-bank",
        caseId: "case-123",
        created: true,
        input: "hi",
        expected: "hello",
        tags: ["captured"],
        split: "train",
      };
      return mkFetchResponse(captureStatus, body);
    }
    if (url.includes("/eval/sets")) {
      return mkFetchResponse(setsStatus, { sets: setsBody });
    }
    return mkFetchResponse(404, { error: "unhandled in test" });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function userMsg(id: string, text: string): ChatMessage {
  return { id, role: "user", parts: [{ kind: "text", content: text }] };
}
function assistantMsg(id: string, text: string): ChatMessage {
  return { id, role: "assistant", parts: [{ kind: "text", content: text }] };
}

const twoExchangeMessages: ChatMessage[] = [
  userMsg("u1", "What is the capital of France?"),
  assistantMsg("a1", "Paris."),
  userMsg("u2", "And Germany?"),
  assistantMsg("a2", "Berlin."),
];

describe("CaptureCasePanel", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("1. renders the pre-send hint and no button when there is no conversation yet", () => {
    render(<CaptureCasePanel conversationId={null} messages={[]} exchangeCount={0} />);
    expect(screen.getByText("Send a message first, then capture it as an eval case.")).toBeTruthy();
    expect(screen.queryByText("Capture as eval case")).toBeNull();
  });

  it("1b. renders the pre-send hint when exchangeCount is 0 even with a conversationId", () => {
    render(<CaptureCasePanel conversationId="conv-1" messages={[]} exchangeCount={0} />);
    expect(screen.getByText("Send a message first, then capture it as an eval case.")).toBeTruthy();
  });

  it("2. expanding fetches sets and renders the set picker with existing sets", async () => {
    stubFetch();
    render(
      <CaptureCasePanel conversationId="conv-1" messages={twoExchangeMessages} exchangeCount={2} />,
    );

    fireEvent.click(screen.getByText("Capture as eval case"));

    await waitFor(() => {
      expect(screen.getByLabelText("Set")).toBeTruthy();
    });
    expect(screen.getByText("Curator bank (3)")).toBeTruthy();
  });

  it("3. fetchEvalSets -> unconfigured renders the 503 line, no form", async () => {
    stubFetch({ setsStatus: 503 });
    render(
      <CaptureCasePanel conversationId="conv-1" messages={twoExchangeMessages} exchangeCount={2} />,
    );

    fireEvent.click(screen.getByText("Capture as eval case"));

    await waitFor(() => {
      expect(screen.getByText("Eval persistence isn't configured on this server.")).toBeTruthy();
    });
    expect(screen.queryByLabelText("Set")).toBeNull();
  });

  it("4. submit against an existing set posts the right body and shows 'Created new case'", async () => {
    const fetchMock = stubFetch();
    render(
      <CaptureCasePanel conversationId="conv-1" messages={twoExchangeMessages} exchangeCount={2} />,
    );

    fireEvent.click(screen.getByText("Capture as eval case"));
    await waitFor(() => expect(screen.getByLabelText("Set")).toBeTruthy());

    fireEvent.change(screen.getByLabelText("Set"), { target: { value: "curator-bank" } });
    fireEvent.click(screen.getByRole("button", { name: "Capture" }));

    await waitFor(() => {
      expect(screen.getByText(/Created new case/)).toBeTruthy();
    });

    const call = fetchMock.mock.calls.find(([url]) =>
      String(url).includes("/eval/cases/from-session"),
    );
    expect(call).toBeTruthy();
    const body = JSON.parse((call?.[1] as RequestInit).body as string);
    expect(body.conversationId).toBe("conv-1");
    expect(body.setId).toBe("curator-bank");
    expect(body.exchange).toBe(2);
    expect(body.split).toBe("train");
    expect(body.expected).toBe("Berlin.");
    expect(body.caseId).toBeUndefined();
  });

  it("5. created:false response renders 'Updated existing case'", async () => {
    stubFetch({
      captureBody: {
        setId: "curator-bank",
        caseId: "case-123",
        created: false,
        input: "hi",
        expected: "hello",
        tags: ["captured"],
        split: "train",
      },
    });
    render(
      <CaptureCasePanel conversationId="conv-1" messages={twoExchangeMessages} exchangeCount={2} />,
    );

    fireEvent.click(screen.getByText("Capture as eval case"));
    await waitFor(() => expect(screen.getByLabelText("Set")).toBeTruthy());
    fireEvent.change(screen.getByLabelText("Set"), { target: { value: "curator-bank" } });
    fireEvent.click(screen.getByRole("button", { name: "Capture" }));

    await waitFor(() => {
      expect(screen.getByText(/Updated existing case/)).toBeTruthy();
    });
  });

  it("6. create-new-set path reveals slug/name inputs and sends createSet", async () => {
    const fetchMock = stubFetch();
    render(
      <CaptureCasePanel conversationId="conv-1" messages={twoExchangeMessages} exchangeCount={2} />,
    );

    fireEvent.click(screen.getByText("Capture as eval case"));
    await waitFor(() => expect(screen.getByLabelText("Set")).toBeTruthy());

    fireEvent.change(screen.getByLabelText("Set"), { target: { value: "__new__" } });
    expect(screen.getByLabelText("Set id")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Set id"), { target: { value: "new-slug" } });
    fireEvent.change(screen.getByLabelText("Set name"), { target: { value: "New Set" } });
    fireEvent.click(screen.getByRole("button", { name: "Capture" }));

    await waitFor(() => {
      expect(screen.getByText(/Created new case/)).toBeTruthy();
    });

    const call = fetchMock.mock.calls.find(([url]) =>
      String(url).includes("/eval/cases/from-session"),
    );
    const body = JSON.parse((call?.[1] as RequestInit).body as string);
    expect(body.setId).toBe("new-slug");
    expect(body.createSet).toEqual({ name: "New Set" });
    expect(body.caseId).toBeUndefined();
  });

  it("7. split picker changes the posted split", async () => {
    const fetchMock = stubFetch();
    render(
      <CaptureCasePanel conversationId="conv-1" messages={twoExchangeMessages} exchangeCount={2} />,
    );

    fireEvent.click(screen.getByText("Capture as eval case"));
    await waitFor(() => expect(screen.getByLabelText("Set")).toBeTruthy());

    fireEvent.change(screen.getByLabelText("Set"), { target: { value: "curator-bank" } });
    fireEvent.change(screen.getByLabelText("Split"), { target: { value: "dev" } });
    fireEvent.click(screen.getByRole("button", { name: "Capture" }));

    await waitFor(() => {
      expect(screen.getByText(/Created new case/)).toBeTruthy();
    });

    const call = fetchMock.mock.calls.find(([url]) =>
      String(url).includes("/eval/cases/from-session"),
    );
    const body = JSON.parse((call?.[1] as RequestInit).body as string);
    expect(body.split).toBe("dev");
  });

  it("8. expected textarea edit overrides the seeded answer in the posted body", async () => {
    const fetchMock = stubFetch();
    render(
      <CaptureCasePanel conversationId="conv-1" messages={twoExchangeMessages} exchangeCount={2} />,
    );

    fireEvent.click(screen.getByText("Capture as eval case"));
    await waitFor(() => expect(screen.getByLabelText("Set")).toBeTruthy());

    expect((screen.getByLabelText("Expected") as HTMLTextAreaElement).value).toBe("Berlin.");
    fireEvent.change(screen.getByLabelText("Expected"), { target: { value: "Edited answer" } });
    fireEvent.change(screen.getByLabelText("Set"), { target: { value: "curator-bank" } });
    fireEvent.click(screen.getByRole("button", { name: "Capture" }));

    await waitFor(() => {
      expect(screen.getByText(/Created new case/)).toBeTruthy();
    });

    const call = fetchMock.mock.calls.find(([url]) =>
      String(url).includes("/eval/cases/from-session"),
    );
    const body = JSON.parse((call?.[1] as RequestInit).body as string);
    expect(body.expected).toBe("Edited answer");
  });

  it("9. a thrown Error (404 w/ hint) renders the message inline in the error state", async () => {
    stubFetch({
      captureStatus: 404,
      captureBody: { error: "unknown set", hint: "create it first" },
    });
    render(
      <CaptureCasePanel conversationId="conv-1" messages={twoExchangeMessages} exchangeCount={2} />,
    );

    fireEvent.click(screen.getByText("Capture as eval case"));
    await waitFor(() => expect(screen.getByLabelText("Set")).toBeTruthy());
    fireEvent.change(screen.getByLabelText("Set"), { target: { value: "curator-bank" } });
    fireEvent.click(screen.getByRole("button", { name: "Capture" }));

    await waitFor(() => {
      expect(screen.getByText("unknown set — create it first")).toBeTruthy();
    });
    expect(screen.getByText("Capture another")).toBeTruthy();
  });

  it("10. latest exchange is the default selected option; snippets come from user turns", async () => {
    stubFetch();
    render(
      <CaptureCasePanel conversationId="conv-1" messages={twoExchangeMessages} exchangeCount={2} />,
    );

    fireEvent.click(screen.getByText("Capture as eval case"));
    await waitFor(() => expect(screen.getByLabelText("Exchange")).toBeTruthy());

    const exchangeSelect = screen.getByLabelText("Exchange") as HTMLSelectElement;
    expect(exchangeSelect.value).toBe("2");

    const options = Array.from(exchangeSelect.options).map((o) => o.text);
    expect(options[0]).toContain("What is the capital of France?");
    expect(options[1]).toContain("And Germany?");
  });
});

/**
 * ChatPage scope chip + editor (#268) — the header chip is fed by the CREATE
 * RESPONSE's echoed context, never the editor's draft text (the honesty rule
 * `ScopeChip`'s doc comment states); it renders "(no scope)" for a
 * hook-bearing agent whose effective context resolved to nothing, and is
 * absent entirely for a hook-less one (no `instantiation.available`).
 */
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatPage } from "../pages/ChatPage";

interface MockAgent {
  id: string;
  name: string;
  description: string;
  instantiation?: { available: boolean; defaults: Record<string, unknown> | null };
}

function sseBody(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "OK",
    json: async () => body,
  } as unknown as Response;
}

/** Routes the handful of endpoints ChatPage's mount + one send touch. */
function buildFetchRouter(opts: {
  agents: MockAgent[];
  createResponse: Record<string, unknown>;
}): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";

    if (url === "/agents" && method === "GET") return jsonResponse(opts.agents);
    if (url.startsWith("/admin/conversations")) return jsonResponse([]);
    if (url === "/conversations" && method === "POST") {
      return jsonResponse(opts.createResponse, 201);
    }
    if (/^\/conversations\/[^/]+\/messages$/.test(url) && method === "POST") {
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        body: sseBody(["event: done\ndata: {}\n\n"]),
      } as unknown as Response;
    }
    throw new Error(`unmocked fetch: ${method} ${url}`);
  }) as unknown as typeof fetch;
}

describe("ChatPage scope chip (#268)", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("renders the chip from the create response's echoed context after the first send — not the editor draft", async () => {
    vi.stubGlobal(
      "fetch",
      buildFetchRouter({
        agents: [
          {
            id: "a1",
            name: "Agent One",
            description: "",
            instantiation: { available: true, defaults: { tenant: "acme" } },
          },
        ],
        // The server's echo deliberately differs from `instantiateDefaults`
        // (an extra `region` key) — proves the chip reads the RESPONSE, not
        // the editor's seeded-from-defaults draft.
        createResponse: { id: "c1", agent_id: "a1", context: { tenant: "acme", region: "us" } },
      }),
    );

    const { getByPlaceholderText, getByRole, findByRole, container } = render(<ChatPage />);
    const textarea = await waitFor(() =>
      getByPlaceholderText((text) => text.startsWith("Message Agent One")),
    );

    // No conversation yet — the chip must not exist before the server has
    // confirmed anything (never guess at a pre-creation draft).
    expect(container.querySelector('button[title^="Scope this conversation"]')).toBeNull();

    fireEvent.change(textarea, { target: { value: "hello" } });
    fireEvent.click(getByRole("button", { name: "Send" }));

    const chip = await findByRole("button", { name: /^scope: tenant: acme, region: us$/ });
    expect(chip).not.toBeNull();

    // Full JSON on click (the popover) — carries BOTH echoed keys.
    fireEvent.click(chip);
    const pre = container.querySelector("pre");
    expect(pre?.textContent).toContain('"tenant": "acme"');
    expect(pre?.textContent).toContain('"region": "us"');
  });

  it('renders "(no scope)" for a hook-bearing agent whose effective context is null', async () => {
    vi.stubGlobal(
      "fetch",
      buildFetchRouter({
        agents: [
          {
            id: "a1",
            name: "Agent One",
            description: "",
            instantiation: { available: true, defaults: null },
          },
        ],
        createResponse: { id: "c1", agent_id: "a1", context: null },
      }),
    );

    const { getByPlaceholderText, getByRole, findByRole } = render(<ChatPage />);
    const textarea = await waitFor(() =>
      getByPlaceholderText((text) => text.startsWith("Message Agent One")),
    );
    fireEvent.change(textarea, { target: { value: "hello" } });
    fireEvent.click(getByRole("button", { name: "Send" }));

    const chip = await findByRole("button", { name: "scope: (no scope)" });
    expect(chip).not.toBeNull();
  });

  it("never renders for a hook-less agent (no instantiation.available), even after sending", async () => {
    vi.stubGlobal(
      "fetch",
      buildFetchRouter({
        agents: [{ id: "a1", name: "Agent One", description: "" }],
        createResponse: { id: "c1", agent_id: "a1" }, // no `context` key at all
      }),
    );

    const { getByPlaceholderText, getByRole, container } = render(<ChatPage />);
    const textarea = await waitFor(() =>
      getByPlaceholderText((text) => text.startsWith("Message Agent One")),
    );
    fireEvent.change(textarea, { target: { value: "hello" } });
    fireEvent.click(getByRole("button", { name: "Send" }));

    await waitFor(() => expect(container.textContent).toContain("hello"));
    expect(container.querySelector('button[title^="Scope this conversation"]')).toBeNull();
    // The "Scope context" editor affordance is likewise absent for this agent.
    expect(() => getByRole("button", { name: /^Scope context/ })).toThrow();
  });
});

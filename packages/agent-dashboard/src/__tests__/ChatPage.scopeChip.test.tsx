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

/** Routes the handful of endpoints ChatPage's mount + one send touch.
 *  `onCreateBody` (optional) captures the parsed `POST /conversations` body,
 *  when a test needs to assert on the REQUEST rather than just the response. */
function buildFetchRouter(opts: {
  agents: MockAgent[];
  createResponse: Record<string, unknown>;
  onCreateBody?: (body: unknown) => void;
}): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";

    if (url === "/agents" && method === "GET") return jsonResponse(opts.agents);
    if (url.startsWith("/admin/conversations")) return jsonResponse([]);
    if (url === "/conversations" && method === "POST") {
      opts.onCreateBody?.(init?.body ? JSON.parse(init.body as string) : undefined);
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

  it('renders "(no scope)" for a hook-bearing agent whose effective context is null, as a non-interactive pill (no popover to suppress)', async () => {
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

    const { getByPlaceholderText, getByRole, findByText } = render(<ChatPage />);
    const textarea = await waitFor(() =>
      getByPlaceholderText((text) => text.startsWith("Message Agent One")),
    );
    fireEvent.change(textarea, { target: { value: "hello" } });
    fireEvent.click(getByRole("button", { name: "Send" }));

    const chip = await findByText("scope: (no scope)");
    expect(chip).not.toBeNull();
    // A `null` context has no JSON worth a popover — this is a plain pill,
    // not a button (clicking it must not open an empty-object JsonBlock).
    expect(chip.closest("button")).toBeNull();
  });

  it("caps a long value and adds a +N tail when more than 2 scalar keys are present", async () => {
    const longToken = "a".repeat(60);
    vi.stubGlobal(
      "fetch",
      buildFetchRouter({
        agents: [
          {
            id: "a1",
            name: "Agent One",
            description: "",
            instantiation: { available: true, defaults: {} },
          },
        ],
        createResponse: {
          id: "c1",
          agent_id: "a1",
          context: { tenant: "acme", token: longToken, region: "us", tier: "gold", extra: "x" },
        },
      }),
    );

    const { getByPlaceholderText, getByRole, findByRole, container } = render(<ChatPage />);
    const textarea = await waitFor(() =>
      getByPlaceholderText((text) => text.startsWith("Message Agent One")),
    );
    fireEvent.change(textarea, { target: { value: "hello" } });
    fireEvent.click(getByRole("button", { name: "Send" }));

    // Only the first 2 scalar entries preview, the long value is truncated,
    // and a "+3" tail accounts for the 3 keys not shown (token/region/tier/
    // extra minus the 1 of those 4 folded into the shown pair... concretely:
    // 5 keys total, 2 shown → +3).
    const chip = await findByRole("button", { name: /^scope: tenant: acme, token: a{24}…\s\+3$/ });
    expect(chip).not.toBeNull();
    expect(chip.textContent?.length).toBeLessThan(60);

    // Full (untruncated) value is still one click away.
    fireEvent.click(chip);
    const pre = container.querySelector("pre");
    expect(pre?.textContent).toContain(`"token": "${longToken}"`);
  });

  it("shows the redaction line in the chip's popover when the server redacted a key", async () => {
    vi.stubGlobal(
      "fetch",
      buildFetchRouter({
        agents: [
          {
            id: "a1",
            name: "Agent One",
            description: "",
            instantiation: { available: true, defaults: {} },
          },
        ],
        createResponse: {
          id: "c1",
          agent_id: "a1",
          context: { tenant: "acme", userId: "[redacted]" },
          context_redacted: ["userId"],
        },
      }),
    );

    const { getByPlaceholderText, getByRole, findByRole, findByText } = render(<ChatPage />);
    const textarea = await waitFor(() =>
      getByPlaceholderText((text) => text.startsWith("Message Agent One")),
    );
    fireEvent.change(textarea, { target: { value: "hello" } });
    fireEvent.click(getByRole("button", { name: "Send" }));

    const chip = await findByRole("button", {
      name: /^scope: tenant: acme, userId: \[redacted\]$/,
    });
    fireEvent.click(chip);
    expect(await findByText("redacted: userId")).not.toBeNull();
  });

  it("locks the scope editor after the first message, then New Chat unlocks it and re-seeds the defaults (not the prior edit)", async () => {
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
        createResponse: { id: "c1", agent_id: "a1", context: { tenant: "other" } },
      }),
    );

    const { getByPlaceholderText, getByRole, findByText } = render(<ChatPage />);
    const textarea = await waitFor(() =>
      getByPlaceholderText((text) => text.startsWith("Message Agent One")),
    );

    // Expand the editor and make a genuine edit before the conversation exists.
    fireEvent.click(getByRole("button", { name: "Scope context" }));
    const editor = getByRole("textbox", { name: "Scope context" }) as HTMLTextAreaElement;
    expect(editor.value).toBe(JSON.stringify({ tenant: "acme" }, null, 2)); // seeded from defaults
    fireEvent.change(editor, { target: { value: '{"tenant":"other"}' } });

    fireEvent.change(textarea, { target: { value: "hello" } });
    fireEvent.click(getByRole("button", { name: "Send" }));

    // Locked: the panel (still expanded from the click above — its `expanded`
    // state persists across the re-render) swaps the textarea for the
    // read-only bound (server-echoed) context and the lock hint.
    await findByText(/Locked for this conversation/);
    expect(() => getByRole("textbox", { name: "Scope context" })).toThrow();

    // Collapse it — the collapsed affordance itself carries the "· locked" tell.
    fireEvent.click(getByRole("button", { name: "Close" }));
    getByRole("button", { name: "Scope context · locked" });

    // New Chat unlocks it — and re-seeds from defaults, NOT the prior "other" edit.
    fireEvent.click(getByRole("button", { name: "New Chat" }));
    fireEvent.click(getByRole("button", { name: "Scope context" }));
    const reseeded = (await waitFor(() =>
      getByRole("textbox", { name: "Scope context" }),
    )) as HTMLTextAreaElement;
    expect(reseeded.value).toBe(JSON.stringify({ tenant: "acme" }, null, 2));
  });

  it("omits `context` from the create request when the editor was never touched — the server resolves its own current defaults", async () => {
    let capturedBody: unknown;
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
        // Deliberately NOT `{ tenant: "acme" }` — the server, not this
        // client-side snapshot, resolved the effective context.
        createResponse: { id: "c1", agent_id: "a1", context: { tenant: "current-on-server" } },
        onCreateBody: (body) => {
          capturedBody = body;
        },
      }),
    );

    const { getByPlaceholderText, getByRole } = render(<ChatPage />);
    const textarea = await waitFor(() =>
      getByPlaceholderText((text) => text.startsWith("Message Agent One")),
    );
    // Never expand or touch the scope editor — send with it untouched.
    fireEvent.change(textarea, { target: { value: "hello" } });
    fireEvent.click(getByRole("button", { name: "Send" }));

    await waitFor(() => expect(capturedBody).toBeDefined());
    expect(capturedBody).toEqual({ agent_id: "a1" }); // no `context` key at all
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

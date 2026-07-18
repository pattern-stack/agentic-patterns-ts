/**
 * ChatPage typed scope form (#308 PR-2) — when `instantiation.schema` is
 * present, the scope editor renders TYPED ROWS folded from that schema
 * (`foldToolParams`) instead of the raw JSON textarea; presets (D7)
 * materialize CLIENT-side into row values; the wire body key is `context`
 * (the JSON-fallback editor's key all along — kept so the dashboard still
 * binds correctly against a published pre-#308 server, which reads only
 * `context` and would silently ignore an unknown `scope` key); a server 400
 * `{issues}` maps per-field onto rows. `ChatPage.scopeChip.test.tsx`
 * continues to pin the JSON-textarea fallback (schema-less agents) and the
 * tri-state untouched-omits-key contract — this file doesn't re-litigate
 * those, only the typed-form-specific behavior.
 */
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatPage } from "../pages/ChatPage";

interface MockAgent {
  id: string;
  name: string;
  description: string;
  instantiation?: {
    available: boolean;
    defaults: Record<string, unknown> | null;
    schema?: Record<string, unknown> | null;
    presets?: Record<string, Record<string, unknown>> | null;
  };
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
    statusText: status >= 200 && status < 300 ? "OK" : "Bad Request",
    json: async () => body,
  } as unknown as Response;
}

/** Routes the handful of endpoints ChatPage's mount + one send touch — the
 *  `ChatPage.scopeChip.test.tsx` precedent, widened with a configurable
 *  create status/body so the 400-issues test can drive a rejection. */
function buildFetchRouter(opts: {
  agents: MockAgent[];
  createResponse: Record<string, unknown>;
  createStatus?: number;
  onCreateBody?: (body: unknown) => void;
}): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";

    if (url === "/agents" && method === "GET") return jsonResponse(opts.agents);
    if (url.startsWith("/admin/conversations")) return jsonResponse([]);
    if (url === "/conversations" && method === "POST") {
      opts.onCreateBody?.(init?.body ? JSON.parse(init.body as string) : undefined);
      return jsonResponse(opts.createResponse, opts.createStatus ?? 201);
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

/** workspace-like scope (mirrors decisions.md D15's example agent): a
 *  required string, a required enum, an optional boolean. */
const WORKSPACE_SCHEMA = {
  type: "object",
  properties: {
    workspace: { type: "string", description: "Tenant workspace" },
    user: { type: "string", description: "Acting user" },
    region: { type: "string", enum: ["us", "eu"], description: "Data region" },
    admin: { type: "boolean", description: "Grant admin tools" },
  },
  required: ["workspace", "user", "region"],
};

const WORKSPACE_PRESETS = {
  "sam @ acme": { workspace: "acme-hq", user: "sam@acme.com", region: "us", admin: false },
  "li @ globex": { workspace: "globex-ops", user: "li@globex.dev", region: "eu", admin: true },
};

async function mountOnAgent(agent: MockAgent) {
  const utils = render(<ChatPage />);
  await waitFor(() => utils.getByPlaceholderText((t) => t.startsWith(`Message ${agent.name}`)));
  return utils;
}

/** No native `<select>` anywhere in the tree (playground-menus LD4). */
function hasNoNativeSelect(): boolean {
  return document.querySelectorAll("select").length === 0;
}

describe("ChatPage typed scope form (#308)", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("renders typed rows folded from instantiation.schema instead of the JSON textarea, seeded from defaults", async () => {
    const agent: MockAgent = {
      id: "a1",
      name: "Agent One",
      description: "",
      instantiation: {
        available: true,
        defaults: { workspace: "acme-hq" },
        schema: WORKSPACE_SCHEMA,
        presets: null,
      },
    };
    vi.stubGlobal(
      "fetch",
      buildFetchRouter({
        agents: [agent],
        createResponse: { id: "c1", agent_id: "a1", context: { workspace: "acme-hq" } },
      }),
    );

    const { getByRole, queryByRole, queryByLabelText } = await mountOnAgent(agent);
    fireEvent.click(getByRole("button", { name: "Scope" }));

    // Typed rows, not the JSON-textarea fallback.
    expect(queryByLabelText("Context (JSON)")).toBeNull();
    expect(queryByRole("textbox", { name: "Scope" })).toBeNull();

    const workspaceInput = getByRole("textbox", { name: "workspace" }) as HTMLInputElement;
    expect(workspaceInput.value).toBe("acme-hq"); // seeded from instantiation.defaults
    const userInput = getByRole("textbox", { name: "user" }) as HTMLInputElement;
    expect(userInput.value).toBe(""); // no declared default for this field

    // enum -> a DropdownMenu picker, never a native <select>.
    expect(hasNoNativeSelect()).toBe(true);
    const regionTrigger = getByRole("button", { name: "region" });
    expect(regionTrigger.textContent).toContain("Select…");

    // boolean -> checkbox.
    const adminCheckbox = getByRole("checkbox", { name: "admin" }) as HTMLInputElement;
    expect(adminCheckbox.checked).toBe(false);
  });

  it("assembles the POST body from typed row edits under the `context` key, and marks the draft touched", async () => {
    const agent: MockAgent = {
      id: "a1",
      name: "Agent One",
      description: "",
      instantiation: {
        available: true,
        defaults: { workspace: "acme-hq" },
        schema: WORKSPACE_SCHEMA,
        presets: null,
      },
    };
    let capturedBody: unknown;
    vi.stubGlobal(
      "fetch",
      buildFetchRouter({
        agents: [agent],
        createResponse: {
          id: "c1",
          agent_id: "a1",
          context: { workspace: "acme-hq", user: "sam@acme.com", region: "us" },
        },
        onCreateBody: (b) => {
          capturedBody = b;
        },
      }),
    );

    const { getByRole, getByPlaceholderText } = await mountOnAgent(agent);
    fireEvent.click(getByRole("button", { name: "Scope" }));

    fireEvent.change(getByRole("textbox", { name: "user" }), {
      target: { value: "sam@acme.com" },
    });
    const regionTrigger = getByRole("button", { name: "region" });
    fireEvent.click(regionTrigger);
    fireEvent.click(getByRole("menuitemradio", { name: "us" }));

    const textarea = getByPlaceholderText((t) => t.startsWith("Message Agent One"));
    fireEvent.change(textarea, { target: { value: "hello" } });
    fireEvent.click(getByRole("button", { name: "Send" }));

    await waitFor(() => expect(capturedBody).toBeDefined());
    expect(capturedBody).toEqual({
      agent_id: "a1",
      context: { workspace: "acme-hq", user: "sam@acme.com", region: "us", admin: false },
    });
  });

  it("seeds ALL rows from a picked preset and marks the draft touched", async () => {
    const agent: MockAgent = {
      id: "a1",
      name: "Agent One",
      description: "",
      instantiation: {
        available: true,
        defaults: { workspace: "acme-hq" },
        schema: WORKSPACE_SCHEMA,
        presets: WORKSPACE_PRESETS,
      },
    };
    let capturedBody: unknown;
    vi.stubGlobal(
      "fetch",
      buildFetchRouter({
        agents: [agent],
        createResponse: {
          id: "c1",
          agent_id: "a1",
          context: WORKSPACE_PRESETS["li @ globex"],
        },
        onCreateBody: (b) => {
          capturedBody = b;
        },
      }),
    );

    const { getByRole, getByPlaceholderText } = await mountOnAgent(agent);
    fireEvent.click(getByRole("button", { name: "Scope" }));

    fireEvent.click(getByRole("button", { name: "Preset ▾" }));
    fireEvent.click(getByRole("menuitem", { name: "li @ globex" }));

    const workspaceInput = getByRole("textbox", { name: "workspace" }) as HTMLInputElement;
    expect(workspaceInput.value).toBe("globex-ops");
    const userInput = getByRole("textbox", { name: "user" }) as HTMLInputElement;
    expect(userInput.value).toBe("li@globex.dev");
    const adminCheckbox = getByRole("checkbox", { name: "admin" }) as HTMLInputElement;
    expect(adminCheckbox.checked).toBe(true);

    const textarea = getByPlaceholderText((t) => t.startsWith("Message Agent One"));
    fireEvent.change(textarea, { target: { value: "hello" } });
    fireEvent.click(getByRole("button", { name: "Send" }));

    await waitFor(() => expect(capturedBody).toBeDefined());
    expect(capturedBody).toEqual({
      agent_id: "a1",
      context: WORKSPACE_PRESETS["li @ globex"],
    });
  });

  it("omits the `context` key entirely when the typed form was never touched", async () => {
    const agent: MockAgent = {
      id: "a1",
      name: "Agent One",
      description: "",
      instantiation: {
        available: true,
        defaults: { workspace: "acme-hq" },
        schema: WORKSPACE_SCHEMA,
        presets: null,
      },
    };
    let capturedBody: unknown;
    vi.stubGlobal(
      "fetch",
      buildFetchRouter({
        agents: [agent],
        createResponse: { id: "c1", agent_id: "a1", context: { workspace: "current-on-server" } },
        onCreateBody: (b) => {
          capturedBody = b;
        },
      }),
    );

    const { getByRole, getByPlaceholderText } = await mountOnAgent(agent);
    // Never open the panel or touch a row.
    const textarea = getByPlaceholderText((t) => t.startsWith("Message Agent One"));
    fireEvent.change(textarea, { target: { value: "hello" } });
    fireEvent.click(getByRole("button", { name: "Send" }));

    await waitFor(() => expect(capturedBody).toBeDefined());
    expect(capturedBody).toEqual({ agent_id: "a1" }); // no `context` key at all
  });

  it("maps a server 400 {issues} per-field onto rows, and unmatched issues into the panel footer", async () => {
    const agent: MockAgent = {
      id: "a1",
      name: "Agent One",
      description: "",
      instantiation: {
        available: true,
        defaults: { workspace: "acme-hq" },
        schema: WORKSPACE_SCHEMA,
        presets: null,
      },
    };
    vi.stubGlobal(
      "fetch",
      buildFetchRouter({
        agents: [agent],
        createResponse: {
          error: "scope validation failed",
          issues: [
            { path: ["user"], message: "Invalid email" },
            { path: [], message: "scope must be an object" },
          ],
        },
        createStatus: 400,
      }),
    );

    const { getByRole, getByPlaceholderText, findByText } = await mountOnAgent(agent);
    fireEvent.click(getByRole("button", { name: "Scope" }));
    fireEvent.change(getByRole("textbox", { name: "user" }), { target: { value: "not-an-email" } });

    const textarea = getByPlaceholderText((t) => t.startsWith("Message Agent One"));
    fireEvent.change(textarea, { target: { value: "hello" } });
    fireEvent.click(getByRole("button", { name: "Send" }));

    // Per-field error under the `user` row.
    await findByText("Invalid email");
    // Unmatched (empty-path) issue surfaces in the footer instead of being dropped.
    await findByText("scope must be an object");
    // The trigger carries the same "· invalid" tell the JSON fallback uses.
    getByRole("button", { name: "Scope · invalid" });
  });

  it("falls back to the JSON textarea for a schema-less agent (instantiation.schema absent)", async () => {
    const agent: MockAgent = {
      id: "a1",
      name: "Agent One",
      description: "",
      instantiation: { available: true, defaults: { tenant: "acme" } }, // no `schema`
    };
    vi.stubGlobal(
      "fetch",
      buildFetchRouter({
        agents: [agent],
        createResponse: { id: "c1", agent_id: "a1", context: { tenant: "acme" } },
      }),
    );

    const { getByRole } = await mountOnAgent(agent);
    fireEvent.click(getByRole("button", { name: "Scope" }));
    const editor = getByRole("textbox", { name: "Scope" }) as HTMLTextAreaElement;
    expect(editor.value).toBe(JSON.stringify({ tenant: "acme" }, null, 2));
  });
});

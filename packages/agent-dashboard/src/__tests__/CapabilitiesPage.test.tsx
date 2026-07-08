/**
 * CapabilitiesPage detail view (`/capabilities/:id`) — the capability detail
 * page that replaced the Tool Workbench's all-capabilities tree. Pins three
 * things:
 *   - the enriched `CapabilityDetail` client shape (manual TOC/sections,
 *     playbook plays with description + paramsSchema, used-by links) renders
 *     correctly — the fixture below is typed as `CapabilityDetail`, so a
 *     drift in `api/composition.ts`'s types fails `tsc`, not just this test;
 *   - a sectioned manual's TOC row expands on click to reveal the section's
 *     full content (progressive disclosure, at the UI layer);
 *   - `?tool=<name>` deep-links straight into an expanded tool row, and a
 *     click expands any other tool independently.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CapabilityDetail } from "../api/composition";
import { CapabilitiesPage } from "../pages/build/CapabilitiesPage";

function mkFetchResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    json: async () => body,
  };
}

function stubFetch(detail: CapabilityDetail) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith(`/capabilities/${detail.id}`)) return mkFetchResponse(200, detail);
      return mkFetchResponse(404, { error: "unhandled in test" });
    }),
  );
}

function renderDetail(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/capabilities/:id" element={<CapabilitiesPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("CapabilitiesPage detail — enriched client shape", () => {
  const detail: CapabilityDetail = {
    id: "toolsmith-utilities",
    name: "toolsmith-utilities",
    description: "Deterministic string, date, and vector utilities.",
    toolbox: {
      name: "toolsmith_utilities",
      description: "Small string/date/vector utilities",
      tools: [
        {
          name: "slugify",
          description: "Turn text into a URL-safe slug",
          parameters: {
            type: "object",
            properties: { text: { type: "string", description: "Text to slugify" } },
            required: ["text"],
          },
        },
      ],
    },
    manual: {
      name: "Toolsmith Manual",
      description: "How to use the utilities",
      kind: "sectioned",
      sections: [
        {
          name: "Vocabulary",
          description: "Key terms",
          content: "## Vocabulary\n\n- **slug**: a URL-safe string",
          itemCount: 1,
        },
        {
          name: "Workflows",
          description: "Standard steps",
          content: "## Workflows\n\n- **slugify-first**: always slugify before storing",
          itemCount: 1,
        },
      ],
    },
    playbook: {
      name: "toolsmith-plays",
      description: "Named toolsmith plays",
      plays: [
        {
          name: "run_all",
          description: "Run every utility once",
          paramsSchema: { type: "object", properties: { text: { type: "string" } } },
        },
      ],
    },
    usedBy: { roles: ["toolsmith-role"], agents: ["toolsmith-agent"] },
    sharesToolboxWith: [],
  };

  it("renders header, used-by links, manual TOC, and playbook plays from the typed shape", async () => {
    stubFetch(detail);
    renderDetail("/capabilities/toolsmith-utilities");

    await screen.findByText(detail.description);

    // used-by up-chain, restored from the pre-workbench detail view.
    expect(screen.getByRole("link", { name: "toolsmith-role" }).getAttribute("href")).toBe(
      "/roles/toolsmith-role",
    );
    expect(screen.getByRole("link", { name: "toolsmith-agent" }).getAttribute("href")).toBe(
      "/agents/toolsmith-agent",
    );

    // manual TOC — section name + description visible; full content is NOT
    // (it only reveals on expand, pinned by the next describe block).
    expect(screen.getByText("Vocabulary")).toBeTruthy();
    expect(screen.getByText("Key terms")).toBeTruthy();
    expect(screen.queryByText(/always slugify before storing/)).toBeNull();

    // playbook — play name + description + paramsSchema (JsonBlock dump).
    expect(screen.getByText("run_all")).toBeTruthy();
    expect(screen.getByText("Run every utility once")).toBeTruthy();
    expect(screen.getByText(/"text"/)).toBeTruthy();
  });
});

describe("CapabilitiesPage detail — manual TOC expand", () => {
  const detail: CapabilityDetail = {
    id: "research",
    name: "Research",
    description: "Search and cite sources",
    toolbox: { name: "research-tools", description: "", tools: [] },
    manual: {
      name: "Research Manual",
      description: "How to search and cite",
      kind: "sectioned",
      sections: [
        {
          name: "Workflows",
          description: "Standard research steps",
          content: "search-then-cite: search first, then cite the source verbatim",
          itemCount: 1,
        },
      ],
    },
    playbook: null,
    usedBy: { roles: [], agents: [] },
    sharesToolboxWith: [],
  };

  it("expands a section's row on click to reveal its full content", async () => {
    stubFetch(detail);
    renderDetail("/capabilities/research");

    await screen.findByText("Workflows");
    expect(screen.queryByText(/search first, then cite/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Workflows/ }));

    expect(await screen.findByText(/search first, then cite/)).toBeTruthy();
  });

  it("shows an honest empty note when no manual is attached", async () => {
    stubFetch({ ...detail, manual: null });
    renderDetail("/capabilities/research");

    expect(await screen.findByText("No manual attached.")).toBeTruthy();
    // The progressive-disclosure demo degrades honestly too, not silently.
    expect(screen.getByText(/nothing to progressively disclose/)).toBeTruthy();
  });
});

describe("CapabilitiesPage detail — tools section deep-link", () => {
  const detail: CapabilityDetail = {
    id: "toolsmith-utilities",
    name: "toolsmith-utilities",
    description: "Deterministic utilities",
    toolbox: {
      name: "toolsmith_utilities",
      description: "",
      tools: [
        {
          name: "slugify",
          description: "Turn text into a URL-safe slug",
          parameters: {
            type: "object",
            properties: { text: { type: "string" } },
            required: ["text"],
          },
        },
        {
          name: "date_diff",
          description: "Count whole days between two ISO dates",
          parameters: {
            type: "object",
            properties: { from: { type: "string" }, to: { type: "string" } },
            required: ["from", "to"],
          },
          returns: { type: "object", properties: { days: { type: "number" } } },
        },
      ],
    },
    manual: null,
    playbook: null,
    usedBy: { roles: [], agents: [] },
    sharesToolboxWith: [],
  };

  it("expands the tool named by ?tool= without a click, leaving the other collapsed", async () => {
    stubFetch(detail);
    renderDetail("/capabilities/toolsmith-utilities?tool=date_diff");

    // date_diff's params are visible immediately (deep-linked expansion).
    expect(await screen.findByText("from")).toBeTruthy();
    expect(screen.getByText("to")).toBeTruthy();
    // slugify stays collapsed — its param isn't rendered yet.
    expect(screen.queryByText("text")).toBeNull();
  });

  it("expands a different tool independently on click", async () => {
    stubFetch(detail);
    renderDetail("/capabilities/toolsmith-utilities?tool=date_diff");

    await screen.findByText("from");
    fireEvent.click(screen.getByRole("button", { name: /slugify/ }));

    expect(await screen.findByText("text")).toBeTruthy();
    // date_diff is still expanded too — expansion is independent per row.
    expect(screen.getByText("from")).toBeTruthy();
  });

  it("collapses a tool row again on a second click", async () => {
    stubFetch(detail);
    renderDetail("/capabilities/toolsmith-utilities");

    const toggle = await screen.findByRole("button", { name: /slugify/ });
    fireEvent.click(toggle);
    expect(await screen.findByText("text")).toBeTruthy();

    fireEvent.click(toggle);
    expect(screen.queryByText("text")).toBeNull();
  });
});

describe("CapabilitiesPage detail — loading/error states", () => {
  it("renders an error card when the fetch fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => mkFetchResponse(404, { error: "Capability not found" })),
    );
    renderDetail("/capabilities/nope");

    expect(await screen.findByText(/HTTP 404/)).toBeTruthy();
  });
});

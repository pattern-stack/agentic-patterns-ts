import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DashboardStats } from "../api/types";
import { DashboardPage } from "../pages/DashboardPage";

// Matches the shape the server returns from GET /admin/dashboard
// (runtime DashboardStats).
const sample: DashboardStats = {
  agents: [
    {
      agentName: "agent-1",
      status: "idle",
      totalIterations: 3,
      totalToolCalls: 2,
      totalInputTokens: 100,
      totalOutputTokens: 50,
      totalErrors: 0,
      toolStats: [],
    },
    {
      agentName: "agent-2",
      status: "running",
      totalIterations: 1,
      totalToolCalls: 0,
      totalInputTokens: 200,
      totalOutputTokens: 75,
      totalErrors: 1,
      toolStats: [],
    },
  ],
  activeAgentCount: 1,
  totalTokensUsed: 425,
  totalToolCalls: 2,
  totalErrors: 1,
  activeConversationCount: 1,
  uptimeMs: 60_000,
};

describe("DashboardPage", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => sample,
      })),
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("renders the headline stat cards from the canonical DashboardStats shape", async () => {
    render(<DashboardPage />);
    // Initial "Loading..." state
    expect(screen.getByText(/Loading/i)).toBeTruthy();

    await waitFor(() => {
      expect(screen.getByText("Dashboard")).toBeTruthy();
    });

    // One active agent, one active conversation — confirms the page reads
    // activeAgentCount / activeConversationCount (new schema), not the old
    // agentCount / conversationCount fields.
    expect(screen.getByText("Active Agents")).toBeTruthy();
    expect(screen.getByText("Conversations")).toBeTruthy();
    // Tokens In = 300 (100 + 200), Tokens Out = 125 (50 + 75).
    expect(screen.getByText("300")).toBeTruthy();
    expect(screen.getByText("125")).toBeTruthy();
    // totalErrors = 1 → rendered with red accent.
    expect(screen.getByText("Errors")).toBeTruthy();
  });
});

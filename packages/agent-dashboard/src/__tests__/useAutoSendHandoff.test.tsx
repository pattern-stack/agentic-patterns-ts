/**
 * useAutoSendHandoff — the router half of the quick-action "exactly once"
 * guarantee (`/actions` Run → chat).
 *
 * The prompt must be delivered ONCE and then be gone from history, so that a
 * refresh (which restores `history.state`) or a Back into the same entry can
 * never re-run a token-spending agent action. Here that is asserted as: after
 * the hook consumes it, the location carries no state left to consume — a
 * fresh consumer mounted on the same entry gets nothing.
 */
import { cleanup, render, waitFor } from "@testing-library/react";
import { useState } from "react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoSendHandoff } from "../hooks/useAutoSendHandoff";

const PROMPT = "Run the morning brief.";

/** Renders the hook's value plus the live location state, so a test can watch
 *  both the delivery and the burn. `remountKey` forces a fresh mount of the
 *  consumer on the SAME history entry — the refresh/Back stand-in. */
function Harness({ remountKey }: { remountKey: number }) {
  return (
    <Routes>
      <Route path="/chat/:agentId" element={<Consumer key={remountKey} />} />
    </Routes>
  );
}

function Consumer() {
  const prompt = useAutoSendHandoff();
  const location = useLocation();
  return (
    <div>
      <div data-testid="prompt">{prompt ?? "(none)"}</div>
      <div data-testid="state">{JSON.stringify(location.state)}</div>
    </div>
  );
}

describe("useAutoSendHandoff", () => {
  afterEach(cleanup);

  it("delivers the prompt once, then burns it from the history entry", async () => {
    const { getByTestId } = render(
      <MemoryRouter initialEntries={[{ pathname: "/chat/a1", state: { autoSend: PROMPT } }]}>
        <Harness remountKey={0} />
      </MemoryRouter>,
    );

    expect(getByTestId("prompt").textContent).toBe(PROMPT);
    // The entry's state is rewritten to null — nothing left for a reload to
    // replay. The hook's own return value deliberately stays put.
    await waitFor(() => expect(getByTestId("state").textContent).toBe("null"));
    expect(getByTestId("prompt").textContent).toBe(PROMPT);
  });

  it("a remount on the burned entry (refresh / Back) gets nothing", async () => {
    function Rerunner() {
      const [key, setKey] = useState(0);
      return (
        <MemoryRouter initialEntries={[{ pathname: "/chat/a1", state: { autoSend: PROMPT } }]}>
          <button type="button" onClick={() => setKey((k) => k + 1)}>
            remount
          </button>
          <Harness remountKey={key} />
        </MemoryRouter>
      );
    }
    const { getByTestId, getByRole } = render(<Rerunner />);
    await waitFor(() => expect(getByTestId("state").textContent).toBe("null"));

    getByRole("button", { name: "remount" }).click();

    await waitFor(() => expect(getByTestId("prompt").textContent).toBe("(none)"));
  });

  it("returns null when the navigation carried no hand-off at all", () => {
    const { getByTestId } = render(
      <MemoryRouter initialEntries={["/chat/a1"]}>
        <Harness remountKey={0} />
      </MemoryRouter>,
    );
    expect(getByTestId("prompt").textContent).toBe("(none)");
  });
});

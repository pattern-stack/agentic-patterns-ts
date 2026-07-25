/**
 * AppShell responsive behavior — the F2 viewport-driven nav drawer + mobile
 * app bar. Pins:
 *   - desktop (no matchMedia stub → jsdom default) stays byte-identical,
 *     including the `apdash-nav-collapsed` density toggle;
 *   - the `--appbar-h` / `--shell-pad-y` CSS-var contract on `<main>` across
 *     desktop / narrow-tablet / phone bands (downstream pages depend on the
 *     exact names/values);
 *   - the mobile drawer opens/closes (hamburger, close button, scrim, Esc,
 *     route change) and never touches the `apdash-nav-collapsed` key.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppShell, navGroups } from "../components/templates/AppShell";
import { __resetMediaQueryCacheForTests } from "../hooks/useMediaQuery";

/** Stubs `window.matchMedia` so `useBreakpoint` reports the band for `width`.
 * Adjust the regex to F1's actual query shape if it changes — today
 * `maxWidthQuery` (`ui/breakpoints.ts`) only emits max-width queries. */
function stubViewport(width: number) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => {
      const maxWidthMatch = query.match(/max-width:\s*(\d+(?:\.\d+)?)px/);
      const minWidthMatch = query.match(/min-width:\s*(\d+(?:\.\d+)?)px/);
      let matches = true;
      if (maxWidthMatch?.[1]) matches &&= width <= Number(maxWidthMatch[1]);
      if (minWidthMatch?.[1]) matches &&= width >= Number(minWidthMatch[1]);
      return {
        matches,
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      } as unknown as MediaQueryList;
    }),
  );
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
  __resetMediaQueryCacheForTests();
});

function renderShell(initialEntries: string[] = ["/"]) {
  return render(
    <MemoryRouter initialEntries={initialEntries}>
      <AppShell>
        <div>page body</div>
      </AppShell>
    </MemoryRouter>,
  );
}

const totalNavLinks = navGroups.reduce((n, g) => n + g.items.length, 0);

describe("AppShell — desktop (no matchMedia stub)", () => {
  it("renders the sidebar with the collapse toggle; no mobile app bar", () => {
    renderShell();
    expect(screen.getByLabelText("Collapse navigation")).toBeTruthy();
    expect(screen.queryByLabelText("Open navigation")).toBeNull();
  });

  it("publishes --shell-pad-y: 24px and --appbar-h: 0px on <main>", () => {
    renderShell();
    const main = document.querySelector("main");
    expect(main).toBeTruthy();
    expect(main?.style.getPropertyValue("--shell-pad-y")).toBe("24px");
    expect(main?.style.getPropertyValue("--appbar-h")).toBe("0px");
  });

  it("collapse toggle persists apdash-nav-collapsed unchanged (guard rail)", () => {
    renderShell();
    fireEvent.click(screen.getByLabelText("Collapse navigation"));
    expect(screen.queryByText("Roles")).toBeNull();
    expect(localStorage.getItem("apdash-nav-collapsed")).toBe("1");
  });
});

describe("AppShell — narrow tablet (800px)", () => {
  it("renders the mobile app bar; no sidebar collapse control; no drawer yet", () => {
    stubViewport(800);
    renderShell();
    expect(screen.getByLabelText("Open navigation")).toBeTruthy();
    expect(screen.getByText("Agentic Patterns")).toBeTruthy();
    expect(screen.queryByLabelText("Collapse navigation")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("publishes --appbar-h: 48px and --shell-pad-y: 24px (tablet keeps 24)", () => {
    stubViewport(800);
    renderShell();
    const main = document.querySelector("main");
    expect(main?.style.getPropertyValue("--appbar-h")).toBe("48px");
    expect(main?.style.getPropertyValue("--shell-pad-y")).toBe("24px");
  });
});

describe("AppShell — phone (400px)", () => {
  it("publishes --shell-pad-y: 12px", () => {
    stubViewport(400);
    renderShell();
    const main = document.querySelector("main");
    expect(main?.style.getPropertyValue("--shell-pad-y")).toBe("12px");
  });
});

describe("AppShell — mobile drawer interactions", () => {
  it("opens on hamburger click and lists every navGroups link; closes on the close button", () => {
    stubViewport(800);
    renderShell();
    fireEvent.click(screen.getByLabelText("Open navigation"));

    const dialog = screen.getByRole("dialog", { name: "Navigation" });
    expect(dialog).toBeTruthy();
    for (const group of navGroups) {
      for (const item of group.items) {
        expect(screen.getByRole("link", { name: item.label })).toBeTruthy();
      }
    }
    expect(screen.getAllByRole("link")).toHaveLength(totalNavLinks);

    fireEvent.click(screen.getByLabelText("Close navigation"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("closes on scrim click", () => {
    stubViewport(800);
    renderShell();
    fireEvent.click(screen.getByLabelText("Open navigation"));
    const dialog = screen.getByRole("dialog", { name: "Navigation" });
    const scrim = dialog.parentElement;
    expect(scrim).toBeTruthy();
    if (scrim) fireEvent.click(scrim);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("closes on Escape", () => {
    stubViewport(800);
    renderShell();
    fireEvent.click(screen.getByLabelText("Open navigation"));
    expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("closes on route change, including a click on the current route's link", () => {
    stubViewport(800);
    renderShell(["/tools"]);
    fireEvent.click(screen.getByLabelText("Open navigation"));
    expect(screen.getByRole("dialog")).toBeTruthy();

    fireEvent.click(screen.getByRole("link", { name: "Roles" }));
    expect(screen.queryByRole("dialog")).toBeNull();

    // Reopen and click the link for the CURRENT route (pathname unchanged —
    // the route-change effect alone would miss this; onClose on the NavLink covers it).
    fireEvent.click(screen.getByLabelText("Open navigation"));
    expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.click(screen.getByRole("link", { name: "Roles" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("never touches apdash-nav-collapsed via the drawer path", () => {
    stubViewport(800);
    const spy = vi.spyOn(Storage.prototype, "setItem");
    renderShell();

    fireEvent.click(screen.getByLabelText("Open navigation"));
    fireEvent.click(screen.getByLabelText("Close navigation"));
    fireEvent.click(screen.getByLabelText("Open navigation"));
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.click(screen.getByLabelText("Open navigation"));
    fireEvent.click(screen.getByRole("link", { name: "Roles" }));

    for (const call of spy.mock.calls) {
      expect(call[0]).not.toBe("apdash-nav-collapsed");
    }
  });
});

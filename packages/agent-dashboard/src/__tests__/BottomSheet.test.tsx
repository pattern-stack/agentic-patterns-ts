/**
 * BottomSheet — portal render, the three close paths (button, Esc, scrim),
 * scroll-lock, `maxHeightPct`, plus `ConsoleRail`'s side/sheet mode branch and
 * `Modal`'s phone-branch CSS values. `createPortal` renders into
 * `document.body`, so assertions use `screen` (document-scoped), not the
 * render container.
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConsoleRail } from "../components/ConsoleRail";
import { Modal } from "../components/atoms/Modal";
import { BottomSheet } from "../components/kit/BottomSheet";
import { __resetMediaQueryCacheForTests } from "../hooks/useMediaQuery";
import { maxWidthQuery } from "../ui/breakpoints";

const stubMatchMedia = (matches: (query: string) => boolean) => {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: matches(query),
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  __resetMediaQueryCacheForTests();
});

describe("BottomSheet", () => {
  it("renders the title and children via a portal", () => {
    const { container } = render(
      <BottomSheet title="My Sheet" onClose={() => {}}>
        <div>sheet content</div>
      </BottomSheet>,
    );
    expect(screen.getByRole("dialog", { name: "My Sheet" })).toBeTruthy();
    expect(screen.getByText("sheet content")).toBeTruthy();
    expect(container.firstChild).toBeNull();
  });

  it("closes on Escape", () => {
    const onClose = vi.fn();
    render(
      <BottomSheet title="T" onClose={onClose}>
        x
      </BottomSheet>,
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on scrim click but not on panel click, and via the ✕ button", () => {
    const onClose = vi.fn();
    render(
      <BottomSheet title="Panel" onClose={onClose}>
        x
      </BottomSheet>,
    );
    // Clicking the panel (the dialog) must NOT close.
    fireEvent.click(screen.getByRole("dialog", { name: "Panel" }));
    expect(onClose).not.toHaveBeenCalled();

    // Clicking the scrim (the dialog's parent) closes.
    const scrim = screen.getByRole("dialog").parentElement as HTMLElement;
    fireEvent.click(scrim);
    expect(onClose).toHaveBeenCalledTimes(1);

    onClose.mockClear();
    fireEvent.click(screen.getByLabelText("Close"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("locks body scroll while mounted and restores it on unmount", () => {
    const prevOverflow = document.body.style.overflow;
    const { unmount } = render(
      <BottomSheet title="T" onClose={() => {}}>
        x
      </BottomSheet>,
    );
    expect(document.body.style.overflow).toBe("hidden");
    unmount();
    expect(document.body.style.overflow).toBe(prevOverflow);
  });

  it("defaults maxHeightPct to 75vh and honors an override", () => {
    const { rerender } = render(
      <BottomSheet title="T" onClose={() => {}}>
        x
      </BottomSheet>,
    );
    expect(screen.getByRole("dialog").style.maxHeight).toBe("75vh");

    rerender(
      <BottomSheet title="T" onClose={() => {}} maxHeightPct={50}>
        x
      </BottomSheet>,
    );
    expect(screen.getByRole("dialog").style.maxHeight).toBe("50vh");
  });
});

describe("ConsoleRail — side vs sheet mode", () => {
  const tabs = [
    { value: "a", label: "A" },
    { value: "b", label: "B" },
  ];

  it("side mode (default) renders the fixed aside with a collapse button, no dialog", () => {
    render(
      <ConsoleRail open tab="a" onToggle={() => {}} onTab={() => {}} tabs={tabs}>
        <div>body</div>
      </ConsoleRail>,
    );
    expect(screen.getByLabelText("Collapse panel")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("sheet mode + open renders a BottomSheet dialog with the tab strip inside", () => {
    const onToggle = vi.fn();
    render(
      <ConsoleRail open onToggle={onToggle} tab="a" onTab={() => {}} tabs={tabs} mode="sheet">
        <div>body</div>
      </ConsoleRail>,
    );
    const dialog = screen.getByRole("dialog", { name: "Console" });
    expect(dialog).toBeTruthy();
    expect(screen.getByRole("tablist", { name: "Side panel" })).toBeTruthy();
    expect(screen.getByText("body")).toBeTruthy();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("sheet mode + closed renders nothing — no dialog and no reopen strip", () => {
    render(
      <ConsoleRail
        open={false}
        onToggle={() => {}}
        tab="a"
        onTab={() => {}}
        tabs={tabs}
        mode="sheet"
      >
        <div>body</div>
      </ConsoleRail>,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByLabelText("Show panel")).toBeNull();
  });
});

describe("Modal — phone branch", () => {
  it("uses desktop CSS values by default (no matchMedia stub)", () => {
    render(
      <Modal title="T" onClose={() => {}}>
        x
      </Modal>,
    );
    const dialog = screen.getByRole("dialog", { name: "T" });
    expect(dialog.style.maxWidth).toBe("520px");
    const backdrop = dialog.parentElement as HTMLElement;
    expect(backdrop.style.padding).toBe("8vh 16px 16px");
  });

  it("switches to the phone CSS values when matchMedia reports a phone viewport", () => {
    stubMatchMedia((q) => q === maxWidthQuery("sm") || q === maxWidthQuery("md"));
    render(
      <Modal title="T" onClose={() => {}}>
        x
      </Modal>,
    );
    const dialog = screen.getByRole("dialog", { name: "T" });
    expect(dialog.style.maxWidth).toBe("100%");
    const backdrop = dialog.parentElement as HTMLElement;
    expect(backdrop.style.padding.startsWith("12px")).toBe(true);
  });
});

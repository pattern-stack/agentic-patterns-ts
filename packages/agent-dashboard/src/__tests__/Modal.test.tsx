/**
 * Modal atom — portal render + the three close paths (button, Esc, backdrop)
 * and the panel-click no-op. `createPortal` renders into `document.body`, so
 * assertions use `screen` (document-scoped), not the render container.
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Modal } from "../components/atoms/Modal";

afterEach(cleanup);

describe("Modal", () => {
  it("renders the title and children into a dialog", () => {
    render(
      <Modal title="My Dialog" onClose={() => {}}>
        <div>body content</div>
      </Modal>,
    );
    expect(screen.getByRole("dialog", { name: "My Dialog" })).toBeTruthy();
    expect(screen.getByText("body content")).toBeTruthy();
  });

  it("closes via the ✕ button", () => {
    const onClose = vi.fn();
    render(
      <Modal title="T" onClose={onClose}>
        x
      </Modal>,
    );
    fireEvent.click(screen.getByLabelText("Close"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on Escape", () => {
    const onClose = vi.fn();
    render(
      <Modal title="T" onClose={onClose}>
        x
      </Modal>,
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on backdrop click but not on panel click", () => {
    const onClose = vi.fn();
    render(
      <Modal title="Panel" onClose={onClose}>
        x
      </Modal>,
    );
    // Clicking the panel (the dialog) must NOT close.
    fireEvent.click(screen.getByRole("dialog", { name: "Panel" }));
    expect(onClose).not.toHaveBeenCalled();

    // Clicking the backdrop (the dialog's offset parent) closes.
    const backdrop = screen.getByRole("dialog").parentElement as HTMLElement;
    fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

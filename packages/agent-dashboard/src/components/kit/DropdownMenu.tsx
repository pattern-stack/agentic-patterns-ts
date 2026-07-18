/**
 * DropdownMenu — the backdrop(z25) + right-anchored panel(z30) pattern
 * (port-map §7.2), built now so S6's RunPickerMenu and S8's SessionsMenu share
 * one implementation instead of hand-rolling the pattern twice more (it was
 * already about to be copy-pasted a second time — swe-brain's
 * `LiveRunSurface.tsx` RunPickerMenu and `AgentConsoleSurface.tsx`
 * SessionsMenu are near-identical). No consumer lands in THIS slice; `open`
 * state is owned here so callers just supply a trigger renderer + the panel
 * content.
 *
 * playground-menus round 1 (LD1) — THE single popover primitive for every
 * menu on /chat. Gained two things every caller needed but couldn't get
 * without diverging: a `placement` prop (LD3 — viewport-bounded, flips up
 * instead of always rendering downward off-screen) and a `close` handle
 * (passed to `trigger` always, and to `children` when given as a render
 * prop) so a menu can dismiss itself on selection instead of hand-rolling its
 * own open/backdrop/panel (see `CopyChatMenu` in ChatPage.tsx, folded back
 * into this primitive now that `close` exists).
 */
import { useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { T } from "../../ui/tokens";

/** "auto" (default) opens downward and flips up when the panel would cross
 *  the viewport's bottom edge; "top"/"bottom" pin the placement regardless
 *  of available space. */
export type DropdownPlacement = "bottom" | "top" | "auto";

export interface DropdownMenuProps {
  /** Renders the trigger; receives the open state, a toggle callback, and a
   *  close callback (for triggers that need to close without toggling, e.g.
   *  after acting on the open state). */
  trigger: (state: { open: boolean; toggle: () => void; close: () => void }) => ReactNode;
  /** Render-prop form lets a menu close itself on select (CopyChatMenu). */
  children: ReactNode | ((api: { close: () => void }) => ReactNode);
  align?: "left" | "right";
  placement?: DropdownPlacement;
  width?: number;
  maxHeight?: number;
}

export function DropdownMenu({
  trigger,
  children,
  align = "right",
  placement = "auto",
  width = 300,
  maxHeight = 360,
}: DropdownMenuProps) {
  const [open, setOpen] = useState(false);
  const [flip, setFlip] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const toggle = () => setOpen((v) => !v);
  const close = () => setOpen(false);

  // LD3 — decide up-vs-down before paint (useLayoutEffect, not useEffect) so
  // there's no visible jump: the panel always renders on first frame in its
  // final position. "auto" measures the actual panel height against the
  // space below the trigger and flips when it would cross the viewport's
  // bottom edge (and there's more room above than below); "top"/"bottom"
  // pin the placement outright.
  useLayoutEffect(() => {
    if (!open) return;
    if (placement === "top") {
      setFlip(true);
      return;
    }
    if (placement === "bottom") {
      setFlip(false);
      return;
    }
    const wrapperEl = wrapperRef.current;
    const panelEl = panelRef.current;
    if (!wrapperEl || !panelEl) return;
    const wrapperRect = wrapperEl.getBoundingClientRect();
    const spaceBelow = window.innerHeight - wrapperRect.bottom;
    const spaceAbove = wrapperRect.top;
    setFlip(spaceBelow < panelEl.offsetHeight + 6 && spaceAbove > spaceBelow);
  }, [open, placement]);

  return (
    <div ref={wrapperRef} style={{ position: "relative", display: "inline-block" }}>
      {trigger({ open, toggle, close })}
      {open && (
        <>
          {/* full-screen transparent backdrop — click anywhere outside the panel to dismiss */}
          <button
            type="button"
            aria-label="Close menu"
            onClick={close}
            style={{
              position: "fixed",
              inset: 0,
              background: "transparent",
              border: "none",
              cursor: "default",
              zIndex: 25,
            }}
          />
          <div
            ref={panelRef}
            style={{
              position: "absolute",
              [align]: 0,
              ...(flip ? { bottom: "calc(100% + 6px)" } : { top: "calc(100% + 6px)" }),
              width,
              maxHeight,
              overflowY: "auto",
              zIndex: 30,
              background: "var(--paper)",
              border: "1px solid var(--line)",
              borderRadius: T.radius.md,
              boxShadow: T.shadow.s3,
            }}
          >
            {typeof children === "function" ? children({ close }) : children}
          </div>
        </>
      )}
    </div>
  );
}

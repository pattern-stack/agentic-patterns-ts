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
 *
 * PORTALED overlay (nested-menus fix): the backdrop + panel render into
 * `document.body` via `createPortal`, positioned `fixed` from the trigger's
 * rect. Rendering the panel inline (`position:absolute` inside the wrapper)
 * broke the FIRST nested consumer — ScopeEnumPicker inside the Scope panel's
 * own DropdownMenu — two ways at once: the parent panel's `overflowY:auto`
 * CLIPPED the child menu, and the child's full-screen backdrop mounted inside
 * the parent's stacking context, painting over the parent's own controls
 * (its Close button became unreachable and the page read as dead). Portaled,
 * each overlay lives in the root stacking context; a nested menu mounts
 * later in the body, so its backdrop stacks above and dismissal order is
 * inner-then-outer by construction. Position re-derives on window scroll
 * (capture — inner scrollables too) and resize while open.
 */
import { useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
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
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const toggle = () => setOpen((v) => !v);
  const close = () => setOpen(false);

  // Anchor the fixed overlay to the trigger's viewport rect, and keep it
  // anchored while open: scroll uses capture so a scrollable ancestor (e.g. a
  // parent panel's overflowY) re-anchors the child menu too.
  useLayoutEffect(() => {
    if (!open) {
      setAnchor(null);
      return;
    }
    const measure = () => {
      const wrapperEl = wrapperRef.current;
      if (wrapperEl) setAnchor(wrapperEl.getBoundingClientRect());
    };
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [open]);

  // LD3 — decide up-vs-down before paint (useLayoutEffect, not useEffect) so
  // there's no visible jump: the panel always renders on first frame in its
  // final position. "auto" measures the actual panel height against the
  // space below the trigger and flips when it would cross the viewport's
  // bottom edge (and there's more room above than below); "top"/"bottom"
  // pin the placement outright.
  useLayoutEffect(() => {
    if (!open || !anchor) return;
    if (placement === "top") {
      setFlip(true);
      return;
    }
    if (placement === "bottom") {
      setFlip(false);
      return;
    }
    const panelEl = panelRef.current;
    if (!panelEl) return;
    const spaceBelow = window.innerHeight - anchor.bottom;
    const spaceAbove = anchor.top;
    setFlip(spaceBelow < panelEl.offsetHeight + 6 && spaceAbove > spaceBelow);
  }, [open, placement, anchor]);

  return (
    <div ref={wrapperRef} style={{ position: "relative", display: "inline-block" }}>
      {trigger({ open, toggle, close })}
      {open &&
        anchor &&
        createPortal(
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
                position: "fixed",
                ...(align === "right"
                  ? { right: Math.max(0, window.innerWidth - anchor.right) }
                  : { left: Math.max(0, anchor.left) }),
                ...(flip
                  ? { bottom: window.innerHeight - anchor.top + 6 }
                  : { top: anchor.bottom + 6 }),
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
          </>,
          document.body,
        )}
    </div>
  );
}

/**
 * DropdownMenu — the backdrop(z25) + right-anchored panel(z30) pattern
 * (port-map §7.2), built now so S6's RunPickerMenu and S8's SessionsMenu share
 * one implementation instead of hand-rolling the pattern twice more (it was
 * already about to be copy-pasted a second time — swe-brain's
 * `LiveRunSurface.tsx` RunPickerMenu and `AgentConsoleSurface.tsx`
 * SessionsMenu are near-identical). No consumer lands in THIS slice; `open`
 * state is owned here so callers just supply a trigger renderer + the panel
 * content.
 */
import { useState } from "react";
import type { ReactNode } from "react";
import { T } from "../../ui/tokens";

export interface DropdownMenuProps {
  /** Renders the trigger; receives the open state + a toggle callback. */
  trigger: (state: { open: boolean; toggle: () => void }) => ReactNode;
  children: ReactNode;
  align?: "left" | "right";
  width?: number;
  maxHeight?: number;
}

export function DropdownMenu({
  trigger,
  children,
  align = "right",
  width = 300,
  maxHeight = 360,
}: DropdownMenuProps) {
  const [open, setOpen] = useState(false);
  const toggle = () => setOpen((v) => !v);

  return (
    <div style={{ position: "relative", display: "inline-block" }}>
      {trigger({ open, toggle })}
      {open && (
        <>
          {/* full-screen transparent backdrop — click anywhere outside the panel to dismiss */}
          <button
            type="button"
            aria-label="Close menu"
            onClick={() => setOpen(false)}
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
            style={{
              position: "absolute",
              [align]: 0,
              top: "calc(100% + 6px)",
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
            {children}
          </div>
        </>
      )}
    </div>
  );
}

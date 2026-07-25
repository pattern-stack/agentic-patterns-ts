/**
 * BottomSheet — a portalled, bottom-anchored overlay primitive that mirrors
 * `Modal`'s overlay discipline (Esc close, backdrop click, body-scroll-lock,
 * focus-on-mount, `role="dialog"`) but anchors to the bottom edge, full-width,
 * with top-rounded corners and its own scrolling body. This is the reusable
 * "rail → sheet" shape: rail-bearing pages render this instead of a
 * fixed-width aside once the viewport drops below the narrow breakpoint.
 * `BottomSheet` itself is presentation-only — it does not read
 * `useBreakpoint()`; callers decide when to render it.
 */

import { type ReactNode, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { Button } from "../atoms/Button";

export interface BottomSheetProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** Max sheet height as % of viewport height. Default 75. */
  maxHeightPct?: number;
}

export function BottomSheet({ title, onClose, children, maxHeightPct = 75 }: BottomSheetProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    panelRef.current?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);

  return createPortal(
    // biome-ignore lint/a11y/useKeyWithClickEvents: Esc close is handled document-wide in the effect; the backdrop is a supplementary pointer affordance.
    <div
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      style={{
        position: "fixed",
        inset: 0,
        background: "color-mix(in oklch, var(--ink) 45%, transparent)",
        display: "flex",
        alignItems: "flex-end",
        justifyContent: "center",
        zIndex: 1000,
      }}
    >
      <div
        ref={panelRef}
        // biome-ignore lint/a11y/useSemanticElements: a portalled overlay dialog — the native <dialog> top-layer/::backdrop conflicts with the custom backdrop + createPortal target here.
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        style={{
          width: "100%",
          maxHeight: `${maxHeightPct}vh`,
          display: "flex",
          flexDirection: "column",
          minHeight: 0,
          background: "var(--paper)",
          border: "1px solid var(--line)",
          borderBottom: "none",
          borderRadius: "var(--radius-lg) var(--radius-lg) 0 0",
          boxShadow: "var(--shadow-3)",
          outline: "none",
          overflow: "hidden",
        }}
      >
        <header
          style={{
            flex: "none",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "10px 14px",
            borderBottom: "1px solid var(--line)",
          }}
        >
          <div style={{ fontSize: 15, fontWeight: 600 }}>{title}</div>
          <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close">
            ✕
          </Button>
        </header>
        {/* Own scroll body — the sheet scrolls, not the page. */}
        <div
          style={{
            flex: 1,
            minHeight: 0,
            overflowY: "auto",
            display: "flex",
            flexDirection: "column",
          }}
        >
          {children}
        </div>
      </div>
    </div>,
    document.body,
  );
}

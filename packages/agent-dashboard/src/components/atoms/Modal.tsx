/**
 * Modal atom — a portalled, centered dialog over a dimmed backdrop.
 *
 * The dashboard had no modal primitive; this is the minimal one the eval
 * editors (WI-5) need. Closes on Esc and backdrop click, locks body scroll
 * while open, focuses the panel on mount, and stamps `role="dialog"` +
 * `aria-modal`. No new deps — `createPortal` + `Card`/`Button` + CSS vars.
 */

import { type ReactNode, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { Button } from "./Button";

interface ModalProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** Optional footer row (e.g. Save/Cancel actions), right-aligned. */
  footer?: ReactNode;
}

export function Modal({ title, onClose, children, footer }: ModalProps) {
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
        alignItems: "flex-start",
        justifyContent: "center",
        padding: "8vh 16px 16px",
        zIndex: 1000,
        overflowY: "auto",
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
          background: "var(--paper)",
          border: "1px solid var(--line)",
          borderRadius: "var(--radius-lg)",
          width: "100%",
          maxWidth: 520,
          outline: "none",
          boxShadow: "var(--shadow-3)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "14px 18px",
            borderBottom: "1px solid var(--line)",
          }}
        >
          <div style={{ fontSize: 15, fontWeight: 600 }}>{title}</div>
          <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close">
            ✕
          </Button>
        </div>
        <div style={{ padding: 18, display: "flex", flexDirection: "column", gap: 12 }}>
          {children}
        </div>
        {footer && (
          <div
            style={{
              display: "flex",
              justifyContent: "flex-end",
              gap: 8,
              padding: "12px 18px",
              borderTop: "1px solid var(--line)",
            }}
          >
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

/**
 * MobileNavDrawer — portalled left-anchored overlay nav for viewports below
 * md (900px — see ../../ui/breakpoints.ts). Reuses AppShell's navGroups so
 * sidebar and drawer can never drift. Follows the Modal atom's portal/Esc/
 * scroll-lock pattern (components/atoms/Modal.tsx).
 *
 * ThemeToggle is deliberately omitted here — it lives in AppShell's mobile
 * app bar instead.
 */
import { X } from "lucide-react";
import { useEffect } from "react";
import { createPortal } from "react-dom";
import { NavLink } from "react-router-dom";
import { navGroups } from "./AppShell";

interface MobileNavDrawerProps {
  open: boolean;
  onClose: () => void;
}

export function MobileNavDrawer({ open, onClose }: MobileNavDrawerProps) {
  // Esc + body scroll lock — Modal.tsx lines 25-37 pattern, gated on `open`.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    // biome-ignore lint/a11y/useKeyWithClickEvents: Esc close is handled document-wide in the effect; the scrim is a supplementary pointer affordance.
    <div
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        background: "color-mix(in oklch, var(--ink) 45%, transparent)",
      }}
    >
      <div
        // biome-ignore lint/a11y/useSemanticElements: a portalled overlay dialog — the native <dialog> top-layer/::backdrop conflicts with the custom scrim + createPortal target here.
        role="dialog"
        aria-modal="true"
        aria-label="Navigation"
        tabIndex={-1}
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          bottom: 0,
          width: "min(280px, 85vw)",
          display: "flex",
          flexDirection: "column",
          background: "var(--fill)",
          borderRight: "1px solid var(--border)",
          padding: "20px 0",
          overflowY: "auto",
          animation: "apdash-drawer-in 160ms ease-out",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "0 12px 24px 20px",
          }}
        >
          <span
            style={{
              fontSize: 15,
              fontWeight: 600,
              color: "var(--ink)",
              letterSpacing: "-0.01em",
            }}
          >
            Agentic Patterns
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close navigation"
            style={{
              appearance: "none",
              width: 22,
              height: 22,
              border: "1px solid var(--border)",
              borderRadius: 6,
              background: "var(--paper)",
              color: "var(--ink-3)",
              cursor: "pointer",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
            }}
          >
            <X size={14} />
          </button>
        </div>
        {navGroups.map((group) => (
          <div key={group.heading} style={{ marginBottom: 12 }}>
            <div
              style={{
                padding: "4px 20px",
                fontSize: 11,
                fontWeight: 600,
                textTransform: "uppercase",
                letterSpacing: "0.08em",
                color: "var(--ink-3)",
              }}
            >
              {group.heading}
            </div>
            {group.items.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                onClick={onClose}
                style={({ isActive }) => ({
                  display: "block",
                  padding: "8px 20px",
                  fontSize: 14,
                  color: isActive ? "var(--ink)" : "var(--ink-2)",
                  background: isActive ? "var(--fill-2)" : "transparent",
                  borderLeft: isActive ? "2px solid var(--accent)" : "2px solid transparent",
                  textDecoration: "none",
                })}
              >
                {item.label}
              </NavLink>
            ))}
          </div>
        ))}
      </div>
    </div>,
    document.body,
  );
}

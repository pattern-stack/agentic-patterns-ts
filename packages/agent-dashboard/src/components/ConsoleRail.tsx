/**
 * ConsoleRail — the chat Console's right-hand panel SHELL. One cohesive,
 * full-height bordered surface that owns the tab strip (Tools / Trace /
 * Scratchpad) as its header and a single flex body slot the active tab fills.
 *
 * Before this, each tab component drew its OWN `<aside>` (border + width +
 * `flex: none`), and `ChatPage` floated a separate `Segmented` pill above them
 * with a gap plus a mid-height collapse toggle. Because the asides were
 * `flex: none`, they hugged their content instead of filling the column — so a
 * short panel left a tall dead strip below it (the "cut off / floating" look)
 * and a long trace grew the whole panel past the viewport instead of scrolling
 * inside it. This shell fixes both structurally: it stretches to the row height
 * (`align-self` from the parent flex row) and hands its body a bounded
 * `flex: 1; min-height: 0` box, so each tab's inner `overflow-y: auto` finally
 * has a height to scroll against. Tabs render as borderless fills inside it.
 *
 * `mode="sheet"` renders the tab strip + body inside a `BottomSheet` instead
 * of the fixed-width aside, with no reopen strip — the host page supplies its
 * own trigger to flip `open`. See `docs/adr` / the F3 spec for the contract.
 */
import type { ReactNode } from "react";
import { BottomSheet } from "./kit/BottomSheet";
import { Segmented, type SegmentedOption } from "./kit/Segmented";

export interface ConsoleRailProps<V extends string> {
  open: boolean;
  onToggle: () => void;
  tab: V;
  onTab: (v: V) => void;
  tabs: SegmentedOption<V>[];
  /** The active tab's content — rendered borderless into the scroll body slot. */
  children: ReactNode;
  /** Panel width when open. Side mode only — ignored in "sheet" mode. */
  width?: number;
  /** "side" (default) = current fixed-width aside. "sheet" = render inside BottomSheet. */
  mode?: "side" | "sheet";
}

export function ConsoleRail<V extends string>({
  open,
  onToggle,
  tab,
  onTab,
  tabs,
  children,
  width = 328,
  mode = "side",
}: ConsoleRailProps<V>) {
  const activeLabel = tabs.find((t) => t.value === tab)?.label;

  if (mode === "sheet") {
    if (!open) return null; // No reopen strip — the host page supplies its own trigger.
    return (
      <BottomSheet title="Console" onClose={onToggle}>
        <div style={{ flex: "none", padding: "7px 8px", borderBottom: "1px solid var(--line)" }}>
          <Segmented
            options={tabs}
            value={tab}
            onChange={onTab}
            size="sm"
            aria-label="Side panel"
          />
        </div>
        <div
          role="tabpanel"
          aria-label={typeof activeLabel === "string" ? activeLabel : undefined}
          style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}
        >
          {children}
        </div>
      </BottomSheet>
    );
  }

  // Collapsed → a slim full-height reopen strip, flush against the chat column
  // (no floating mid-height button). Stretches via the parent flex row.
  if (!open) {
    return (
      <button
        type="button"
        onClick={onToggle}
        title="Show panel"
        aria-label="Show panel"
        style={{
          flex: "none",
          alignSelf: "stretch",
          width: 22,
          border: "1px solid var(--line)",
          borderRadius: "var(--radius-lg)",
          background: "var(--paper)",
          color: "var(--mute)",
          cursor: "pointer",
          fontSize: "var(--fz-small)",
          lineHeight: 1,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        ‹
      </button>
    );
  }

  return (
    <aside
      style={{
        flex: "none",
        alignSelf: "stretch",
        width,
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        background: "var(--paper)",
        border: "1px solid var(--line)",
        borderRadius: "var(--radius-lg)",
        overflow: "hidden",
      }}
    >
      <header
        style={{
          flex: "none",
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "7px 6px 7px 8px",
          borderBottom: "1px solid var(--line)",
        }}
      >
        <Segmented options={tabs} value={tab} onChange={onTab} size="sm" aria-label="Side panel" />
        <div style={{ flex: 1 }} />
        <button
          type="button"
          onClick={onToggle}
          title="Collapse panel"
          aria-label="Collapse panel"
          style={{
            flex: "none",
            width: 22,
            height: 22,
            border: "none",
            borderRadius: "var(--radius-sm)",
            background: "transparent",
            color: "var(--mute)",
            cursor: "pointer",
            fontSize: "var(--fz-small)",
            lineHeight: 1,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          ›
        </button>
      </header>
      {/* Body slot: bounded height so the active tab's own inner scroll works.
          Labeled as the tabpanel for the Segmented tablist in the header. */}
      <div
        role="tabpanel"
        aria-label={typeof activeLabel === "string" ? activeLabel : undefined}
        style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}
      >
        {children}
      </div>
    </aside>
  );
}

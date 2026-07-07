/**
 * Field — the shared page kit's labeled-form-control wrapper (port-map §7.2).
 * Replaces the near-identical `Field`/`LauncherField` locals hand-copied
 * across CaptureCasePanel, CaseEditModal, SetEditModal, and RunLaunchForm, and
 * pairs with `inputStyle` below (the same `selectStyle`/`inputStyle` const
 * duplicated in those same four files).
 */
import type { CSSProperties, ReactNode } from "react";
import { T } from "../../ui/tokens";

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: `children` is the form control, nested inside this label for association.
    <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span
        style={{
          fontSize: T.fz.micro,
          fontWeight: 600,
          color: "var(--mute)",
          textTransform: "uppercase",
          letterSpacing: "0.05em",
        }}
      >
        {label}
      </span>
      {children}
    </label>
  );
}

/** Shared text input / select / textarea chrome. */
export const inputStyle: CSSProperties = {
  background: "var(--fill)",
  border: "1px solid var(--line)",
  color: "var(--ink)",
  borderRadius: T.radius.sm,
  padding: "7px 9px",
  fontFamily: "inherit",
  fontSize: T.fz.md,
};

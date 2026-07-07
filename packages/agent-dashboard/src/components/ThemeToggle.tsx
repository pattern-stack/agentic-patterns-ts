/**
 * Theme picker — family (Blue / Earth / Chalk) × mode (System / Light /
 * Dark). The six concrete themes resolve from the {family, mode} pair
 * (ui/theme-mode.ts); a single compact trigger + the kit DropdownMenu panel
 * keeps this small in the AppShell sidebar.
 */
import { Check, ChevronDown } from "lucide-react";
import { useState } from "react";
import {
  type ThemeFamily,
  type ThemePreference,
  type ThemeSubMode,
  getPreference,
  setPreference,
} from "../ui/theme-mode";
import { T } from "../ui/tokens";
import { DropdownMenu, Segmented } from "./kit";

const FAMILIES: { value: ThemeFamily; label: string }[] = [
  { value: "blue", label: "Blue" },
  { value: "earth", label: "Earth" },
  { value: "chalk", label: "Chalk" },
];

const MODES: { value: ThemeSubMode; label: string; title: string }[] = [
  { value: "system", label: "System", title: "Follow the OS setting" },
  { value: "light", label: "Light", title: "Force light mode" },
  { value: "dark", label: "Dark", title: "Force dark mode" },
];

export function ThemeToggle() {
  const [pref, setPrefState] = useState<ThemePreference>(getPreference());

  const update = (next: ThemePreference) => {
    setPreference(next);
    setPrefState(next);
  };

  const familyLabel = FAMILIES.find((f) => f.value === pref.family)?.label ?? pref.family;
  const modeLabel = MODES.find((m) => m.value === pref.mode)?.label ?? pref.mode;

  return (
    <DropdownMenu
      align="left"
      width={200}
      trigger={({ open, toggle }) => (
        <button
          type="button"
          onClick={toggle}
          aria-label="Theme"
          aria-expanded={open}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            width: "100%",
            padding: "6px 10px",
            fontSize: T.fz.tiny,
            fontFamily: "inherit",
            color: "var(--ink-2)",
            background: "var(--background)",
            border: "1px solid var(--border)",
            borderRadius: T.radius.md,
            cursor: "pointer",
          }}
        >
          <span style={{ flex: 1, textAlign: "left" }}>
            {familyLabel} · {modeLabel}
          </span>
          <ChevronDown size={12} />
        </button>
      )}
    >
      <div style={{ padding: 10, display: "flex", flexDirection: "column", gap: 10 }}>
        <div>
          <div
            style={{
              fontSize: T.fz.micro,
              fontWeight: 600,
              textTransform: "uppercase",
              letterSpacing: "0.06em",
              color: "var(--ink-3)",
              marginBottom: 6,
            }}
          >
            Family
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            {FAMILIES.map((f) => {
              const active = f.value === pref.family;
              return (
                <button
                  key={f.value}
                  type="button"
                  aria-pressed={active}
                  onClick={() => update({ ...pref, family: f.value })}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    padding: "6px 8px",
                    fontSize: T.fz.small,
                    fontFamily: "inherit",
                    border: "none",
                    borderRadius: T.radius.sm,
                    cursor: "pointer",
                    background: active ? "var(--accent-soft)" : "transparent",
                    color: active ? "var(--accent-ink)" : "var(--ink)",
                    textAlign: "left",
                  }}
                >
                  {f.label}
                  {active && <Check size={12} />}
                </button>
              );
            })}
          </div>
        </div>
        <div>
          <div
            style={{
              fontSize: T.fz.micro,
              fontWeight: 600,
              textTransform: "uppercase",
              letterSpacing: "0.06em",
              color: "var(--ink-3)",
              marginBottom: 6,
            }}
          >
            Mode
          </div>
          <Segmented
            aria-label="Theme mode"
            fullWidth
            size="sm"
            value={pref.mode}
            onChange={(mode) => update({ ...pref, mode })}
            options={MODES}
          />
        </div>
      </div>
    </DropdownMenu>
  );
}

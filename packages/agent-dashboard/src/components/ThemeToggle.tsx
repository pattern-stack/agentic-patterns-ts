/** Compact light / dark / system theme switch (self-contained, token-styled). */
import { Monitor, Moon, Sun } from "lucide-react";
import { useState } from "react";
import { type ThemeMode, getMode, setMode } from "../ui/theme-mode";

const OPTIONS: { value: ThemeMode; Icon: typeof Monitor; label: string }[] = [
  { value: "system", Icon: Monitor, label: "System" },
  { value: "light", Icon: Sun, label: "Light" },
  { value: "dark", Icon: Moon, label: "Dark" },
];

export function ThemeToggle() {
  const [mode, setModeState] = useState<ThemeMode>(getMode());
  return (
    <div
      aria-label="Theme"
      style={{
        display: "inline-flex",
        gap: 2,
        padding: 2,
        background: "var(--bg-inset)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius-md)",
      }}
    >
      {OPTIONS.map(({ value, Icon, label }) => {
        const active = mode === value;
        return (
          <button
            key={value}
            type="button"
            aria-label={label}
            aria-pressed={active}
            title={label}
            onClick={() => {
              setMode(value);
              setModeState(value);
            }}
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: 26,
              height: 22,
              cursor: "pointer",
              border: "none",
              borderRadius: "var(--radius-sm)",
              background: active ? "var(--accent)" : "transparent",
              color: active ? "var(--paper)" : "var(--fg-muted)",
              transition: "background var(--motion-fast) var(--ease-out)",
            }}
          >
            <Icon size={13} />
          </button>
        );
      })}
    </div>
  );
}

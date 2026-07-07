/**
 * Button atom — rewritten on cockpit tokens (port-map §7.1). `primary` moved
 * from a solid `--accent` fill + hardcoded `#0d1117` text to the soft-tint
 * style already used by `ui/atoms.tsx`'s cockpit Button (`--accent-soft` bg +
 * `--accent-ink` text) — the kill-list's prescribed fix, and the reason the
 * two atom sets can now fold into one (`ui/atoms.tsx` re-exports this file).
 * `default` is new (folded in from the cockpit set); hover states live in
 * `styles/atoms.css` via the `--btn-*` custom properties set below, since
 * inline styles can't express `:hover`.
 */

import type { ButtonHTMLAttributes, CSSProperties } from "react";
import { T } from "../../ui/tokens";

export type ButtonVariant = "primary" | "default" | "ghost";
export type ButtonSize = "sm" | "md";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

const VARIANT_VARS: Record<ButtonVariant, CSSProperties> = {
  primary: {
    "--btn-bg": "var(--accent-soft)",
    "--btn-bg-hover": "color-mix(in oklch, var(--accent) 24%, var(--paper))",
    "--btn-fg": "var(--accent-ink)",
    "--btn-border": "color-mix(in oklch, var(--accent) 30%, var(--line))",
  } as CSSProperties,
  default: {
    "--btn-bg": "var(--fill)",
    "--btn-bg-hover": "var(--fill-2)",
    "--btn-fg": "var(--ink)",
    "--btn-border": "var(--line)",
  } as CSSProperties,
  ghost: {
    "--btn-bg": "transparent",
    "--btn-bg-hover": "var(--fill)",
    "--btn-fg": "var(--ink-2)",
    "--btn-border": "var(--line)",
  } as CSSProperties,
};

export function Button({
  variant = "primary",
  size = "md",
  disabled,
  style,
  type,
  className,
  children,
  ...rest
}: ButtonProps) {
  const sizeStyles =
    size === "sm"
      ? { padding: "4px 10px", fontSize: T.fz.small }
      : { padding: "8px 16px", fontSize: T.fz.md };

  return (
    <button
      type={type ?? "button"}
      disabled={disabled}
      className={["ap-btn", className].filter(Boolean).join(" ")}
      style={{
        fontFamily: "inherit",
        fontWeight: 600,
        borderRadius: T.radius.md,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1,
        transition: "background 80ms ease, border-color 80ms ease",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 6,
        border: "1px solid var(--btn-border)",
        ...sizeStyles,
        ...VARIANT_VARS[variant],
        ...style,
      }}
      {...rest}
    >
      {children}
    </button>
  );
}

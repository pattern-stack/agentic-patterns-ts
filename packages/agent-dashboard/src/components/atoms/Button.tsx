/**
 * Minimal button atom — inline-style implementation matching the
 * dashboard's existing approach (no Tailwind). `variant` toggles between
 * filled primary and ghost secondary styling; `disabled` halves opacity.
 */

import type { ButtonHTMLAttributes } from "react";

export type ButtonVariant = "primary" | "ghost";
export type ButtonSize = "sm" | "md";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

export function Button({
  variant = "primary",
  size = "md",
  disabled,
  style,
  type,
  children,
  ...rest
}: ButtonProps) {
  const base = {
    fontFamily: "inherit",
    fontWeight: 500,
    borderRadius: 6,
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.5 : 1,
    transition: "background 80ms ease, border-color 80ms ease",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
  } as const;

  const sizeStyles =
    size === "sm" ? { padding: "4px 10px", fontSize: 12 } : { padding: "8px 14px", fontSize: 13 };

  const variantStyles =
    variant === "primary"
      ? {
          background: "var(--accent)",
          color: "#0d1117",
          border: "1px solid var(--accent)",
        }
      : {
          background: "var(--bg-surface)",
          color: "var(--fg-default)",
          border: "1px solid var(--border)",
        };

  return (
    <button
      type={type ?? "button"}
      disabled={disabled}
      style={{ ...base, ...sizeStyles, ...variantStyles, ...style }}
      {...rest}
    >
      {children}
    </button>
  );
}

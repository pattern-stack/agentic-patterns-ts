/**
 * Card atom — surface container with consistent padding / border / radius.
 * Used wherever a bordered panel is needed (stat cards, chat panel,
 * data tables). Prefer this over ad-hoc inline surface styling.
 */

import type { CSSProperties, HTMLAttributes, ReactNode } from "react";

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
  padded?: boolean;
  inset?: boolean;
}

export function Card({ children, padded = true, inset = false, style, ...rest }: CardProps) {
  const base: CSSProperties = {
    background: inset ? "var(--bg-inset)" : "var(--bg-surface)",
    border: `1px solid ${inset ? "var(--border-muted)" : "var(--border)"}`,
    borderRadius: 8,
    padding: padded ? 20 : 0,
  };
  return (
    <div style={{ ...base, ...style }} {...rest}>
      {children}
    </div>
  );
}

/**
 * Card atom — surface container, rewritten on cockpit tokens (port-map §7.1).
 * Default surface moved from the legacy admin bridge's filled-surface alias
 * (`--fill` today) to `--paper` — the cockpit's standard raised-card tone
 * already used by RunSurfacePage / NodeInspector / ConstellationNode, so
 * every BUILD/EVAL card now matches the RUN surfaces it sits next to.
 * `inset` keeps its recessed-panel meaning (canvas-toned, softer border).
 * When rendered with an `onClick`, wears `.ap-card--interactive` so
 * `styles/atoms.css` can give it a CSS (not JS) hover state.
 */

import type { CSSProperties, HTMLAttributes, ReactNode } from "react";
import { T } from "../../ui/tokens";

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
  padded?: boolean;
  inset?: boolean;
}

export function Card({
  children,
  padded = true,
  inset = false,
  style,
  className,
  onClick,
  ...rest
}: CardProps) {
  const interactive = Boolean(onClick);
  const surface = inset ? "var(--background)" : "var(--paper)";
  const base: CSSProperties = {
    border: `1px solid ${inset ? "var(--line-2)" : "var(--line)"}`,
    borderRadius: T.radius.lg,
    padding: padded ? 20 : 0,
    // When interactive, the resting background comes from the `--card-bg`
    // custom property (read by the `.ap-card--interactive` class below) so
    // `:hover` — a plain CSS class rule — can out-specificity it. A direct
    // inline `background` would always win over `:hover`, same as `Button`.
    ...(interactive ? ({ "--card-bg": surface } as CSSProperties) : { background: surface }),
  };
  return (
    <div
      className={[interactive ? "ap-card--interactive" : null, className].filter(Boolean).join(" ")}
      style={{ ...base, ...style }}
      onClick={onClick}
      {...rest}
    >
      {children}
    </div>
  );
}

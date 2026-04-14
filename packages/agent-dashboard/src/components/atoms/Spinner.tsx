/**
 * Spinner atom — CSS-only rotating arc.
 *
 * Mirrors chat-patterns' streaming indicator. A single variant here
 * (later we can add "pulse" / "heartbeat" escalation for long running
 * operations as chat-patterns does), sized via `size` prop.
 */

import type { CSSProperties } from "react";

interface SpinnerProps {
  size?: number;
  color?: string;
  thickness?: number;
  style?: CSSProperties;
}

export function Spinner({
  size = 14,
  color = "var(--accent-emerald)",
  thickness = 2,
  style,
}: SpinnerProps) {
  return (
    <span
      role="status"
      aria-label="Loading"
      style={{
        display: "inline-block",
        width: size,
        height: size,
        borderRadius: "50%",
        border: `${thickness}px solid ${color}`,
        borderTopColor: "transparent",
        borderRightColor: "transparent",
        animation: "apdash-spin 0.9s linear infinite",
        verticalAlign: "middle",
        ...style,
      }}
    />
  );
}

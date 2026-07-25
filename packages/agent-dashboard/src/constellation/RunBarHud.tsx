/**
 * The Live Run HUD pill (the slim status chrome over the canvas). Live dot +
 * phase + iter + elapsed + tokens. Read-only status, so a plain styled div (the
 * trace panel is the accessible record). Reuses the global `pulseDot` keyframe.
 */
import type { Frame } from "../graph/constellation-model";
import { T } from "../ui/tokens";

const DOT = 8;

function fmtMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

function Meta({ children }: { children: string }) {
  return (
    <span style={{ fontFamily: T.font.mono, fontSize: T.fz.micro, color: "var(--ink-2)" }}>
      {children}
    </span>
  );
}

export function RunBarHud({ hud }: { hud: Frame["hud"] }) {
  const { phase, iter, maxIter, elapsedMs, tokensIn, tokensOut, running, done } = hud;
  const dotColor = done ? T.tone.ok.color : running ? "var(--accent)" : "var(--mute)";

  return (
    <div
      style={{
        position: "absolute",
        top: "var(--space-3)",
        left: "var(--space-3)",
        display: "inline-flex",
        alignItems: "center",
        gap: "var(--space-3)",
        flexWrap: "wrap",
        padding: "6px 12px",
        background: "var(--paper)",
        border: "1px solid var(--line)",
        borderRadius: T.radius.pill,
        boxShadow: T.shadow.s1,
        fontSize: T.fz.small,
        color: "var(--ink)",
        zIndex: 4,
        maxWidth: "calc(100% - var(--space-6))",
      }}
    >
      <span style={{ display: "inline-flex", alignItems: "center", gap: "var(--space-2)" }}>
        <span
          aria-hidden
          style={{
            width: DOT,
            height: DOT,
            borderRadius: "999px",
            background: dotColor,
            animation: running ? "pulseDot 1.2s var(--ease-out) infinite" : undefined,
          }}
        />
        <span
          style={{
            fontWeight: 500,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {phase || "—"}
        </span>
      </span>
      {maxIter > 0 && <Meta>{`iter ${iter}/${maxIter}`}</Meta>}
      <Meta>{fmtMs(elapsedMs)}</Meta>
      <Meta>{`${(tokensIn / 1000).toFixed(1)}k / ${tokensOut} tok`}</Meta>
    </div>
  );
}

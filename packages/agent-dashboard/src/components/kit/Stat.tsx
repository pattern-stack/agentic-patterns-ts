/**
 * Stat — label + big value + optional sublabel (port-map §7.2), merging
 * `components/molecules/StatCard.tsx` (deleted — its 2 call sites now wrap
 * this in `Card` directly) with the inline `Stat` locals hand-copied in
 * EvalRunDetailPage and EvalComparePage.
 *
 * `tone` picks a cockpit semantic color (`T.tone`); `color` is an escape
 * hatch for the conditional cases those two pages had (e.g. "red only when
 * count > 0") that don't map cleanly onto a fixed tone. `color` wins when set.
 */
import { T } from "../../ui/tokens";

export type StatTone = keyof typeof T.tone;

export function Stat({
  label,
  value,
  sublabel,
  tone,
  color,
}: {
  label: string;
  value: string | number;
  sublabel?: string;
  tone?: StatTone;
  color?: string;
}) {
  const resolved = color ?? (tone ? T.tone[tone].color : "var(--ink)");
  return (
    <div>
      <div style={{ fontSize: T.fz.small, color: "var(--mute)", marginBottom: 2 }}>{label}</div>
      <div style={{ fontSize: T.fz.xxl, fontWeight: 600, color: resolved }}>{value}</div>
      {sublabel && (
        <div style={{ fontSize: T.fz.small, color: "var(--mute)", marginTop: 2 }}>{sublabel}</div>
      )}
    </div>
  );
}

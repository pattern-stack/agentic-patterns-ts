/**
 * Blast-radius presentation — ported from swe-brain's `bits.tsx`
 * (BlastDot/BlastChip), but BLAST-OPTIONAL (port-map §1.2, §6): the framework
 * has no per-capability blast-radius registration metadata today, so every
 * caller here passes `BlastRadius | undefined`. `undefined` renders a neutral
 * "unknown" chip/dot and an honest note — this module never invents a value.
 * (Core `Capability.blastRadius` metadata is a separate track, out of scope
 * for this slice — port-map §10.1.)
 */
import type { BlastRadius } from "../../graph/types";
import { Chip, type ChipTone } from "../atoms/Chip";

/** read = neutral · write = mutates state · external = leaves the process boundary. */
const BLAST_COLOR: Record<BlastRadius, string> = {
  read: "var(--mute)",
  write: "var(--accent)",
  external: "var(--err)",
};

const BLAST_TONE: Record<BlastRadius, ChipTone> = {
  read: "neutral",
  write: "accent",
  external: "warn",
};

const BLAST_NOTE: Record<BlastRadius, string> = {
  read: "observes only — safe",
  write: "mutates state",
  external: "leaves the process boundary",
};

/** Honest note when no blast-radius metadata exists for a tool (today, always). */
export const BLAST_UNKNOWN_NOTE = "blast radius unknown — framework does not declare one";

/** Small hue dot — neutral (line-toned) when `radius` is undefined. */
export function BlastDot({ radius }: { radius: BlastRadius | undefined }) {
  return (
    <span
      aria-hidden
      style={{
        width: 7,
        height: 7,
        borderRadius: "999px",
        background: radius ? BLAST_COLOR[radius] : "var(--line-2)",
        display: "inline-block",
        flex: "none",
      }}
    />
  );
}

/** Side-effect-class chip. Renders a neutral "blast unknown" chip — never a
 *  confident-but-wrong value — when no metadata exists. */
export function BlastChip({ radius }: { radius: BlastRadius | undefined }) {
  if (!radius) {
    return (
      <Chip tone="neutral" title={BLAST_UNKNOWN_NOTE}>
        <BlastDot radius={undefined} />
        blast unknown
      </Chip>
    );
  }
  return (
    <Chip tone={BLAST_TONE[radius]}>
      <BlastDot radius={radius} />
      {radius}
    </Chip>
  );
}

/** The run-tab note line for a given (possibly absent) blast radius. */
export function blastNote(radius: BlastRadius | undefined): string {
  return radius ? BLAST_NOTE[radius] : BLAST_UNKNOWN_NOTE;
}

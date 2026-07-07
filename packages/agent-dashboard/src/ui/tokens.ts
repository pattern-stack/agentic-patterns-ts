/**
 * Typed wrapper over CSS custom properties (vendored from swe-brain's Agent
 * Plane). All values are references — the CSS vars in theme.css remain the
 * source of truth. Import T in components; never hard-code hex/px elsewhere.
 */
export const T = {
  fz: {
    micro: "var(--fz-micro)",
    tiny: "var(--fz-tiny)",
    small: "var(--fz-small)",
    base: "var(--fz-base)",
    md: "var(--fz-md)",
    lg: "var(--fz-lg)",
    xl: "var(--fz-xl)",
    xxl: "var(--fz-xxl)",
    hero: "var(--fz-hero)",
  },
  lh: {
    tight: "var(--lh-tight)",
    base: "var(--lh-base)",
    loose: "var(--lh-loose)",
  },
  state: {
    hoverBg: "hsl(var(--hover-bg))",
    rowSelectedBg: "hsl(var(--row-selected-bg))",
    focusRing: "hsl(var(--focus-ring))",
  },
  font: {
    sans: "var(--font-sans)",
    serif: "var(--font-serif)",
    mono: "var(--font-mono)",
    hand: "var(--font-hand)",
  },
  density: {
    rowH: "var(--row-height-cozy)",
    rowPadX: "var(--row-pad-x)",
    rowPadY: "var(--row-pad-y)",
  },
  radius: {
    xs: "var(--radius-xs)",
    sm: "var(--radius-sm)",
    md: "var(--radius-md)",
    lg: "var(--radius-lg)",
    xl: "var(--radius-xl)",
    pill: "var(--radius-pill)",
  },
  shadow: {
    s1: "var(--shadow-1)",
    s2: "var(--shadow-2)",
    s3: "var(--shadow-3)",
    chalk: "var(--chalk-inset)",
  },
  motion: {
    fast: "var(--motion-fast)",
    mid: "var(--motion-mid)",
    slow: "var(--motion-slow)",
    ease: "var(--ease-out)",
  },
  /* Semantic tones. `color` = saturated hue, `soft` = tinted bg, `ink` = text. */
  tone: {
    ok: { color: "var(--ok)", soft: "var(--ok-soft)", ink: "var(--ok-ink)" },
    warn: { color: "var(--warn)", soft: "var(--warn-soft)", ink: "var(--warn-ink)" },
    err: { color: "var(--err)", soft: "var(--err-soft)", ink: "var(--err-ink)" },
    accent: { color: "var(--accent)", soft: "var(--accent-soft)", ink: "var(--accent-ink)" },
    mute: { color: "var(--mute)", soft: "var(--fill)", ink: "var(--ink-2)" },
  } satisfies Record<string, { color: string; soft: string; ink: string }>,
} as const;

export type ToneVariant = keyof typeof T.tone;

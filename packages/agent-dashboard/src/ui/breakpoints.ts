/**
 * Dashboard viewport breakpoints (px). Single source of truth — components and
 * CSS-in-TS consumers derive max-width queries from these, never from inline
 * magic numbers. CSS-file rules mirror these values in `@media (max-width: …)`
 * with a comment pointing back here.
 *   sm 640  — phone / not-phone boundary
 *   md 900  — narrow / desktop boundary
 *   lg 1200 — wide-desktop enhancements (reserved)
 */
export const BREAKPOINTS = { sm: 640, md: 900, lg: 1200 } as const;

export type BreakpointKey = keyof typeof BREAKPOINTS; // "sm" | "md" | "lg"

/** `"(max-width: 639px)"` — matches viewports STRICTLY BELOW the breakpoint. */
export function maxWidthQuery(key: BreakpointKey): string {
  return `(max-width: ${BREAKPOINTS[key] - 1}px)`;
}

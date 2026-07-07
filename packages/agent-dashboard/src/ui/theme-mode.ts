/**
 * Theme mode resolution (six-theme system, port-map §7.3). A user preference
 * is a {family, mode} pair:
 *   - family: "blue" | "earth" | "chalk" — which of the three palettes.
 *   - mode:   "system" | "light" | "dark" — follows the OS, or forces one.
 *
 * The pair resolves to a concrete `ThemeId` (one of the six `styles/theme-
 * <id>.css` blocks) via the light/dark maps below. Unlike the old three-theme
 * scheme, "system" is NOT expressed in CSS anymore (no more duplicated
 * `@media(prefers-color-scheme)` block) — this module resolves it in JS and
 * ALWAYS stamps a concrete `data-theme` attribute, live-updating on OS flips
 * (see `watchSystemMode`).
 *
 * Persistence: same `apdash-theme` localStorage key as the three-theme
 * scheme, now holding a JSON `{family,mode}` value. Legacy plain-string
 * values ("dark"/"light"/"system") from existing users are migrated in place
 * (`migrateLegacy`) onto the blue family, so nobody's stored preference
 * breaks or silently resets.
 *
 * `?theme=<id>` — a concrete theme id in the query string — overrides the
 * resolved theme for the page load. It is applied but never persisted
 * (`applyPreference` checks it ahead of the stored/explicit preference every
 * time); useful for capture tooling (ported from swe-brain's `lib/theme.ts`).
 */
export type ThemeFamily = "blue" | "earth" | "chalk";
export type ThemeSubMode = "system" | "light" | "dark";
export type ThemeId = "blue" | "blue-dark" | "earth" | "earth-dark" | "chalky" | "chalkboard";

export interface ThemePreference {
  family: ThemeFamily;
  mode: ThemeSubMode;
}

const KEY = "apdash-theme";

/** Default preference — blue family, dark mode: the dashboard's existing
 *  default look (blue-dark), so existing users see no change. */
const DEFAULT_PREFERENCE: ThemePreference = { family: "blue", mode: "dark" };

const LIGHT_FOR: Record<ThemeFamily, ThemeId> = {
  blue: "blue",
  earth: "earth",
  chalk: "chalky",
};
const DARK_FOR: Record<ThemeFamily, ThemeId> = {
  blue: "blue-dark",
  earth: "earth-dark",
  chalk: "chalkboard",
};

const THEME_IDS: ReadonlySet<string> = new Set<ThemeId>([
  "blue",
  "blue-dark",
  "earth",
  "earth-dark",
  "chalky",
  "chalkboard",
]);

function isFamily(v: unknown): v is ThemeFamily {
  return v === "blue" || v === "earth" || v === "chalk";
}

function isSubMode(v: unknown): v is ThemeSubMode {
  return v === "system" || v === "light" || v === "dark";
}

function isThemeId(v: string | null): v is ThemeId {
  return v !== null && THEME_IDS.has(v);
}

function isPreference(v: unknown): v is ThemePreference {
  if (typeof v !== "object" || v === null) return false;
  const rec = v as Record<string, unknown>;
  return isFamily(rec.family) && isSubMode(rec.mode);
}

function prefersDarkOS(): boolean {
  try {
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  } catch {
    return true; // matchMedia unavailable — default-dark bias, matches DEFAULT_PREFERENCE
  }
}

/** Resolve a {family, mode} preference to a concrete six-theme id. */
export function resolveThemeId(pref: ThemePreference): ThemeId {
  const dark = pref.mode === "system" ? prefersDarkOS() : pref.mode === "dark";
  return dark ? DARK_FOR[pref.family] : LIGHT_FOR[pref.family];
}

/** Pre-six-theme `apdash-theme` values ("dark"/"light"/"system") migrate onto
 *  the blue family, preserving the mode the value already named. */
function migrateLegacy(raw: string): ThemePreference | null {
  if (raw === "dark") return { family: "blue", mode: "dark" };
  if (raw === "light") return { family: "blue", mode: "light" };
  if (raw === "system") return { family: "blue", mode: "system" };
  return null;
}

/** `?theme=` query override — checked live (not cached) so it wins over
 *  stored preference AND explicit picker clicks, matching swe-brain's
 *  `lib/theme.ts` `themeOverride()` contract. */
export function themeOverride(): ThemeId | null {
  try {
    const q = new URLSearchParams(window.location.search).get("theme");
    return isThemeId(q) ? q : null;
  } catch {
    return null;
  }
}

export function getPreference(): ThemePreference {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULT_PREFERENCE;
    const legacy = migrateLegacy(raw);
    if (legacy) return legacy;
    const parsed: unknown = JSON.parse(raw);
    return isPreference(parsed) ? parsed : DEFAULT_PREFERENCE;
  } catch {
    return DEFAULT_PREFERENCE;
  }
}

/** Stamps a CONCRETE data-theme on <html> — never removes the attribute (the
 *  six-theme system has no "no theme" state). `?theme=` wins when present. */
export function applyPreference(pref: ThemePreference): void {
  const override = themeOverride();
  document.documentElement.setAttribute("data-theme", override ?? resolveThemeId(pref));
}

/** Persist an explicit user choice, then apply it (still subject to a live
 *  `?theme=` override, same as swe-brain's original contract). */
export function setPreference(pref: ThemePreference): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(pref));
  } catch {
    /* storage unavailable — preference lives for the session only */
  }
  applyPreference(pref);
}

let mediaListenerAttached = false;

/** Live OS-flip support for `mode: "system"` — re-resolves + re-stamps
 *  data-theme on `prefers-color-scheme` changes, without touching the
 *  persisted preference. Idempotent; call once (main.tsx does, at boot). */
export function watchSystemMode(): void {
  if (mediaListenerAttached) return;
  mediaListenerAttached = true;
  try {
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    mql.addEventListener("change", () => {
      const pref = getPreference();
      if (pref.mode === "system") applyPreference(pref);
    });
  } catch {
    /* matchMedia unavailable (SSR/older browsers) — system mode just won't live-flip */
  }
}

/**
 * Theme mode: light / dark / system. `system` follows the OS via the
 * @media(prefers-color-scheme) blocks in theme.css — we just remove the
 * data-theme attribute. `light`/`dark` force the palette by setting it on
 * <html>. Choice persists in localStorage. Default is `dark` (the dashboard's
 * default look) — kept in sync with the before-paint script in index.html.
 */
export type ThemeMode = "system" | "light" | "dark";
const KEY = "apdash-theme";

export function getMode(): ThemeMode {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" || v === "system" ? v : "dark";
  } catch {
    return "dark";
  }
}

export function applyMode(mode: ThemeMode): void {
  const el = document.documentElement;
  if (mode === "system") el.removeAttribute("data-theme");
  else el.setAttribute("data-theme", mode);
}

export function setMode(mode: ThemeMode): void {
  try {
    localStorage.setItem(KEY, mode);
  } catch {
    /* ignore */
  }
  applyMode(mode);
}

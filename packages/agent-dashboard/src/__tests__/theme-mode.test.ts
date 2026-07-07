/**
 * ui/theme-mode.ts — family×mode resolution, legacy storage migration, and
 * the non-persisted ?theme= override (port-map §7.3, S2 acceptance criteria).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type ThemePreference,
  applyPreference,
  getPreference,
  resolveThemeId,
  setPreference,
  themeOverride,
} from "../ui/theme-mode";

const KEY = "apdash-theme";

function mockMatchMedia(matches: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockImplementation((query: string) => ({
      matches,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
  window.history.pushState({}, "", "/");
  mockMatchMedia(false);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("resolveThemeId", () => {
  it("resolves explicit light/dark per family to the six concrete ids", () => {
    expect(resolveThemeId({ family: "blue", mode: "light" })).toBe("blue");
    expect(resolveThemeId({ family: "blue", mode: "dark" })).toBe("blue-dark");
    expect(resolveThemeId({ family: "earth", mode: "light" })).toBe("earth");
    expect(resolveThemeId({ family: "earth", mode: "dark" })).toBe("earth-dark");
    expect(resolveThemeId({ family: "chalk", mode: "light" })).toBe("chalky");
    expect(resolveThemeId({ family: "chalk", mode: "dark" })).toBe("chalkboard");
  });

  it("follows the OS for mode: system", () => {
    mockMatchMedia(true);
    expect(resolveThemeId({ family: "earth", mode: "system" })).toBe("earth-dark");
    mockMatchMedia(false);
    expect(resolveThemeId({ family: "earth", mode: "system" })).toBe("earth");
  });

  it("defaults to dark when matchMedia throws/unavailable", () => {
    vi.stubGlobal("matchMedia", undefined);
    expect(resolveThemeId({ family: "chalk", mode: "system" })).toBe("chalkboard");
  });
});

describe("storage migration", () => {
  const legacyCases: [string, ThemePreference][] = [
    ["dark", { family: "blue", mode: "dark" }],
    ["light", { family: "blue", mode: "light" }],
    ["system", { family: "blue", mode: "system" }],
  ];

  for (const [raw, expected] of legacyCases) {
    it(`migrates legacy "${raw}" onto the blue family`, () => {
      localStorage.setItem(KEY, raw);
      expect(getPreference()).toEqual(expected);
    });
  }

  it("round-trips the new {family,mode} JSON format", () => {
    const pref: ThemePreference = { family: "chalk", mode: "dark" };
    setPreference(pref);
    expect(JSON.parse(localStorage.getItem(KEY) as string)).toEqual(pref);
    expect(getPreference()).toEqual(pref);
  });

  it("falls back to the default preference for missing storage", () => {
    expect(getPreference()).toEqual({ family: "blue", mode: "dark" });
  });

  it("falls back to the default preference for corrupt JSON", () => {
    localStorage.setItem(KEY, "{not json");
    expect(getPreference()).toEqual({ family: "blue", mode: "dark" });
  });

  it("falls back to the default preference for a well-formed but invalid value", () => {
    localStorage.setItem(KEY, JSON.stringify({ family: "nope", mode: "dark" }));
    expect(getPreference()).toEqual({ family: "blue", mode: "dark" });
  });
});

describe("?theme= override", () => {
  it("is read from the query string when valid", () => {
    window.history.pushState({}, "", "/?theme=chalky");
    expect(themeOverride()).toBe("chalky");
  });

  it("ignores invalid theme query values", () => {
    window.history.pushState({}, "", "/?theme=nonsense");
    expect(themeOverride()).toBeNull();
  });

  it("applies without persisting — the stored preference is untouched", () => {
    setPreference({ family: "earth", mode: "light" });
    window.history.pushState({}, "", "/?theme=chalky");

    applyPreference(getPreference());

    expect(document.documentElement.getAttribute("data-theme")).toBe("chalky");
    // the override never wrote to storage — the explicit earth/light choice survives
    expect(getPreference()).toEqual({ family: "earth", mode: "light" });
  });

  it("wins over an explicit setPreference call made while it is present", () => {
    window.history.pushState({}, "", "/?theme=chalkboard");
    setPreference({ family: "blue", mode: "light" });
    expect(document.documentElement.getAttribute("data-theme")).toBe("chalkboard");
  });
});

describe("applyPreference / setPreference", () => {
  it("stamps a concrete data-theme for every combination (never removes the attribute)", () => {
    applyPreference({ family: "earth", mode: "light" });
    expect(document.documentElement.getAttribute("data-theme")).toBe("earth");

    applyPreference({ family: "blue", mode: "system" });
    expect(document.documentElement.hasAttribute("data-theme")).toBe(true);
  });

  it("setPreference persists the choice and applies it immediately", () => {
    setPreference({ family: "blue", mode: "light" });
    expect(document.documentElement.getAttribute("data-theme")).toBe("blue");
    expect(getPreference()).toEqual({ family: "blue", mode: "light" });
  });
});

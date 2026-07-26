/**
 * ToolRunner — pins the semantics ported verbatim from swe-brain's
 * `CapabilityToolRunner` / `run-tool.ts` (port-map §2.1, §2.3):
 *   - `coerce`: numeric -> Number(raw); object/array/unknown -> JSON.parse,
 *     falling back to the RAW string on a parse failure (so the server's Zod
 *     schema produces the rejection message).
 *   - `buildArgs` (the omit-empty-optionals rule): only filled fields enter
 *     `args`; an untouched boolean sends nothing, a touched-false boolean
 *     DOES send `false`.
 *   - the Run tab's result UX: `ok|error · Nms` status line, JSON result
 *     block, error text box.
 */
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToolDef } from "../api/composition";
import { ToolRunner, buildArgs, coerce } from "../components/organisms/ToolRunner";
import { __resetMediaQueryCacheForTests } from "../hooks/useMediaQuery";

/**
 * Stubs `window.matchMedia` so `useBreakpoint` reports a phone viewport
 * (isPhone AND isNarrow true) — pattern mirrors
 * `src/__tests__/EvalCaseDetailPage.test.tsx`'s `stubPhone()`.
 */
function stubPhone() {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: /max-width:\s*(639|899)px/.test(query),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }));
}

describe("coerce", () => {
  it("coerces number/integer params via Number()", () => {
    expect(coerce("number", "3.5")).toBe(3.5);
    expect(coerce("integer", "42")).toBe(42);
  });

  it("parses valid JSON for object/array/unknown params", () => {
    expect(coerce("object", '{"x":1,"y":2}')).toEqual({ x: 1, y: 2 });
    expect(coerce("array", "[1,2,3]")).toEqual([1, 2, 3]);
  });

  it("passes invalid JSON through as the raw string — deliberate, demos server Zod rejection", () => {
    expect(coerce("object", "not json")).toBe("not json");
    expect(coerce("array", "{broken")).toBe("{broken");
  });

  it("passes plain string params through untouched", () => {
    expect(coerce("string", "hello")).toBe("hello");
  });
});

describe("buildArgs (omit-empty-optionals)", () => {
  const params = [
    { name: "text", type: "string" },
    { name: "count", type: "number" },
    { name: "flag", type: "boolean" },
  ];

  it("omits a param whose value was never touched", () => {
    expect(buildArgs(params, {})).toEqual({});
  });

  it("omits a string param left as an empty string", () => {
    expect(buildArgs(params, { text: "" })).toEqual({});
  });

  it("includes a filled string param, coerced by type", () => {
    expect(buildArgs(params, { text: "hi", count: "3" })).toEqual({ text: "hi", count: 3 });
  });

  it("omits an untouched boolean — sends nothing, not `false`", () => {
    const args = buildArgs(params, { text: "hi" });
    expect(Object.hasOwn(args, "flag")).toBe(false);
  });

  it("includes a touched-false boolean explicitly — `false` IS sent once touched", () => {
    const args = buildArgs(params, { flag: false });
    expect(Object.hasOwn(args, "flag")).toBe(true);
    expect(args.flag).toBe(false);
  });

  it("includes a touched-true boolean", () => {
    expect(buildArgs(params, { flag: true })).toEqual({ flag: true });
  });
});

// --------------------------------------------------------------------------
// Render-level pin: the full form -> invoke -> result round trip
// --------------------------------------------------------------------------

const tool: ToolDef = {
  name: "slugify",
  description: "Turn text into a URL-safe slug",
  parameters: {
    type: "object",
    properties: {
      text: { type: "string", description: "Text to slugify" },
      uppercase: { type: "boolean", description: "Emit SCREAMING-KEBAB" },
    },
    required: ["text"],
  },
};

function stubInvokeFetch(body: unknown, ok = true) {
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({
    ok,
    status: ok ? 200 : 404,
    statusText: ok ? "OK" : "Not Found",
    json: async () => body,
  }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("ToolRunner (rendered)", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    __resetMediaQueryCacheForTests();
  });

  it("sends only the filled required field — the untouched optional checkbox is omitted", async () => {
    const fetchMock = stubInvokeFetch({ ok: true, result: { slug: "hello-world" }, ms: 4 });
    render(<ToolRunner capId="toolsmith-utilities" tool={tool} />);

    fireEvent.change(screen.getByPlaceholderText("string"), { target: { value: "Hello World" } });
    fireEvent.click(screen.getByRole("button", { name: "Run tool" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/capabilities/toolsmith-utilities/tools/slugify/invoke");
    const body = JSON.parse(init?.body as string);
    expect(body).toEqual({ args: { text: "Hello World" } });

    await screen.findByText(/ok · 4ms/);
  });

  it("sends `uppercase: false` once the checkbox is touched, even though it started false", async () => {
    const fetchMock = stubInvokeFetch({ ok: true, result: { slug: "HELLO" }, ms: 2 });
    render(<ToolRunner capId="toolsmith-utilities" tool={tool} />);

    fireEvent.change(screen.getByPlaceholderText("string"), { target: { value: "Hello" } });
    const checkbox = screen.getByRole("checkbox");
    fireEvent.click(checkbox); // -> true
    fireEvent.click(checkbox); // -> false, but TOUCHED
    fireEvent.click(screen.getByRole("button", { name: "Run tool" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse(init?.body as string);
    expect(body).toEqual({ args: { text: "Hello", uppercase: false } });
  });

  it("renders the server's error message in the error box on a failed run", async () => {
    stubInvokeFetch({ ok: false, error: "text: Required", ms: 1 });
    render(<ToolRunner capId="toolsmith-utilities" tool={tool} />);

    fireEvent.click(screen.getByRole("button", { name: "Run tool" }));

    await screen.findByText("text: Required");
    expect(screen.getByText(/error · 1ms/)).toBeTruthy();
  });

  // Scope-addendum fix: a REJECTED fetch (server down / network drop — as
  // opposed to a resolved-but-non-2xx Response, covered above) used to
  // propagate out of `compositionApi.invokeTool` as an unhandled rejection —
  // `ToolRunner.run()`'s bare `try {…} finally {…}` has no `catch`, so no
  // error ever reached `result`: the button silently re-enabled with no
  // error box. `invokeTool` now catches the rejection and folds it into the
  // same `{ok:false, error}` envelope.
  it("folds a network-level fetch rejection into the error box (not an unhandled rejection)", async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<ToolRunner capId="toolsmith-utilities" tool={tool} />);

    fireEvent.change(screen.getByPlaceholderText("string"), { target: { value: "Hello" } });
    fireEvent.click(screen.getByRole("button", { name: "Run tool" }));

    await screen.findByText("Failed to fetch");
    expect(screen.getByText(/error · 0ms/)).toBeTruthy();
    // the button re-enables afterward either way — the fix is the visible error box.
    const button = screen.getByRole("button", { name: "Run tool" }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
  });
});

// --------------------------------------------------------------------------
// Responsive (W2-Tools) — param-row stacking, run-button touch target, JSON
// result wrapping. Desktop cases rely on the F1 jsdom fallback (no
// matchMedia stub -> useBreakpoint reports desktop); phone cases stub
// matchMedia per the established EvalCaseDetailPage `stubPhone()` pattern.
// --------------------------------------------------------------------------
describe("ToolRunner — responsive (W2-Tools)", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    __resetMediaQueryCacheForTests();
  });

  it("desktop: a param row is a two-column grid", () => {
    render(<ToolRunner capId="toolsmith-utilities" tool={tool} />);
    const label = screen.getByPlaceholderText("string").closest("label");
    expect(label).toHaveStyle({ gridTemplateColumns: "minmax(7rem, 10rem) 1fr" });
  });

  it("phone: a param row stacks to a single column", () => {
    stubPhone();
    render(<ToolRunner capId="toolsmith-utilities" tool={tool} />);
    const label = screen.getByPlaceholderText("string").closest("label");
    expect(label).toHaveStyle({ gridTemplateColumns: "1fr" });
  });

  it("the Run tool button meets the 40px touch target", () => {
    render(<ToolRunner capId="toolsmith-utilities" tool={tool} />);
    const button = screen.getByRole("button", { name: "Run tool" });
    expect(button).toHaveStyle({ minHeight: "40px" });
  });

  it("a long unbroken token in the JSON result wraps instead of widening the page", async () => {
    const longToken = "x".repeat(300);
    const fetchMock = stubInvokeFetch({ ok: true, result: { token: longToken }, ms: 3 });
    render(<ToolRunner capId="toolsmith-utilities" tool={tool} />);

    fireEvent.click(screen.getByRole("button", { name: "Run tool" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const pre = await screen.findByText(new RegExp(longToken), { selector: "pre" });
    expect(pre).toHaveStyle({ whiteSpace: "pre-wrap", overflowWrap: "anywhere" });
  });
});

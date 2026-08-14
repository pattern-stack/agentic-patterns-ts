# W1-Live (WI-9, /live half) — Live (/live) Page Responsive

**Goal:** The `/live` page reflows on phone viewports: the header row (title +
connection badge on the left, event-count badge + Clear button on the right)
wraps instead of crushing, and expanded event payloads in the stream stay
contained — no horizontal page scroll from long mono JSON.

**PR size estimate:** ~40 changed source lines + 1 new test file (~90 lines).

## Scope note — /tools DEFERRED to Wave 2

The original combined work item (WI-9) covered both `/live` and `/tools`
(ToolRunner). **The `/tools` half is deferred to Wave 2 and is explicitly OUT
of scope here.** Do not touch `packages/agent-dashboard/src/pages/ToolsPage.tsx`
or `ToolRunner` in this PR. This spec covers `/live` only: `LivePage.tsx` and
its `EventStream` organism.

## Dependencies

**F1 (merged first):** `.claude/specs/2026-07-24-responsive-foundation-usebreakpoint.md`
publishes, from `packages/agent-dashboard/src/hooks/useMediaQuery.ts`:

```ts
export function useBreakpoint(): { isPhone: boolean; isNarrow: boolean; isDesktop: boolean };
```

- `isPhone` ⇔ viewport < 640px (`"(max-width: 639px)"`); `isNarrow` ⇔ < 900px;
  `isDesktop` ⇔ >= 900px.
- jsdom/no-`matchMedia` fallback: `{ isPhone: false, isNarrow: false, isDesktop: true }`
  — gate PHONE variants on the flags; never gate the desktop variant on a
  positive match. Existing tests keep seeing the desktop layout untouched.
- Test helper `__resetMediaQueryCacheForTests()` (same module, not barrel-exported)
  clears the module-level MediaQueryList cache between stubbed tests.

## 1. File Tree

```
packages/agent-dashboard/src/
├── pages/
│   └── LivePage.tsx                        # MODIFIED — header row wraps on phone
├── components/organisms/
│   └── EventStream.tsx                     # MODIFIED — phone payload containment
└── __tests__/
    └── LivePage.responsive.test.tsx        # NEW — phone-stubbed render tests
```

## 2. Changes (pseudocode)

### `pages/LivePage.tsx` — header row wrap

Current header row (lines 14–21) is a single `display:flex` /
`justifyContent:"space-between"` row; on a ~375px viewport the two badge+button
clusters collide with the title. Branch on `isPhone`:

```tsx
import { useBreakpoint } from "../hooks/useMediaQuery";

export function LivePage() {
  const { isPhone } = useBreakpoint();
  // header container style (currently lines 15-20):
  <div
    style={{
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      marginBottom: 20,
      ...(isPhone ? { flexWrap: "wrap" as const, rowGap: 8 } : {}),
    }}
  >
```

The two child cluster divs (lines 22 and 44) are untouched — with `flexWrap`
the right-hand cluster (`{n} events` badge + Clear) drops to a second line
below the title + connection badge when it doesn't fit. Desktop output is
byte-identical (no wrap keys present when `isPhone` is false).

### `components/organisms/EventStream.tsx` — payload containment

**Verified during spec:** the expanded `<pre>` (lines 156–172) ALREADY has
`whiteSpace: "pre-wrap"` + `wordBreak: "break-word"` (lines 165–166), so long
JSON payloads wrap today and cannot widen the page; the scroll container
(lines 93–100) has `overflow: "auto"`. Two phone-only gaps remain:

1. The `<pre>`'s left padding is 40px (line 160: `padding: "8px 14px 12px 40px"`)
   — a third of nothing on a 375px screen. Reduce to 14px on phone.
2. `wordBreak: "break-word"` is a legacy alias; add `overflowWrap: "anywhere"`
   (unconditionally — harmless on desktop) as the standards-track guarantee
   that unbroken mono tokens (URLs, ids, base64) wrap.

```tsx
import { useBreakpoint } from "../../hooks/useMediaQuery";

export function EventStream({ events, height = "calc(100vh - 220px)" }: EventStreamProps) {
  const { isPhone } = useBreakpoint();
  // expanded <pre> style (currently lines 158-168):
  style={{
    ...,
    padding: isPhone ? "8px 14px 12px 14px" : "8px 14px 12px 40px",
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
    overflowWrap: "anywhere",   // NEW
    ...,
  }}
```

Row buttons (lines 111–155) need no change: the summary span already has
`overflow:hidden` / `textOverflow:"ellipsis"` / `flex:1` (lines 146–150), so
it absorbs all shrink on narrow widths.

## 3. Implementation Steps

1. `LivePage.tsx`: import `useBreakpoint`; call it at the top of `LivePage`;
   spread `{ flexWrap: "wrap", rowGap: 8 }` into the header-row style when
   `isPhone` (see pseudocode). No other JSX changes.
2. `EventStream.tsx`: import `useBreakpoint`; call it at the top of
   `EventStream`; make the expanded-`<pre>` left padding phone-conditional and
   add `overflowWrap: "anywhere"`.
3. Add `src/__tests__/LivePage.responsive.test.tsx` per the test plan.
4. Gate: `bun run --filter=@pattern-stack/agentic-dashboard test` (full suite —
   existing tests must pass unchanged via the F1 desktop fallback), plus
   `typecheck` and `lint` (biome: double quotes, 2-space indent, 100-col).

Conventions: strict TS (the `as const` on `"wrap"` matters for
`CSSProperties`), no new deps, hooks called unconditionally at component top.

## 4. Test Plan — `src/__tests__/LivePage.responsive.test.tsx`

Stubs, following established patterns:

- **matchMedia → phone:** `vi.stubGlobal("matchMedia", ...)` returning
  `{ matches: query === "(max-width: 639px)" || query === "(max-width: 899px)", addEventListener: vi.fn(), removeEventListener: vi.fn() }`
  (pattern: `src/__tests__/theme-mode.test.ts:17-27`; band-mapping strings per
  F1 §4 case 6). `beforeEach`: `__resetMediaQueryCacheForTests()`;
  `afterEach`: `vi.unstubAllGlobals()`.
- **EventSource:** reuse the `FakeEventSource` class pattern from
  `src/__tests__/EvalRunDetailPage.test.tsx:209-236` (records instances,
  `emit(name, data)` fires named listeners) so `useEventStream` connects and
  events can be injected.

Cases:

1. **Header wraps on phone:** render `<LivePage />` with the phone stub;
   locate the header container (parent of the `Live Events` `<h1>`'s cluster);
   assert `style.flexWrap === "wrap"` and `style.rowGap` is set.
2. **Header does not wrap on desktop:** re-stub matchMedia with
   `matches: false` (and reset the cache); assert `flexWrap` is absent/empty on
   the same container.
3. **Payload overflow contained on phone:** with the phone stub, `emit` an
   event whose `data` includes a ~500-char unbroken token; click the row button
   (`aria-expanded` toggles); assert the revealed `<pre>` has
   `whiteSpace: "pre-wrap"`, `overflowWrap: "anywhere"`, and phone padding
   `"8px 14px 12px 14px"` (i.e. no 40px indent). jsdom does no layout, so
   containment is asserted through these computed style properties, not pixel
   widths.
4. **Regression:** full existing dashboard suite passes untouched (F1 fallback
   renders desktop in every other test file).

## 5. Out of Scope

- `/tools` page + `ToolRunner` responsive work — **Wave 2** (see scope note).
- `EventStream` `height` prop / `calc(100vh - 220px)` default — unchanged.
- Any CSS-file (`styles/atoms.css`) changes — this item is inline-style only.

# W3-B — Conversations (`/conversations` + `/conversations/:id`) + Claude Code (`/claude-code`)

**Date:** 2026-07-26
**Status:** SPEC
**Size:** ~35 changed source lines across 3 page files + 3 new test files (~230 lines).
Mechanical: `hideBelow` column annotations (Conversations, per the eval-pages/Tools
precedent), an `isPhone`-gated header wrap (Claude Code, mirroring `LivePage.tsx`'s
Wave-1 fix almost verbatim — the two pages are structural twins), and small
containment additions (Conversation detail) for a real, verified gap in Markdown's
unstyled `<pre class="md-pre">` output when `chat.css` isn't loaded.

## 1. Dependencies (already merged — reuse, do not recreate)

- **F1** `src/hooks/useMediaQuery.ts` → `useBreakpoint(): { isPhone; isNarrow; isDesktop }`,
  `useMediaQuery`, `__resetMediaQueryCacheForTests()`. jsdom has no `matchMedia` →
  defaults to desktop.
- **F1** `src/ui/breakpoints.ts` → `BREAKPOINTS`, `maxWidthQuery`.
- **DataTable core** `src/components/organisms/DataTable.tsx` → `Column<T>.hideBelow?:
  "sm" | "md"` (line 21) + the table wrapper's `overflowX: "auto"` fallback
  (lines 93-101). This item only consumes `hideBelow`; no `DataTable.tsx` edits.
- **Wave-1 `/live` precedent** (`.claude/specs/2026-07-24-responsive-live-page.md`,
  `src/pages/LivePage.tsx:16-24`): the `isPhone ? { flexWrap: "wrap", rowGap: 8 } : {}`
  spread on a `justifyContent: "space-between"` header row. `ClaudeCodePage.tsx`'s
  header (lines 62-69) is the same title+badge / badge+badge+button shape — this
  item reproduces that exact fix rather than inventing a new one.
- **Wave-2 `/tools` precedent** (`.claude/specs/2026-07-26-responsive-tools-page.md`):
  call-site-only containment fixes (`overflowWrap: "anywhere"` passed into a shared
  component's `style` prop) instead of editing the shared component. Reused here for
  `JsonBlock`/`Markdown` call sites in `ConversationDetailPage.tsx`.
- **`components/kit/JsonBlock.tsx`** — already fully contained: `whiteSpace: "pre-wrap"`,
  `wordBreak: "break-word"`, `overflowX: "auto"` set directly on its own `<pre>`
  (lines 30-38). Per the CSS Flexbox auto-minimum-size algorithm, a flex item that
  sets its own non-`visible` overflow gets an automatic `0` minimum size instead of
  its content's min-content size — so `JsonBlock` is safe as a flex child **without**
  a `minWidth: 0` wrapper. Verified, not assumed; see §3.

## 2. File Tree

```
packages/agent-dashboard/src/
├── pages/
│   ├── ConversationsPage.tsx              # MODIFIED — DataTable column hideBelow
│   ├── ConversationDetailPage.tsx         # MODIFIED — Markdown/text containment
│   └── ClaudeCodePage.tsx                 # MODIFIED — header row wrap (isPhone)
└── __tests__/
    ├── ConversationsPage.responsive.test.tsx       # NEW
    ├── ConversationDetailPage.responsive.test.tsx  # NEW
    └── ClaudeCodePage.responsive.test.tsx          # NEW
```

No test files exist today for any of the three pages (verified: `find` over
`src/__tests__` turns up nothing named `Conversation*` or `ClaudeCode*`) — all three
suites are new, following the `<Page>.responsive.test.tsx` naming used by
`ToolsPage`/`AgentsRosterPage`/`RolesPage`/`LivePage`/`RunSurfacePage`.

## 3. Current State (verified — real line numbers as of this spec)

### `pages/ConversationsPage.tsx` (89 lines)

- No filter row (`PageHeader` at line 20/32 is a bare title, no badges/actions) — `PageHeader`
  itself already has `flexWrap: "wrap"` (`components/kit/PageHeader.tsx:20`) — **no
  change needed** there, mirroring the Tools-page finding ("no filter row exists").
- Loading/error (17-28) and empty (33-40) branches are single-column `AsyncState` —
  **no change**.
- The `DataTable` (lines 43-84) has 7 columns, **no `hideBelow` today**:
  `conversationId` (46-53), `agentName` (54), `messageCount` (55), `tokenCount` (56-61),
  `status` (62-66), `startedAt` (67-71), `lastMessageAt` (72-76). On a 360-375px phone
  this is 7 columns relying entirely on the table's horizontal scroll fallback — same
  gap the eval-pages/Tools specs already fixed elsewhere. Per that precedent:
  - `messageCount` (line 55) → `hideBelow: "sm"` — secondary volume metric, drop on
    phone only.
  - `tokenCount` (lines 56-61) → `hideBelow: "md"` — secondary volume metric, drop on
    phone **and** narrow/tablet.
  - `startedAt` (lines 67-71) → `hideBelow: "md"` — `lastMessageAt` already conveys
    recency; age-at-start is the lower-value of the two timestamps.
  - Keep always: `conversationId`, `agentName`, `status` (identity + outcome — the
    `EvalRunsPage` precedent's "keep-columns are the identity/status/outcome columns"
    rule applies directly), and `lastMessageAt` (the one timestamp that answers "is
    this conversation still active", kept unconditionally so phone still has a
    recency signal — same call as the eval pages' `tsStart`).
  - Phone result: `Conversation`, `Agent`, `Status`, `Last Message` (4 of 7 columns).
    Narrow/tablet result: those 4 plus `Messages` (5 of 7).

### `pages/ConversationDetailPage.tsx` (222 lines)

- Breadcrumb/title row (lines 79-91: back-link + 8-char mono id) — content is short
  (`← Conversations` + an 8-character mono token, ~190px combined) and comfortably
  fits a 320px viewport with room to spare. **Verified, no change** — unlike
  `EvalRunDetailPage`'s title row (long run id + several status badges, genuinely
  overflowed), forcing a `flexWrap` here would be inventing work the eval precedent
  doesn't actually require for this shape.
- Metadata `Card` (93-121): the badge row (line 94) already has
  `flexWrap: "wrap"` — **no change**.
- Error banner (lines 104-120): a plain block `<div>` (not a flex row) — normal
  block text wraps at spaces already, but the content is a raw error string in
  `--font-mono` with no `overflowWrap`, so a single long unbroken token (a stack
  frame / file path with no spaces — the realistic shape of a runner error) would
  overflow the card. Add `overflowWrap: "anywhere"` to the style object (line
  106-116) — same cheap, unconditional idiom as the Wave-1 `/live` `EventStream` fix
  and the Wave-2 `ToolRunner` `JsonBlock` fix.
- Messages list / `MessageCard` (123-171): the meta row (140-148) already has
  `flexWrap: "wrap"` — **no change**.
- `PartBlock` (173-222) — the one real gap in this file:
  - `tool_call` (191-199), `tool_result` (201-214), and the fallback branch
    (216-221) all render through `JsonBlock`, which is already self-contained (§1) —
    **verified, no change** needed for any of these three branches.
  - The `user_prompt`/`text` branch (178-189) is the actual gap:
    - The **assistant** sub-branch (`isAssistant`, line 182) renders `<Markdown
      content={...} />`. `Markdown.tsx`'s own comment (lines 7-8) states its
      `.answer .md` class hooks are `chat.css`'s and "degrade to plain semantic-tag
      styling wherever chat.css isn't loaded" — and `chat.css` is imported **only**
      by `chat/ChatPanel.tsx` (verified via repo-wide grep), never by this page.
      Fenced code blocks render as `<pre class="md-pre"><code>...` (`lib/markdown.ts:236`)
      and there is **no CSS rule anywhere in the repo targeting `.md-pre`** (verified
      by grep — the `chat.css` comment references a rule that doesn't actually
      exist) — so a stored assistant message containing a code fence renders a bare
      browser-default `<pre>` (`white-space: pre`, `overflow: visible`). Unlike
      `JsonBlock`, this `<pre>` has no overflow style of its own, so per the
      Flexbox auto-min-size rule its automatic minimum width is its full unwrapped
      content width — a real overflow risk in this file's flex-column layout, not a
      hypothetical one. Fix: wrap the `Markdown` call in a
      `<div style={{ minWidth: 0, overflowX: "auto" }}>` — this call-site wrapper
      (not a `Markdown.tsx`/`markdown.ts` edit — those are shared with `ChatPage` and
      other Wave surfaces outside this item's scope) gives the wrapper the `overflow`
      property needed to legitimately claim the `0` auto-minimum, containing the
      unstyled `<pre>` inside a locally-scrolling box instead of blowing out the
      page.
    - The **user** sub-branch (line 185) already has `whiteSpace: "pre-wrap"` (wraps
      at spaces) but no `overflowWrap` — add `overflowWrap: "anywhere"` alongside
      it, so a pasted long unbroken token (URL, path) wraps too, matching the
      `/live` `EventStream` precedent exactly (`whiteSpace: "pre-wrap"` +
      `overflowWrap: "anywhere"` together).
    - The branch's outer wrapper (line 180) gets a defensive `minWidth: 0` — it's a
      flex-column child of `MessageCard`'s parts list (itself `flexDirection:
      "column"`), the same "flex-child overflow guard" idiom called out in the
      builder brief.

### `pages/ClaudeCodePage.tsx` (185 lines)

- This page is a near-exact structural twin of `LivePage.tsx` (title + connection
  badge on the left, count badge(s) + Clear button on the right, an
  `AlertIcon`+`<span>` error `Card` below) — same author, same shape, built after
  `LivePage.tsx` was already responsive-fixed in Wave 1 but never itself updated.
- Header row (`ClaudeCodeLoaded`, lines 62-69): `display: flex, alignItems: center,
  justifyContent: space-between, marginBottom: 20` — no `flexWrap`, no `gap`. On
  phone this is "Claude Code Sessions" + a connected/reconnecting badge fighting
  `justify-content: space-between` against a 2-3-item badge/button cluster on the
  right — the exact scenario `LivePage.tsx:16-24` already fixed. Fix: reproduce that
  fix verbatim — `useBreakpoint()` + `...(isPhone ? { flexWrap: "wrap" as const,
  rowGap: 8 } : {})`.
- Inner clusters (left: 70-91, right: 92-102) — **left as `LivePage.tsx`'s precedent
  left them**: unchanged. `LivePage`'s Wave-1 fix deliberately touched only the
  outer row, not the two inner clusters, and this page's clusters are the same
  size class (left: title + 1 badge; right: 2 badges + 1 button, one badge more
  than `LivePage`'s single count badge but still well under a 375px budget at these
  badge/button sizes) — reproducing the exact, already-reviewed precedent rather
  than inventing a wider-reaching fix that wasn't needed on the sibling page.
- Error `Card` (105-122): identical markup/style to `LivePage.tsx`'s error `Card`
  (56-72), which Wave 1 left untouched (no `minWidth: 0` on the `<span>`) — normal
  wrapping text's flex auto-min-size is its longest **word**, not its full line, so
  no fix is needed here either; matching the sibling precedent instead of
  re-litigating a decision already made for the same markup shape.
- `SessionCard` (`components/organisms/SessionCard.tsx`) — **not one of this item's
  three files** and, verified by reading it, already has `flexWrap: "wrap"` on its
  header button (present since the original feature commit, not a Wave fix) and a
  `flex: 1`-free, ellipsis-truncated `cwd` span. Out of scope for this item; noted
  here only for completeness, not touched.
- `HydratingState`/`EmptyState` (139-185) are single-column centered `Card`s —
  **no change**.

## 4. Implementation Steps

1. **`ConversationsPage.tsx`** — add `hideBelow: "sm"` to `messageCount` (line 55),
   `hideBelow: "md"` to `tokenCount` (lines 56-61) and `startedAt` (lines 67-71). No
   new imports (the page doesn't call `useBreakpoint` itself — `DataTable` already
   does).
2. **`ConversationDetailPage.tsx`**:
   - Error banner style object (lines 106-116): add `overflowWrap: "anywhere"`.
   - `PartBlock`'s `user_prompt`/`text` branch (178-189): add `minWidth: 0` to the
     outer div (180); wrap the assistant `Markdown` call in a
     `<div style={{ minWidth: 0, overflowX: "auto" }}>`; add `overflowWrap:
     "anywhere"` to the user-text div's style (185).
   - No new imports; no `useBreakpoint` needed (all additions are unconditional).
3. **`ClaudeCodePage.tsx`**:
   - Import `useBreakpoint` from `"../hooks/useMediaQuery"`.
   - In `ClaudeCodeLoaded`, call `const { isPhone } = useBreakpoint();` near the top
     (alongside the existing `useEventStream`/`useMemo` calls).
   - Header row style (lines 62-69): add
     `...(isPhone ? { flexWrap: "wrap" as const, rowGap: 8 } : {})`.
4. Add the three new test files per §5.
5. Gate: `bun run --filter=@agentic-patterns/dashboard typecheck` and
   `bun run --filter=@agentic-patterns/dashboard test -- Conversation` and
   `bun run --filter=@agentic-patterns/dashboard test -- ClaudeCode` (per the
   builder brief — not build/lint/full-check).

Conventions: strict TS (`as const` on `"wrap"`), biome (double quotes, 2-space
indent, semicolons, 100-col), hooks called unconditionally at component top, no new
deps, no upward imports.

## 5. Test Plan

### `ConversationsPage.responsive.test.tsx` (new)

`stubPhone()` per the `ToolsPage.responsive.test.tsx` pattern (matches
`max-width:\s*(639|899)px`). Stub `fetch` for `GET /admin/conversations` returning
one `ConversationSummary` row (fixture shape from `api/types.ts:62-70`). Render
inside a `MemoryRouter` (the page calls `useNavigate`/row click nav).

1. **Desktop:** no stub; after the row loads, assert `Messages`, `Tokens`, and
   `Started` headers are all present (all 7 columns render).
2. **Phone:** `stubPhone()`; assert `Conversation`, `Agent`, `Status`, `Last Message`
   remain and `queryByText("Messages")`/`"Tokens"`/`"Started"` are all `null`.
3. `afterEach`: `cleanup()`, `vi.unstubAllGlobals()`, `vi.restoreAllMocks()`,
   `__resetMediaQueryCacheForTests()`.

### `ConversationDetailPage.responsive.test.tsx` (new)

Stub `fetchJSON`'s underlying `fetch` for the three calls the page makes
(`GET /conversations/:id`, `GET /conversations/:id/messages`,
`GET /messages/:id/parts`) — route by URL substring, matching this page's own
`Promise.all` shape. Render with `MemoryRouter` at `/conversations/c1` +
`<Route path="/conversations/:id">` (or set `initialEntries` and read `useParams`
directly via a wrapping route, matching however `ConversationDetailPage` is
exercised elsewhere — this file introduces the first test for it, so the harness
is new but the fetch-stub-by-URL pattern matches `ConversationDetailPage.tsx`'s own
three-call shape).

1. **Error banner wraps long tokens:** detail with `error` set to a ~300-char
   unbroken string; assert the rendered alert (`role="alert"`) has
   `overflowWrap: "anywhere"` via `toHaveStyle`.
2. **Assistant markdown is contained:** a `response` message with one `text` part
   whose content is a fenced code block containing a ~300-char unbroken line;
   assert the `Markdown` root's parent wrapper has `overflowWrap` unnecessary but
   `overflowX: "auto"` and `minWidth: 0` (via `toHaveStyle` on the wrapping div —
   locate it as the parent of `container.querySelector(".answer.md")`).
3. **User text wraps long tokens:** a `request` message with a `user_prompt` part
   containing a long unbroken token; assert its div has both
   `whiteSpace: "pre-wrap"` and `overflowWrap: "anywhere"`.
4. `afterEach`: `cleanup()`, `vi.restoreAllMocks()`.

### `ClaudeCodePage.responsive.test.tsx` (new)

Mirrors `LivePage.responsive.test.tsx` almost exactly: stub `fetch` (for
`fetchRecentEvents`'s `GET /admin/events/recent`) to resolve `{ events: [] }`, stub
`EventSource` with the same `FakeEventSource` class, stub `matchMedia` per
`stubMatchMedia(phone)`.

1. **Desktop:** no phone stub; render; wait for hydration (`initial !== null`);
   assert the header row (parent chain from the `"Claude Code Sessions"` heading)
   has no `flexWrap` set.
2. **Phone:** `stubMatchMedia(true)`; same render/wait; assert the header row's
   `style.flexWrap === "wrap"` and `style.rowGap === "8px"`.
3. `afterEach`: `cleanup()`, `vi.unstubAllGlobals()`, `__resetMediaQueryCacheForTests()`.

No new test files for `SessionCard.tsx` — out of scope (§3).

## 6. Out of Scope

- `DashboardPage.tsx`, `TokensPage.tsx` — parallel builder's item.
- `components/organisms/SessionCard.tsx` — not one of this item's three files;
  verified already responsive (§3), not touched.
- `components/kit/JsonBlock.tsx`, `components/kit/Markdown.tsx`, `lib/markdown.ts` —
  shared across eval/chat/build/run pages outside this item's scope; the
  containment fix needed for `Markdown`'s bare `<pre class="md-pre">` output is
  applied at this page's own call site only (§3/§4), not in the shared renderer.
- `chat/chat.css` / any CSS-file changes — this item is inline-style only, matching
  every prior wave's convention for these page-level fixes.
- `components/organisms/DataTable.tsx` internals — already shipped; this item only
  consumes `hideBelow`.
- Any behavioral change: pruned columns are presentation-only; sorting, row
  navigation, and part rendering logic are untouched.

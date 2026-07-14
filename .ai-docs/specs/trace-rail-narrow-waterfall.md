# Trace rail — narrow waterfall variant

**Status:** design loop in progress (builder ↔ grader)
**Branch:** `feat/trace-rail-narrow-waterfall` (stacked on #233)
**Target files:** `packages/agent-dashboard/src/components/organisms/TraceWaterfall.tsx`, `packages/agent-dashboard/src/components/TraceRail.tsx`

## Problem

`TraceWaterfall` keeps swe-brain's 4-column grid — `gridTemplateColumns: "30px 150px 1fr 116px"` plus three `var(--space-3)` gaps ≈ **330px of fixed width before the flexible column gets a single pixel**. The organism is mounted in two places:

- **Agent Lens → Runs lens** (wide page column): works as designed.
- **Chat trace rail** (`TraceRail.tsx`, a fixed `width: 320` aside): the grid overflows. Observed failures (see `before/rail-dark.png` evidence):
  - the detail column renders one word per line ("System / prompt / + / tool / definitions / …");
  - the 116px timing column is pushed outside the rail — durations are invisible, token counts clip mid-digit;
  - tool_result status lines wrap awkwardly ("· / status / **ok**").

Since #233 the rail receives the full event vocabulary (model steps with durations + ctx/out tokens), so the rail now has MORE to show in the same broken layout.

## Design

Add an explicit **`layout` prop** to `TraceWaterfall`: `"wide"` (default, current grid, unchanged) | `"narrow"`. `TraceRail` passes `layout="narrow"`. No container queries, no CSS files — inline styles, matching the codebase idiom.

### Narrow step anatomy (stacked, full-width rows)

```
┌────────────────────────────────────────────┐
│ [⚙] Compile request context         234ms  │  ← row 1: tile · label · duration
│     CTX                                    │  ← row 2: meta line
│     System prompt + tool definitions…      │  ← row 3: detail (wraps naturally)
│ ▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁ │  ← row 4: duration bar, full width
└────────────────────────────────────────────┘

│ [◆] Model call · iteration 1        1.2s   │
│     LLM · 899 ctx · 56 out                 │
│     Planned tool calls for this turn.      │
│ ▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▁▁▁▁▁ │

│ [→] slug_and_span                    12ms  │
│     CALL · ● read · via toolsmith-plays    │
│     ▸ args                                 │
│ ▔▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁ │

│ [←] slug_and_span              ok ·  8ms   │
│     RES · ● read · 2 keys                  │
│     ▸ result                               │
```

Row rules:

1. **Row 1 (header):** kind tile (22px, unchanged styling) · primary label (tool name in mono for tool steps, step label otherwise) flexing with `overflow: hidden; textOverflow: ellipsis; whiteSpace: nowrap` · duration right-aligned mono (`—` when 0ms). The seq number under the tile is **dropped in narrow** (noise at this width; the tile glyph + kind code suffice).
2. **Row 2 (meta):** micro mono, muted — `KIND` · blast dot+word (existing `--blast-*` inks) · for model steps `N ctx · M out` · for tool steps `via <capability>` when known · for tool_result the note (`2 rows`, error text) when short. One line, ellipsize on overflow.
3. **Row 3 (detail):** the human sentence (`detail` / tool_result status) in `--fz-small`, `--ink-2`, wrapping naturally across the full width. For tool_call, drop the redundant "calls <tool>" prose (the tool name IS the header); keep nothing unless there's real detail. For tool_result render `status ok/error` inline here only when there's no room in row 1 — builder's judgment, but status must be visible somewhere without expanding.
4. **Row 4 (bar):** the relative-duration bar spans the full row width (same `maxMs` math, same `barFill()` kinds), height 5–7px.
5. **Expander:** the `▸ args` / `▸ result` toggle + `JsonBlock` render as today but full-width; the JSON block must not force horizontal page scroll (wrap or scroll internally — `overflowX: auto` on the block is fine).
6. **Iteration headers:** unchanged (they're width-agnostic dividers).
7. **Live "thinking" step:** unchanged semantics (provisional step finalized in place).

### Constraints

- **Wide layout untouched** — `layout="wide"` must render pixel-identical to today (Agent Lens regression).
- Reuse existing tokens only (`T.fz.*`, `--mute`, `--ink-2`, `--accent*`, `--ok*`, `--blast-*`, `--category-3`, `--fill`, `--line`). No new colors, no new CSS files.
- All information visible today must remain reachable in narrow: kind, tool, capability, blast, duration, tokens, status, note, args/result JSON. (Layout may demote, never delete. Exception: the seq number, deliberately dropped.)
- Keep the existing test hooks (`data-testid="waterfall-step-N"`, `waterfall-bar-N`, `waterfall-iter-header-N`) rendering in both layouts.
- `TraceRail`'s aside stays `width: 320` (the rail is shared chrome with Universe/Scratchpad tabs; widening is out of scope).
- TypeScript strict; biome clean (`bun run --filter=@agentic-patterns/dashboard check` equivalent: lint + typecheck + test at repo root).

## Acceptance criteria (grader checklist)

Evidence: run `node <scratchpad>/capture-rail.mjs <out-dir>` against the playground on :3458 (rebuild assets first: `cd packages/agent-cli && bun run build:dashboard`). Grade `rail-dark.png`, `rail-dark-open.png`, `rail-light.png`.

1. No one-word-per-line wrapping anywhere in the rail; long labels ellipsize.
2. Every step shows its duration inside the rail bounds (no clipping at the right edge).
3. Model steps show ctx/out token counts, fully visible.
4. Tool steps show the tool name prominently and blast radius; result steps surface ok/error status without expanding.
5. Duration bars span the content width and remain visually comparable (relative scaling intact).
6. Expanded args/result JSON stays inside the rail (internal wrap/scroll, no page-level horizontal scroll).
7. Iteration grouping headers still delimit setup / iteration N.
8. Legible in dark AND light themes (contrast, no invisible text).
9. No console errors during capture.
10. Wide surface unchanged: `git diff` on `TraceWaterfall.tsx` must show the wide path preserved (grader: verify by reading the diff, not screenshots, since Agent Lens needs a persisted run to render).

## Non-goals

- Data/fold changes (`trace-from-events.ts`) — #233 already delivered the vocabulary.
- Rail width changes, rail tab redesign, `TraceLog` changes.
- The `/run` LiveTracePanel (separate organism, separate surface).

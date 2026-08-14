# Structured terminal answer — closing ADR-0006 §9 in the dashboard

**Date:** 2026-07-26
**Package:** `@pattern-stack/agentic-dashboard` (`packages/agent-dashboard/`)
**Status:** Spec — ready for implementation
**Source of truth:** `docs/adr/0006-render-artifacts.md` (Accepted, on `origin/main`
as of this branch's fetch — merged via PR #377; not present in this worktree's
local `docs/` copy of `main` because the worktree predates the fetch. Read off
`origin/main` directly.)

## Relationship to the sibling artifacts slice

This worktree already carries an UNCOMMITTED, fully-tested implementation of
the OTHER half of ADR-0006 — the render-artifact channel (`tool.end` /
`message.complete` `artifacts: [...]`, `ChatArtifact`, `ArtifactBlock`,
`{ kind: "artifacts" }`) — per `.claude/specs/2026-07-26-artifacts-dashboard.md`.
That work, and the matching runtime work
(`.claude/specs/2026-07-26-artifacts-runtime.md`), already emit and consume
`structured_content` at the wire-formatting layer... **except the dashboard
never reads it.** Confirmed by grep: `structured_content`/`structuredContent`
appear nowhere in `packages/agent-dashboard/src/chat/model.ts` before this
change, only in the (out-of-scope) runtime.

This slice is the LAST integration gap ADR-0006 names: §9, "Preserve
structured terminal output" — distinct from §1-§8 (the artifacts channel,
already built). `structured_content` and `artifacts` are two different fields
on the same `message.complete` envelope; this slice only touches the former.

## The bug, restated precisely

A terminal tool's structured return value is JSON-stringified into `content`
(unchanged, for back-compat — `agent-runner.ts:754,1870`) AND preserved
structurally as `structuredContent` on the `MessageCompleteEvent`
(`agent-runtime/src/events/types.ts:95`), forwarded over SSE as
`structured_content` (`sse-formatter.ts:264-266`).

The dashboard's `ChatMessage` has no content field — an assistant bubble is
built purely from folded `Part`s (`model.ts`). The ONLY producer of
`{ kind: "text" }` parts is `message.delta`/`message.chunk` accumulation
(`model.ts:473-480`), which appends each delta verbatim. So when a terminal
tool's result is `{"answer":"...","ref":"..."}`, the model's streamed content
IS that JSON string, and it folds into an ordinary text part — which
`AssistantText` then renders as literal text (markdown-escaped braces and
all). `structured_content` arrives on the same `message.complete` event but is
silently dropped today.

## Design

### 1. `src/chat/model.ts`

**New `Part` variant** (added to the union, next to the existing `artifacts`
variant since both are ADR-0006 message.complete additions):

```ts
| { kind: "answer"; value: unknown }
```

**New accessor**, placed next to the render-artifact accessors (~line 213),
mirroring the `cost_usd`/`costUsd` dual-case read at line 656 exactly (`p`
only, camelCase checked first since that's the persisted shape, snake_case
second since that's the wire shape). Presence is checked with `in`, not `??`,
because the structured value is `unknown` — a producer could legitimately
send `null`, `false`, or `0`, and `??` would misread "present but falsy" as
absent:

```ts
function structuredContentOf(p: Record<string, unknown>): { present: boolean; value: unknown } {
  if ("structuredContent" in p) return { present: true, value: p.structuredContent };
  if ("structured_content" in p) return { present: true, value: p.structured_content };
  return { present: false, value: undefined };
}
```

**New fold helper**, placed right after it:

```ts
function applyStructuredContent(parts: Part[], value: unknown): Part[] {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    serialized = undefined;
  }
  if (serialized !== undefined) {
    for (let i = parts.length - 1; i >= 0; i--) {
      const pt = parts[i];
      if (pt && pt.kind === "text" && pt.content === serialized) {
        const copy = parts.slice();
        copy[i] = { kind: "answer", value };
        return copy;
      }
    }
  }
  return parts.concat({ kind: "answer", value });
}
```

Byte-identical match is the proof that a given text part IS the stringified
structured blob rather than legitimate prose that merely resembles JSON — the
task's exact requirement. Scanning `parts` (not `next`/`col`) top-level only is
correct: text parts are never produced inside `agent_step.children` (the
`message.delta` case operates on the top-level array unconditionally), so
there is nothing to recurse into. Scanning from the end favors the
most-recently-accumulated text part when more than one exists (rare, but
possible if a run streamed two structured answers — favors the latest, most
plausible candidate for a terminal answer without falsely claiming which is
"the" one when both could match).

**Wiring**, inside the existing `case "message.complete": case "llm.end":`
block (~line 648), guarded the same way the existing `artifacts` parse already
is (structured content, like artifacts, rides on `message.complete` only —
`llm.end` carries neither):

```ts
let outParts = parts;
if (bare(String(e.type)) === "message.complete") {
  const sc = structuredContentOf(p);
  if (sc.present) outParts = applyStructuredContent(outParts, sc.value);

  const parsedArtifacts = parseArtifacts(p.artifacts ?? col.artifacts);
  if (parsedArtifacts) {
    const seen = collectArtifactIds(outParts);
    const fresh = parsedArtifacts.filter((a) => !seen.has(a.id));
    if (fresh.length) outParts = outParts.concat({ kind: "artifacts", items: fresh });
  }
}
```

(`collectArtifactIds` now reads `outParts` instead of `parts` — harmless,
since replacing a `text` part with an `answer` part never changes what
`collectArtifactIds` looks at, being a `tool_call`/`agent_step`/`artifacts`
walk. Ordering — structured content first, artifacts second — doesn't matter
for correctness but is easy to reason about: "fix up the text, then append
anything new.")

**Replay** (`eventsToAssistantMessage`): no change needed — it drives the same
`applyParts` fold, so a persisted `message.complete` row carrying
`structuredContent` in its `payload_json` blob is handled by the same code
path (the `p`-only read already covers the persisted-row shape via `fields()`).

### 2. `src/chat/parts.tsx`

**New constant + heuristic finder**, placed near the top with the other small
helpers (`fmt`, `preview`, `count`):

```ts
/**
 * ADR-0006 §9 fallback render for a terminal tool's structured answer. This
 * key list is a DELIBERATE, CONSERVATIVE HEURISTIC, not a schema — the
 * framework has no contract with agent authors about tool return shapes (the
 * agent is not involved in artifact/answer publication, ADR §6). It exists
 * only to make the common "prose + a machine field" shape from the bug
 * report (`{"answer": "...", "ref": "..."}`) render as prose instead of raw
 * JSON. Anything that doesn't match this narrow shape EXACTLY — more than one
 * candidate key present, the candidate's value isn't a string, or the value
 * isn't a plain object at all — falls through to the JSON/CodeBlock render.
 * Never guessed, never partially unwrapped.
 */
const PROSE_KEYS = ["answer", "text", "response", "message", "summary"] as const;

function findProseField(
  value: unknown,
): { prose: string; rest: Record<string, unknown> } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const r = value as Record<string, unknown>;
  const matches = PROSE_KEYS.filter((k) => k in r && typeof r[k] === "string");
  if (matches.length !== 1) return undefined;
  const key = matches[0]!;
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(r)) if (k !== key) rest[k] = v;
  return { prose: r[key] as string, rest };
}
```

**New component**, placed near `TextPart`/`AssistantText` (same rendering
family):

```tsx
function AnswerPart({ value }: { value: unknown }) {
  const found = findProseField(value);
  if (!found) {
    const body = fmt(value);
    return <div className="chat-bubble assistant">{body && <CodeBlock text={body} copyable maxHeight={280} />}</div>;
  }
  const restKeys = Object.keys(found.rest);
  return (
    <div className="answer-part">
      <AssistantText content={found.prose} />
      {restKeys.length > 0 && (
        <details className="answer-fields">
          <summary>{count(restKeys.length, "more field")}</summary>
          <CodeBlock text={fmt(found.rest)} maxHeight={280} />
        </details>
      )}
    </div>
  );
}
```

Reuses `AssistantText` verbatim (already wired for `Markdown` + `linkifyCites`
— no new markdown/cite plumbing needed) for the prose case; reuses `fmt` +
`CodeBlock` (the same pair every other raw-payload render in this file uses)
for both the "remaining fields" disclosure and the non-object/no-prose-key
fallback. Never throws: `findProseField` returns `undefined` for any input
that isn't a plain, non-array object with exactly one string-valued prose
key, so a `string`, `number`, `null`, array, or a keyless/multi-keyed object
all safely fall through to `fmt`/`CodeBlock`.

**Dispatcher wiring** (`PartView`, ~line 1060): add

```ts
case "answer":
  return <AnswerPart value={part.value} />;
```

### 3. No CSS changes required for function

`answer-fields`/`answer-part` need no new rules to work (a plain `<details>`
and a plain wrapper `<div>` render correctly unstyled), so this slice adds
none — consistent with "don't touch packages outside dashboard" not implying
"touch every file in dashboard, needed or not." If a follow-up wants matching
chrome (e.g. the same `io-label`-style caption other disclosure blocks use),
that is a pure polish PR, not required for the bug fix.

## Explicitly out of scope

- `packages/agent-runtime/**`, `packages/agent-core/**`, `packages/agent-server/**`
  (already implement `structuredContent`/`structured_content` — read-only
  here).
- The sibling `artifacts` channel (`ChatArtifact`, `ArtifactBlock`,
  `{ kind: "artifacts" }`) — already implemented and tested in this worktree;
  untouched by this slice except for the one-line `outParts` threading change
  noted above (mechanical, not a behavior change — verified by the existing
  dedup/append tests continuing to pass unmodified).
- Any heuristic that fires when `structured_content` is ABSENT. A plain string
  answer with no `structured_content` on `message.complete` folds exactly as
  today: an ordinary `message.delta`-accumulated text part, rendered by the
  existing `TextPart`/`AssistantText` path, completely untouched by
  `structuredContentOf`/`applyStructuredContent` (which only ever runs when
  `sc.present` is true).
- `[#N]` / `crm_table:` ref-expansion changes — unaffected; `AssistantText`
  (and therefore `AnswerPart`'s prose render) already calls `linkifyCites`.

## Test plan

**`src/chat/model.test.ts`** (extend, new `describe` block near the existing
render-artifacts tests):

1. Exact-match replacement: a `message.delta` whose accumulated content is
   byte-identical to `JSON.stringify(structuredContent)`, followed by
   `message.complete` carrying that `structured_content` — the text part is
   REPLACED by `{ kind: "answer", value }`, not appended (assert final parts
   length and kind sequence).
2. No-match append: `message.complete` carries `structured_content` but no
   prior text part matches (either no text part at all, or one whose content
   differs) — the answer part is APPENDED, the original text part (if any)
   survives untouched.
3. Persisted camelCase `structuredContent` (via `payload_json`) is read the
   same as wire `structured_content`.
4. `llm.end` carrying `structured_content` is ignored (mirrors the existing
   artifacts-on-llm.end test) — rides on `message.complete` only.
5. A normal string answer with NO `structured_content` key present at all is
   completely unaffected: still folds to a plain `{ kind: "text" }`, no
   `answer` part appears, existing `message.complete` meta-only tests
   (line 142, cost tests) keep passing unmodified.
6. Interaction with artifacts: a `message.complete` carrying BOTH
   `structured_content` and `artifacts` produces both the replaced/appended
   `answer` part and the appended `artifacts` part, in the same fold.

**New `src/chat/__tests__/answer-part.test.tsx`** (mirrors
`render-artifacts.test.tsx`'s `renderPart` helper):

1. Prose-key extraction: `{ answer: "We closed 23 deals.", ref: "crm_table:e8" }`
   renders `"We closed 23 deals."` as markdown text (via the `AssistantText`
   path — assert `.chat-bubble.assistant` or equivalent contains the text) and
   the remaining `ref` field inside a collapsed `<details class="answer-fields">`.
2. Remaining-fields disclosure contains exactly the non-prose keys (e.g. `ref`
   present, `answer` absent from the disclosed JSON).
3. No prose key present (e.g. `{ ref: "x", count: 3 }`) — falls back to the
   JSON/`CodeBlock` render (`.chat-code` present containing the stringified
   object), not a crash, no fabricated prose.
4. Two prose keys present (e.g. `{ answer: "a", summary: "b" }`) — ambiguous,
   falls back to JSON (not a guess at which one is "the" answer).
5. Non-object value (a string, a number, `null`) — falls back to JSON/`fmt`
   rendering without throwing.
6. `[#N]` cite chips still linkify inside the extracted prose (reuses
   `AssistantText`, so this is mostly a smoke assertion that `.cite` appears).

## Verification

- `bun run --filter=@pattern-stack/agentic-dashboard typecheck`
- `bun run --filter=@pattern-stack/agentic-dashboard test` — baseline 511 tests
  passing must stay green; new tests add to the count.
- Do **not** run `build`/`lint`/full `check` per the task's process rules.

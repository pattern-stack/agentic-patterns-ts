# Cost of emitting `display_type` on `tool.end`

Scope: what it takes for the agentic-patterns server stack to emit `display_type` on `tool.end` (and `tool.start`), matching what the chat-patterns TUI already parses and renders.

## Current state — producer side (agentic-patterns-ts)

**Event shape has no display slot.** `ToolCallEndEvent` (`packages/agent-runtime/src/events/types.ts:105-114`) carries `toolCallId, toolName, arguments, result, error, durationMs, resultTokens` — nothing display-related. Same for `ToolCallStartEvent` (lines 97-103).

**SSE mapping is a straight field copy.** `sse-formatter.ts` `agent.tool.end` case (lines 151-160) emits `tool_call_id, tool_name, result, duration_ms` (+ `error` conditionally). No `display_type`. Notably, a precedent already exists in the same file: the `agent.backpack.*` cases conditionally emit a `display` field (`if (event.display !== undefined) payload.display = event.display;`, lines 270/283/299) sourced from author-declared metadata (`BackpackDisplay`, types.ts:305-343). The pattern to follow is established.

**Runner emission.** `agent-runner.ts` creates `agent.tool.end` at three sites (lines ~589, ~866, ~1550 — the run loop, the second loop variant, and the streaming loop). The executor contract is `toolExecutor.execute(name, args, ctx): Promise<unknown>` (`runner/toolbox-executor.ts:37`) — the raw tool result, **no envelope** where a per-invocation hint could ride today. However, the runner already holds the full tool schema list at each site (`agent.getTools() as ToolSchema[]`, lines 276/311/799/911/1128), so a static `toolName → displayType` lookup is free.

**Core metadata surface.** `ToolDefinition` (`packages/agent-core/src/molecules/toolbox.ts:54-84`) has `description, parameters, returns?, terminal?, execute` — **no tags/annotations/metadata field** a tool author can set today. `ToolSchema` (`molecules/tool-schema.ts`) mirrors this: `name, description, parameters, returns?, terminal?`. The `terminal` flag is the design precedent: *"core carries the flag, the host enforces the semantics"* (toolbox.ts:75).

## Current state — consumer side (chat-patterns)

- `internal/sse/types.go:27,36` — both `SSEToolStartData` and `SSEToolEndData` already declare `DisplayType string \`json:"display_type"\``. `parse.go:95,113` threads it onto `StreamChunk` for both start and end. Missing field just unmarshals to `""`.
- `internal/chat/view.go` renderer (the tool-call dispatch, lines ~319-373): vocabulary is **`"diff" | "code" | "bash"`**, anything else falls through to the generic header+result render. Also line 321-322: rich types hide the args line once complete.
- Rendering contracts a producer must honor per type:
  - `"diff"` — `result` must be **unified diff text** (parsed by `molecules.ParseUnifiedDiff`); file path read from `arguments["path"]`.
  - `"code"` — `result` is the code string; language inferred from `arguments["path"]`.
  - `"bash"` — `result` rendered as a bash code block.
  - Additionally `parse.go:104-107` only promotes `result` when it is a **string** (`d.Result.(string)`) — object results always land in the generic path regardless of `display_type`.

## Minimal end-to-end design (recommended: static, tool-author-declared)

`display_type` is intrinsically per-tool (read_file → code, bash → bash, edit/patch → diff), so a static declaration on the tool definition covers the need — no executor-envelope change required.

| # | Layer | File | Change |
|---|-------|------|--------|
| 1 | core L2 molecules | `toolbox.ts` | `displayType?: string` on `ToolDefinition` (+ `defineTool` spec passthrough) |
| 2 | core L2 molecules | `tool-schema.ts` | `displayType?` on `ToolSchema` ctor / `fromZod` / `toDict` |
| 3 | core L2 molecules | `toolbox.ts:176-178` | `getToolSchemas()` passes `def.displayType` through `ToolSchema.fromZod` |
| 4 | runtime L5 events | `events/types.ts` | `readonly displayType?: string` on `ToolCallStartEvent` + `ToolCallEndEvent` |
| 5 | runtime L7 runner | `agent-runner.ts` | build `Map<string,string>` from the already-fetched `agentTools`; stamp `displayType` at the 3 `tool.end` (589/866/1550) and matching `tool.start` sites |
| 6 | runtime L8 transport | `sse-formatter.ts:133,151` | `if (event.displayType !== undefined) payload.display_type = event.displayType;` — same idiom as backpack `display` |
| 7 | server | — | nothing; it relays formatter output verbatim |

**Import-rule impact per CLAUDE.md:** none violated. Core gains only a passive, uninterpreted field (identical philosophy to `terminal`); runtime already imports core (allowed); within runtime the flow is events(5) → runner(7) → transport(8), strictly downward-referencing. Core never learns about SSE or the renderer vocabulary — the string is opaque to it.

**Optional shaping decision:** instead of a bare `displayType?: string`, a small `display?: { type?: string }` object would rhyme with `BackpackSpec.display` and leave room for future hints (collapse, title). Minimal version is the bare string; either is layer-clean.

**Versioning:** touches core + runtime → `just bump-both` (core floats, runtime/server lockstep), lands via PR per protected-main policy.

## Effort size

**S/M — roughly half a day.** ~40-60 lines of production code across 4 files, plus tests (molecules schema round-trip, runner event stamping, sse-formatter payload) and a one-line docs mention. No breaking changes: every new field is optional, absent fields serialize to nothing (formatter) or `""` (Go consumer). The only real design decision is bare string vs. `display` object.

Not needed for MVP but noted: a **per-invocation** hint (same tool, different render per call) would require either a symbol-tagged result envelope unwrapped by the runner or a setter on `ToolExecutionContext` — a bigger executor-contract change; defer until a concrete tool needs it.

## Client-side heuristic as MVP alternative

**Viable, and zero server cost.** Since `DisplayType == ""` already falls through gracefully, chat-patterns can synthesize it locally when absent:

- **name sniff:** tool name contains `bash`/`shell`/`exec` → `"bash"`; `read`/`cat` + `arguments["path"]` present → `"code"`; `edit`/`write`/`patch` → `"diff"` candidate.
- **result-shape sniff:** string result containing `@@ -` hunk headers (or leading `--- `/`+++ `) → `"diff"` — unified-diff markers are distinctive enough that false positives are rare; `arguments["path"]` present → `"code"`; else generic.

Cost: ~30 lines in one Go function at the `parse.go` tool.end site (or in the chunk-merge layer), no protocol change, works against today's servers. Risk: occasional misclassification when a generic tool's output *contains* diff-like text — cosmetic only (wrong syntax highlighting), never data loss.

**Recommended sequencing:** ship the heuristic now as fallback; add the server-side field next release with the heuristic retained for `display_type == ""` — the explicit field simply overrides the sniff. The two are compatible, not either/or.

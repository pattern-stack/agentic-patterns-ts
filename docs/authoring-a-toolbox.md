---
title: "Authoring a toolbox"
description: "How to define tools and plays with defineTool/definePlay, read SessionScope in tools, and lint model-facing Zod schemas with lintModelFacingSchema."
---

How to define tools, group them into a `Toolbox`, and expose them as a `Capability` — using the
typed authoring factories (`defineTool`, `toolbox`, `capability`) added in core 0.11.0.

## Before

Subclassing is the original grammar. It still works, but every tool hand-casts its args, declares
its own wire types, and validates its own output (or forgets to):

```typescript
import { z } from "zod";
import { Capability, TextManual, type ToolDefinition, Toolbox } from "@agentic-patterns/core";

const MeetingList = z.object({ meetings: z.array(z.string()) });

class MeetingToolbox extends Toolbox {
  readonly name = "meetings";
  readonly description = "Meeting management tools";
  readonly tools: Record<string, ToolDefinition> = {
    list_meetings: {
      description: "List meetings for a day",
      parameters: z.object({ day: z.string().describe("ISO date") }),
      returns: MeetingList,
      execute: async (args) => {
        const { day } = args as { day: string }; // hand-cast — types were erased
        const result = await fetchMeetings(day);
        return MeetingList.parse(result); // hand-validated — or silently skipped
      },
    },
  };
}

const capability = new Capability(
  "meetings",
  "Meeting management",
  new MeetingToolbox(),
  new TextManual("meetings-manual", "Use list_meetings to see the day's schedule."),
);
```

## After

```typescript
import { z } from "zod";
import { capability, defineTool, TextManual, toolbox } from "@agentic-patterns/core";

const MeetingList = z.object({ meetings: z.array(z.string()) });

const meetingTools = toolbox("meetings", "Meeting management tools", {
  list_meetings: defineTool({
    description: "List meetings for a day",
    parameters: z.object({ day: z.string().describe("ISO date") }),
    returns: MeetingList,
    execute: async ({ day }) => fetchMeetings(day), // `day` is string — inferred
  }),
});

const meetings = capability({
  name: "meetings",
  description: "Meeting management",
  toolbox: meetingTools,
  manual: new TextManual("meetings-manual", "Use list_meetings to see the day's schedule."),
});
```

What changed:

- **Args arrive typed.** `execute`'s args are `z.infer` of `parameters` — the host boundary
  (`Toolbox.execute`) already parses them, so this is purely type-level. No casts, no re-parsing.
- **The return value is compile-checked** against the `returns` schema (`z.input` side), so the
  hand-declared wire-type blocks disappear.
- **Output validation is on by default.** The result is parsed through `returns`; Zod defaults,
  transforms, and unknown-key stripping apply, so the host receives exactly the declared shape.
  Violations throw a uniform, tool-named error.
- `toolbox(...)` replaces the one-shot subclass; `capability({...})` replaces the positional
  constructor. Both produce instances indistinguishable from the class forms (`instanceof` holds;
  nothing downstream changes).

## The execution contract

1. **Parameters are parsed once**, at `Toolbox.execute`. Tools never re-parse.
2. **Return validation is opt-in by construction** — plain object `ToolDefinition`s keep their
   current behavior (`returns` stays metadata-only); only `defineTool`-built tools validate.
3. **The parsed output reaches the host/model.** Declare shape-preserving transforms if the
   emitted value must match the JSON schema shown to the model (`zod-to-json-schema` renders the
   input side and cannot express arbitrary transforms).
4. **Named errors arise at the toolbox boundary.** A tool has no intrinsic name (the record key is
   the name), so `Toolbox.execute` is where a violation gains its message:
   `tool 'list_meetings' output violated its returns schema: …` — with the original `ZodError`
   preserved as `cause`. Ordinary exceptions from `execute` pass through untouched, by identity.
5. **`validateReturns: false`** skips parsing entirely: the callback's value is returned verbatim
   (no transforms, no stripping), while compile-time checking and schema introspection remain.

## Reading the run scope

A tool that needs to know who it's acting for reads the conversation's bound `SessionScope`
(`@agentic-patterns/core`) via `requireScope`/`readScope` (`@agentic-patterns/runtime`) instead of a
constructor closure. Both accept a tool's `execute(args, ctx)` second argument directly:

```typescript
import { z } from "zod";
import { defineTool } from "@agentic-patterns/core";
import type { ToolExecutionContext } from "@agentic-patterns/core";
import { requireScope } from "@agentic-patterns/runtime";

const whoami = defineTool({
  description: "Who this run is acting on behalf of.",
  parameters: z.object({}),
  returns: z.object({ operator: z.string(), tier: z.enum(["free", "pro", "enterprise"]) }),
  execute: async (_args, ctx?: ToolExecutionContext) => {
    const scope = requireScope(ctx) as { operator: string; tier: "free" | "pro" | "enterprise" };
    return { operator: scope.operator, tier: scope.tier };
  },
});
```

`requireScope` is the fail-loud default: it throws `ScopeUnavailableError` (with remediation text)
when the run carries no `host.scope` at all — the right behavior for a tool that genuinely can't do
its job scope-less. A tool with a legitimate scope-less fallback should use `readScope(ctx)` instead,
which returns `undefined` rather than throwing; branch on that explicitly instead of assuming scope
is always present.

This only works when the agent's registration declares a `scope` (a `SessionScope` from
`@agentic-patterns/core`) — see `examples/agents/support-desk` for the full pattern, including the
case where the registration has no `instantiate` hook at all and tools read scope live at call time
instead of from a build-time closure.

## Authoring a play

Plays are like tools but with error-envelope semantics: a `Playbook` never throws from `execute` —
unknown play, parameter-validation failure, and execution error all come back as `{ error: message
}` instead. `definePlay` (core 0.16.0, issue #266) is the play-side counterpart of `defineTool`:
args arrive typed, the return value is compile-checked against `returns`, and output is validated
by default.

```typescript
import { z } from "zod";
import { definePlay, playbook } from "@agentic-patterns/core";

const plays = playbook("recipes", "Named multi-step recipes", {
  slug_and_span: definePlay({
    description: "Slugify a title and report how many days until a target date.",
    parameters: z.object({
      title: z.string(),
      from: z.string().describe("ISO date"),
      to: z.string().describe("ISO date"),
    }),
    returns: z.object({ slug: z.string(), days: z.number() }),
    execute: async ({ title, from, to }) => {
      const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-");
      const days = Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);
      return { slug, days };
    },
  }),
});
```

What's different from `defineTool`:

- **`returns` is REQUIRED**, not optional. A `definePlay` with no `returns` would be
  indistinguishable from "validation not configured" — exactly the plain-`PlayDefinition` behavior
  this factory exists to opt out of.
- **No `terminal`.** Plays are deliberately never terminal.
- **No `ctx`.** Plays don't receive `ToolExecutionContext` — out of scope for #266 (ADR 0005
  precedent); `execute` takes only the parsed args.
- **Violations never throw past `Playbook.execute`.** A `definePlay` whose output fails `returns`
  throws internally, tagged; `Playbook.execute` catches the tag before its generic catch and
  returns `{ error: "play 'x' output violated its returns schema: …" }` — never a rejection. Calling
  `.execute()` on the returned `PlayDefinition` directly (bypassing a `Playbook`) DOES throw the
  tagged error; that's outside the supported path.

**The plain-`PlayDefinition` invariant is unchanged.** A hand-written object literal — `{
description, parameters, returns, execute }` assigned straight into a `plays` record without
`definePlay` — behaves exactly as it always has: `returns` stays metadata only, nothing validates
it. Only `definePlay`-built plays gain runtime validation.

**The D2 caveat: validated does not mean "matches what the host receives."** `definePlay`'s
validation runs on the LIVE value your callback returns, before `Playbook.execute`'s
`JSON.parse(JSON.stringify(...))` round-trip. A `z.date()` field validates against a real `Date`;
the round-trip then flattens it to an ISO string. If the post-serialization shape must match
`returns` exactly, declare a shape-preserving transform (e.g. `z.date().transform((d) =>
d.toISOString())`) rather than relying on the raw type.

**Tool-wins-on-collision — ToolboxExecutor (AgentRunner) path.** On that path (used when the
runner dispatches a tool call by name), a toolbox tool and a playbook play with the same name are
both registered fine — `toolLookup` and `playLookup` (in
`packages/agent-runtime/src/runner/toolbox-executor.ts`) are agent-wide flat maps accumulated
across every capability, not scoped to one capability — but at dispatch `toolLookup` is checked
before `playLookup`, so the play is silently shadowed. This is deterministic regardless of
capability registration order, and applies across capabilities too: a tool in one capability
shadows a same-named play in a different one.

**On the SDK-bridge path (Claude Code) this same collision is FATAL, not shadowing.** `buildCapabilityServer`
registers each capability's tools and plays as SDK tools on one MCP server; if a toolbox tool and a
playbook play share a name, server construction throws (`Tool <name> is already registered`) before
the server exists — there is no "wins", just a hard failure at capability-build time. Name every
play distinctly from every tool reachable by the agent (not just within the same capability) to
avoid both failure modes.

`playbook(name, description, plays)` mirrors `toolbox(...)` — a literal `Playbook` over a static
play record, record retained by reference, `instanceof Playbook` holds.

## Lint model-facing schemas in CI

`lintModelFacingSchema` (core 0.12.0, issue #265) is a pure, structural Zod walker that flags
constructs a given provider's model-facing conversion path can't represent faithfully. It imports
only the Zod type surface — no vendor SDKs, no runtime code, no network/environment access — and
never mutates the schema or throws for a finding; it just returns `SchemaLintFinding[]`.

```typescript
import { lintModelFacingSchema } from "@agentic-patterns/core";

const findings = lintModelFacingSchema(schema, {
  dialect: "gemini-bifrost", // @default — see the dialect matrix below
  requireDescribe: false, // @default — opt in for authoring-quality warnings
});
```

### Dialect matrix

Dialects are closed, data-driven rule sets — there is no runtime rule registration:

| Dialect | Error rules | Represents |
|---|---|---|
| `gemini-bifrost` (default) | `exclusive-numeric-bound`, `recursive-lazy`, `tuple` | The OpenAPI 3 `zod-to-json-schema` conversion path used for tool/return schemas — boolean `exclusiveMinimum`/`exclusiveMaximum` (from `.positive()`/`.gt()`/`.negative()`/`.lt()`), unresolvable `z.lazy()` cycles, and positional `z.tuple(...)` items are all unsupported or unfaithful there. |
| `openai` | `optional-without-nullable` | OpenAI's structured-output conversion, where an object property that is `.optional()` without also being nullable is rejected. The API has no general "surface" option, so this dialect intentionally covers only that one construct — it does not imply every OpenAI tool-input schema rejects optionals; run it against **structured-output** schemas, not ordinary tool parameters. |

A fifth code, `missing-description`, is dialect-independent: it warns (never errors) when an
object-property leaf has no `.describe()`, and only runs when `requireDescribe: true` is passed —
it is an authoring-quality opt-in, not a provider validity rule.

### Traverse tool parameters and returns with `gemini-bifrost`

```typescript
for (const [name, tool] of Object.entries(toolbox.tools)) {
  for (const finding of lintModelFacingSchema(tool.parameters)) {
    console.log(`${name}.parameters: [${finding.code}] ${finding.path} — ${finding.message}`);
  }
  if (tool.returns) {
    for (const finding of lintModelFacingSchema(tool.returns)) {
      console.log(`${name}.returns: [${finding.code}] ${finding.path} — ${finding.message}`);
    }
  }
}
```

### Check structured-output schemas with `openai`

```typescript
const findings = lintModelFacingSchema(structuredOutputSchema, { dialect: "openai" });
// A required nullable field is clean; `.optional().nullable()` (either order) is clean too —
// only a bare `.optional()` on an object property is flagged. Prefer a required nullable field
// over an optional one for structured output.
```

### Fail CI on errors, opt into description warnings

```typescript
const findings = lintModelFacingSchema(schema, { requireDescribe: true });
const errors = findings.filter((f) => f.severity === "error");
if (errors.length > 0) {
  throw new Error(errors.map((f) => `[${f.code}] ${f.path}: ${f.message}`).join("\n"));
}
// `severity === "warning"` findings (missing-description) are safe to log without failing CI.
```

This repository wires exactly this pattern into its own required `check` pipeline:
`tools/check-model-facing-schemas.ts` lints every shipped preset/example tool's `parameters` and
`returns`, plus playbook plays and core `ManualToolbox`'s built-in tools, under `gemini-bifrost`
with `requireDescribe: false`, and throws (labeled by agent/capability/tool/schema) on any
finding — zero findings is an acceptance bar, checked on every `bun run check`.

### Why `defineTool` never auto-lints

`defineTool` does not call the linter, even in development:

- PR-1 (`defineTool`/`toolbox`/`capability`) must not depend on PR-2 (the linter) landing.
- `defineTool` cannot infer the eventual host/provider dialect — that's a deployment decision, not
  an authoring-time one.
- An import-time or construction-time check would create environment-dependent side effects (and
  isn't portable across Node, browser, and bundler consumers).

The intended integration is explicit consumer smoke/CI code — call `lintModelFacingSchema`
yourself once you know which dialect(s) your deployment targets, the way this repo's own
`tools/check-model-facing-schemas.ts` does.

## Migration notes

- Migrate one tool at a time — `defineTool` returns a plain `ToolDefinition`, so factory-built and
  hand-written tools coexist in the same record.
- Tools that already self-call `returns.parse(...)` should drop that call when adopting
  `defineTool` (it would otherwise run twice).
- Tools that intentionally emit undeclared keys can set `validateReturns: false` while their
  schema catches up.

## Non-goals

Deliberately out of scope (see issue #264): automatic camel↔snake casing mappers, compression of
`.describe()` prose, and host-specific filter envelopes.

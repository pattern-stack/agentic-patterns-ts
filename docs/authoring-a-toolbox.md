# Authoring a toolbox

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

## Migration notes

- Migrate one tool at a time — `defineTool` returns a plain `ToolDefinition`, so factory-built and
  hand-written tools coexist in the same record.
- Tools that already self-call `returns.parse(...)` should drop that call when adopting
  `defineTool` (it would otherwise run twice).
- Tools that intentionally emit undeclared keys can set `validateReturns: false` while their
  schema catches up.

## Non-goals

Deliberately out of scope (see issue #264): automatic camel↔snake casing mappers, compression of
`.describe()` prose, and host-specific filter envelopes. Playbook parity (`definePlay`, a
`playbook()` literal) is tracked separately in #266; a static model-facing schema linter is
tracked in #265.

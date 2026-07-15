# Implementation strategy — issue #264: `core: tool-authoring sugar`

## Scope and PR slicing

Add opt-in tool-authoring helpers to `@agentic-patterns/core` without changing existing `ToolDefinition` behavior, then add a separately landable static model-facing schema linter.

Land in this order:

| PR | Scope | Tracking/versioning |
|---|---|---|
| **PR-1 — typed tool and literal composition factories** | `defineTool`, `toolbox`, `capability`, tests, authoring guide | Subsumes and closes #43. Minor-bump core from `0.10.0` to `0.11.0`; no runtime/server/CLI bump. |
| **PR-2 — model-facing schema linter** | `lintModelFacingSchema`, dialect rule sets, tests, example-agent sweep, docs | Open a linked child issue, `core: lint model-facing Zod schemas`, so it can land independently. Minor-bump core to `0.12.0`; close #264 after both PRs. |

Production code changes remain core-only. Runtime, server, and CLI source/manifests need no changes: current consumers inspect toolbox objects structurally and dispatch through `toolbox.execute`, not through subclass names ([toolbox-executor.ts:96](/Users/dug/Projects/dug/agentic-patterns-ts/packages/agent-runtime/src/runner/toolbox-executor.ts:96), [sdk-bridge.ts:38](/Users/dug/Projects/dug/agentic-patterns-ts/packages/agent-runtime/src/runner/sdk-bridge.ts:38), [composition.ts:873](/Users/dug/Projects/dug/agentic-patterns-ts/packages/agent-server/src/routes/composition.ts:873), [tools.ts:147](/Users/dug/Projects/dug/agentic-patterns-ts/packages/agent-cli/src/commands/tools.ts:147)). This respects the core-downward dependency rule ([CLAUDE.md:84](/Users/dug/Projects/dug/agentic-patterns-ts/CLAUDE.md:84)) and independent core versioning ([CLAUDE.md:70](/Users/dug/Projects/dug/agentic-patterns-ts/CLAUDE.md:70)).

---

## Current state

### Tool definitions and execution

`ToolDefinition` is non-generic. `parameters` and `returns` are both `ZodTypeAny`, while `execute` receives `Record<string, unknown>` and resolves to `unknown` ([toolbox.ts:54](/Users/dug/Projects/dug/agentic-patterns-ts/packages/agent-core/src/molecules/toolbox.ts:54), [toolbox.ts:81](/Users/dug/Projects/dug/agentic-patterns-ts/packages/agent-core/src/molecules/toolbox.ts:81)). Its `returns` documentation still promises only “future output validation” ([toolbox.ts:57](/Users/dug/Projects/dug/agentic-patterns-ts/packages/agent-core/src/molecules/toolbox.ts:57)).

`Toolbox.execute` already owns the input boundary: it looks up the named tool, parses `parameters`, and forwards the parsed arguments plus the original context verbatim ([toolbox.ts:115](/Users/dug/Projects/dug/agentic-patterns-ts/packages/agent-core/src/molecules/toolbox.ts:115)). The context-reference behavior is explicitly tested ([toolbox.test.ts:123](/Users/dug/Projects/dug/agentic-patterns-ts/packages/agent-core/src/molecules/__tests__/toolbox.test.ts:123)).

`ToolSchema.fromZod` converts both parameter and return schemas with the OpenAPI 3 target and carries `terminal` through to model-facing metadata ([tool-schema.ts:78](/Users/dug/Projects/dug/agentic-patterns-ts/packages/agent-core/src/molecules/tool-schema.ts:78)). `Toolbox.getToolSchemas` supplies the record key as the tool name ([toolbox.ts:95](/Users/dug/Projects/dug/agentic-patterns-ts/packages/agent-core/src/molecules/toolbox.ts:95)).

The runtime already provides a useful factory precedent: `nodeTool()` accepts typed input schema data and returns a plain `ToolDefinition` ([node-tool.ts:22](/Users/dug/Projects/dug/agentic-patterns-ts/packages/agent-runtime/src/workflows/node-tool.ts:22), [node-tool.ts:37](/Users/dug/Projects/dug/agentic-patterns-ts/packages/agent-runtime/src/workflows/node-tool.ts:37)).

### Toolbox and capability construction

`Toolbox` is abstract and provides only inherited behavior; consumers must subclass it to supply three readonly fields ([toolbox.ts:84](/Users/dug/Projects/dug/agentic-patterns-ts/packages/agent-core/src/molecules/toolbox.ts:84)). Shipped agents consequently repeat subclass and cast ceremony; the calculator preset is representative ([calculator.ts:28](/Users/dug/Projects/dug/agentic-patterns-ts/packages/agent-runtime/src/presets/agents/calculator.ts:28), [calculator.ts:39](/Users/dug/Projects/dug/agentic-patterns-ts/packages/agent-runtime/src/presets/agents/calculator.ts:39)).

`Capability` takes five positional arguments and freezes the resulting instance ([capability.ts:20](/Users/dug/Projects/dug/agentic-patterns-ts/packages/agent-core/src/molecules/capability.ts:20), [capability.ts:27](/Users/dug/Projects/dug/agentic-patterns-ts/packages/agent-core/src/molecules/capability.ts:27)). It delegates tool schemas to the toolbox and optional playbook and delegates guidance to the optional manual ([capability.ts:42](/Users/dug/Projects/dug/agentic-patterns-ts/packages/agent-core/src/molecules/capability.ts:42), [capability.ts:51](/Users/dug/Projects/dug/agentic-patterns-ts/packages/agent-core/src/molecules/capability.ts:51)).

`TextManual` and `SimpleManual` are concrete constructor-based alternatives to subclassing `Manual` ([manual.ts:140](/Users/dug/Projects/dug/agentic-patterns-ts/packages/agent-core/src/molecules/manual.ts:140), [manual.ts:162](/Users/dug/Projects/dug/agentic-patterns-ts/packages/agent-core/src/molecules/manual.ts:162)).

### Playbooks

`PlayDefinition` repeats the untyped parameter/return debt, and its `returns` documentation contains the same deferred-validation promise ([playbook.ts:23](/Users/dug/Projects/dug/agentic-patterns-ts/packages/agent-core/src/molecules/playbook.ts:23)). Unlike tools, plays are executed inside a catch-all envelope and successful values are JSON-serialized before being returned ([playbook.ts:64](/Users/dug/Projects/dug/agentic-patterns-ts/packages/agent-core/src/molecules/playbook.ts:64)).

The existing test fixture even declares an object `returns` schema for a play that returns a string, demonstrating that the schema is metadata only today ([playbook.test.ts:18](/Users/dug/Projects/dug/agentic-patterns-ts/packages/agent-core/src/molecules/__tests__/playbook.test.ts:18)).

### Public and declaration surfaces

Molecule values and types are explicitly exported from the molecule barrel, and the package root re-exports that barrel ([molecules/index.ts:1](/Users/dug/Projects/dug/agentic-patterns-ts/packages/agent-core/src/molecules/index.ts:1), [src/index.ts:3](/Users/dug/Projects/dug/agentic-patterns-ts/packages/agent-core/src/index.ts:3)). Core publishes generated ESM/CJS declarations through a single package root ([package.json:21](/Users/dug/Projects/dug/agentic-patterns-ts/packages/agent-core/package.json:21), [tsup.config.ts:3](/Users/dug/Projects/dug/agentic-patterns-ts/packages/agent-core/tsup.config.ts:3)).

Tests live beside molecule code under `src/molecules/__tests__` and mix runtime assertions with compile-time `ToolDefinition` assignment checks ([toolbox.test.ts:1](/Users/dug/Projects/dug/agentic-patterns-ts/packages/agent-core/src/molecules/__tests__/toolbox.test.ts:1), [toolbox.test.ts:171](/Users/dug/Projects/dug/agentic-patterns-ts/packages/agent-core/src/molecules/__tests__/toolbox.test.ts:171)).

## Corrections to the issue

1. **The proposed `defineTool` input has no tool name.** The name exists only as the key in `Toolbox.tools`, so the factory alone cannot produce a tool-named error. The guarantee must be defined at the canonical `Toolbox.execute(name, …)` boundary, which already owns name lookup and parameter parsing ([toolbox.ts:115](/Users/dug/Projects/dug/agentic-patterns-ts/packages/agent-core/src/molecules/toolbox.ts:115)). All in-repo hosts use that boundary.

2. **`PlayDefinition` and `ToolDefinition` are not literally identical.** They share the untyped execute/returns debt, but tools also have `terminal` and `ToolExecutionContext`; plays instead have error-envelope and JSON-serialization semantics ([toolbox.ts:65](/Users/dug/Projects/dug/agentic-patterns-ts/packages/agent-core/src/molecules/toolbox.ts:65), [playbook.ts:23](/Users/dug/Projects/dug/agentic-patterns-ts/packages/agent-core/src/molecules/playbook.ts:23)).

3. **`.negative()` produces an exclusive maximum, not an exclusive minimum.** Installed Zod implements `.positive()` as an exclusive `min` and `.negative()` as an exclusive `max` (`node_modules/.bun/zod@3.25.76/node_modules/zod/src/v3/types.ts:1509` and `:1518`). The installed OpenAPI converter turns those into boolean `exclusiveMinimum` and `exclusiveMaximum`, respectively (`node_modules/.bun/zod-to-json-schema@3.25.2+27912429049419a2/node_modules/zod-to-json-schema/dist/esm/parsers/number.js:14` and `:30`). The linter rule therefore must detect both exclusive lower and upper bounds.

4. **The manuals are concrete literal-style classes, not object-literal factory functions.** They remain a valid ergonomic precedent, but not an exact API precedent.

5. **The core README’s current molecule example is invalid.** It instantiates the abstract `Toolbox` and passes the wrong positional shape to `Capability` ([packages/agent-core/README.md:81](/Users/dug/Projects/dug/agentic-patterns-ts/packages/agent-core/README.md:81)). PR-1 should replace this example rather than build new documentation beside a known-broken example.

---

## Design decisions

### 1. Keep typing in `defineTool`; do not genericize `ToolDefinition`

**Decision:** `ToolDefinition` remains exactly non-generic. `defineTool<P, R>` uses schema generics only while contextually checking the author’s callback and explicitly returns `ToolDefinition`.

This gives authors:

- `args` as `z.infer<P>`, including defaults/transforms already applied by `Toolbox.execute`.
- A required return schema.
- A callback result checked against `z.input<R>`.
- An exported or re-exported result whose inferred declaration type is simply `ToolDefinition`.

This is the safe package-boundary shape. The repository already records a concrete failure where a bare `z.infer` leaked a Zod 3 `ZodEnum` into a published declaration and was reinterpreted under another Zod major as a garbage union ([eval/types.ts:28](/Users/dug/Projects/dug/agentic-patterns-ts/packages/agent-runtime/src/eval/types.ts:28)). Core builds against Zod `3.25.76` while accepting either Zod 3 or 4 as a peer ([package.json:43](/Users/dug/Projects/dug/agentic-patterns-ts/packages/agent-core/package.json:43)).

**Rejected:** `ToolDefinition<P, R>` with defaults. Even if source-compatible, it would encourage inferred consumer declarations to retain concrete Zod parameter types across the package boundary—the exact risk class documented above. It would also force generic propagation through every structural consumer for no runtime benefit.

### 2. Validate and return the parsed value

**Decision:** When `validateReturns` is omitted or `true`, the wrapper awaits the author callback, parses that raw value with `returns.parseAsync`, and returns the parsed `z.output<R>` value. Zod transforms, defaults, readonly behavior, and unknown-key stripping therefore affect the value delivered to the host/model.

Rationale:

- Calling something “parsed” should have normal Zod semantics.
- The declared return schema is model-facing metadata; returning a value normalized to that contract is preferable to delivering undeclared keys.
- The author callback is correctly checked against the schema’s pre-parse input, hence `Promise<z.input<R>>`.

This intentionally differs from `assertingNode`, which validates and returns the original node result ([sequential-agents.ts:361](/Users/dug/Projects/dug/agentic-patterns-ts/packages/agent-runtime/src/workflows/sequential-agents.ts:361), [sequential-agents.ts:381](/Users/dug/Projects/dug/agentic-patterns-ts/packages/agent-runtime/src/workflows/sequential-agents.ts:381)). That primitive explicitly treats the node’s own output as an already-established typed boundary. `defineTool` establishes the tool output boundary itself.

When `validateReturns: false`:

- Do not call `parse` or `parseAsync`.
- Return the author callback’s value verbatim.
- Keep compile-time `z.input<R>` checking.
- Keep `returns` on the resulting `ToolDefinition` for schema introspection.
- Do not apply transforms, defaults, stripping, or freezing.

Type-changing Zod transforms can make the emitted value differ from the JSON schema generated by `zod-to-json-schema`. Document that model-facing `returns` schemas should normally use shape-preserving transforms; the factory will nevertheless honor Zod’s parsed-output semantics.

#### Named error mechanism

`defineTool` should tag return-validation failures with a private `Symbol.for(...)` marker and preserve the original parse error as `cause`. `Toolbox.execute`, which knows the record key, catches only that marker and throws:

```text
tool 'list_meetings' output violated its returns schema: <Zod detail>
```

Use a globally registered symbol rather than an internal error-class `instanceof` check because the runtime explicitly documents deployments with two copies of core and avoids nominal checks for that reason ([toolbox-executor.ts:146](/Users/dug/Projects/dug/agentic-patterns-ts/packages/agent-runtime/src/runner/toolbox-executor.ts:146)).

Ordinary exceptions from the author’s `execute` callback pass through unchanged. Parameter-validation errors remain unchanged. Direct calls to `definition.execute` still validate returns but cannot receive a tool name; as with parameter parsing today, the fully named boundary guarantee applies to `Toolbox.execute`.

### 3. Defer Playbook parity

**Decision:** Do not add `definePlay` or `playbook()` in either PR.

Open a separate follow-up issue covering both. It must explicitly decide:

- Whether output-schema failures throw or become `{ error }`.
- Whether parsing happens before or after JSON serialization.
- Whether plays gain `ToolExecutionContext`.
- Whether parsed transforms are emitted or only asserted.
- Whether a playbook literal factory is introduced at the same time.

Adding tool semantics mechanically would risk changing Playbook’s established “never throw to the host” behavior ([playbook.ts:67](/Users/dug/Projects/dug/agentic-patterns-ts/packages/agent-core/src/molecules/playbook.ts:67)). The shared debt is real, but the execution contracts are different enough to require their own design.

### 4. Put the linter in core as a pure, dialect-driven Zod walker

**Decision:** `lintModelFacingSchema` belongs in `packages/agent-core/src/molecules/`. It imports only the Zod type surface and walks Zod definitions structurally. It must not import provider SDKs, runtime code, environment variables, or network behavior.

This is compatible with core’s vendor-neutral role because:

- Core already owns model-facing schema conversion and OpenAI/Claude/Vercel shapes in `ToolSchema` ([tool-schema.ts:1](/Users/dug/Projects/dug/agentic-patterns-ts/packages/agent-core/src/molecules/tool-schema.ts:1)).
- Dialect names select data/rule sets; they do not introduce vendor dependencies.
- The runtime’s existing schema guard demonstrates a version-tolerant Zod 3 `_def` / Zod 4 `_zod.def` walker ([schema-guard.ts:23](/Users/dug/Projects/dug/agentic-patterns-ts/packages/agent-runtime/src/runner/schema-guard.ts:23)).

Use one normalized walker and a private rule registry:

```ts
const DIALECT_RULES: Record<SchemaLintDialect, readonly SchemaRuleId[]>;
```

Adding a dialect requires, in the same PR:

1. Extending `SchemaLintDialect`.
2. Adding its rule IDs to `DIALECT_RULES`.
3. Adding tests for each enabled rule and at least one clean schema.
4. Documenting the conversion path the dialect represents.

Do not expose runtime rule registration in v1.

Defaults:

- `dialect: "gemini-bifrost"`
- `requireDescribe: false`

`requireDescribe` is opt-in because it is an authoring-quality policy, not a provider validity rule. When enabled, it emits warnings only.

The dialect meanings are deliberately narrow:

| Dialect | Error rules |
|---|---|
| `gemini-bifrost` | Exclusive numeric lower/upper bounds; recursive `z.lazy` cycles; `z.tuple` |
| `openai` | Structured-output object properties using `.optional()` without a nullable value form |

The `openai` dialect represents the structured-output conversion path described by the issue. Because the API has no `surface` option, documentation must not claim that every OpenAI tool-input schema rejects optionals.

#### No automatic linting in `defineTool`

Do not auto-run the linter, even in development:

- PR-1 must not depend on PR-2.
- `defineTool` cannot infer the eventual host/provider dialect.
- Import-time warnings create environment-dependent side effects.
- A generic “dev mode” check is not portable across Node, browser, and bundler consumers.

The intended integration is explicit consumer smoke/CI code.

### 5. Naming

- Use **`defineTool`**, not `tool`, because runtime consumers already import the Vercel AI SDK’s `tool()` alongside core APIs ([agent-runner.ts:24](/Users/dug/Projects/dug/agentic-patterns-ts/packages/agent-runtime/src/runner/agent-runner.ts:24)).
- Keep **`toolbox()`** and **`capability()`** as bare nouns. They match the repository’s existing compact factory grammar: `nodeTool`, `delegateTo`, and `asAgent` ([node-tool.ts:37](/Users/dug/Projects/dug/agentic-patterns-ts/packages/agent-runtime/src/workflows/node-tool.ts:37), [node-tool.ts:165](/Users/dug/Projects/dug/agentic-patterns-ts/packages/agent-runtime/src/workflows/node-tool.ts:165), [as-agent.ts:141](/Users/dug/Projects/dug/agentic-patterns-ts/packages/agent-runtime/src/workflows/as-agent.ts:141)).
- The toolbox record key remains the sole tool name. Do not add a duplicated `name` field to `defineTool`.

---

## API design

### `defineTool`

```ts
import type { z, ZodTypeAny } from "zod";

/**
 * Define a schema-typed tool while returning the framework's stable,
 * non-generic ToolDefinition surface.
 *
 * Arguments are contextually typed from `parameters`. The callback's raw
 * result must satisfy `z.input<R>`. Unless disabled, the result is parsed
 * through `returns` and the parsed `z.output<R>` is delivered by
 * Toolbox.execute.
 *
 * @remarks
 * Named validation errors are guaranteed at Toolbox.execute(name, ...),
 * because a ToolDefinition has no intrinsic name.
 */
export function defineTool<P extends ZodTypeAny, R extends ZodTypeAny>(spec: {
  description: string;
  parameters: P;
  returns: R;
  terminal?: boolean;
  /**
   * Parse output through `returns` before returning it.
   * @default true
   */
  validateReturns?: boolean;
  execute: (
    args: z.infer<P>,
    ctx?: ToolExecutionContext,
  ) => Promise<z.input<R>>;
}): ToolDefinition;
```

Behavioral requirements:

- Do not parse parameters again; `Toolbox.execute` already does so.
- Forward the identical `ctx` reference.
- Always expose `description`, `parameters`, and `returns`.
- Pass `terminal` through unchanged, preserving omission when it is `undefined`.
- Do not expose `validateReturns` on `ToolDefinition`.
- Do not freeze the returned definition or schemas.
- Parse asynchronously to support async refinements/transforms.

### `toolbox`

```ts
/**
 * Create a concrete Toolbox from a static tool record.
 *
 * The supplied record is retained by reference; inherited schema,
 * name-listing, and execution behavior is unchanged.
 */
export function toolbox(
  name: string,
  description: string,
  tools: Record<string, ToolDefinition>,
): Toolbox;
```

Implement with a private `LiteralToolbox extends Toolbox`.

Do not freeze the instance or clone/freeze the tool record. Existing `Toolbox` subclasses are not frozen, and preserving record identity matters to decorators and composition code. The result must satisfy `instanceof Toolbox` and inherit `getToolSchemas`, `getToolNames`, and `execute` unchanged.

### `capability`

```ts
/**
 * Create a Capability using a named object literal instead of the
 * positional constructor.
 */
export function capability(spec: {
  name: string;
  description: string;
  toolbox: Toolbox;
  manual?: Manual;
  playbook?: Playbook;
}): Capability;
```

Implementation is exactly:

```ts
return new Capability(
  spec.name,
  spec.description,
  spec.toolbox,
  spec.manual,
  spec.playbook,
);
```

This deliberately preserves constructor freezing and all existing methods.

### Schema linter

```ts
import type { ZodTypeAny } from "zod";

export type SchemaLintDialect = "gemini-bifrost" | "openai";

export type SchemaLintSeverity = "error" | "warning";

export type SchemaLintCode =
  | "exclusive-numeric-bound"
  | "recursive-lazy"
  | "tuple"
  | "optional-without-nullable"
  | "missing-description";

export interface SchemaLintFinding {
  readonly code: SchemaLintCode;
  readonly severity: SchemaLintSeverity;
  /** JSONPath-like location: $, $.field, $.items[], $.tuple[0]. */
  readonly path: string;
  readonly dialect: SchemaLintDialect;
  readonly message: string;
}

export interface SchemaLintOptions {
  /**
   * Provider/conversion-path rule set.
   * @default "gemini-bifrost"
   */
  readonly dialect?: SchemaLintDialect;
  /**
   * Warn when an object-property leaf has no `.describe()` metadata.
   * @default false
   */
  readonly requireDescribe?: boolean;
}

/**
 * Statically inspect a Zod schema for constructs unsupported by a
 * model-facing conversion path. Never throws for lint findings and never
 * mutates the schema.
 */
export function lintModelFacingSchema(
  schema: ZodTypeAny,
  opts?: SchemaLintOptions,
): SchemaLintFinding[];
```

Walker semantics:

- Support Zod 3 `_def.typeName` and Zod 4 `_zod.def.type`.
- Detect exclusive `min` and `max` checks through transparent wrappers.
- Detect actual recursive lazy cycles using an active DFS ancestor set. Do not flag a non-recursive lazy wrapper merely for being lazy.
- Flag a tuple at its own path, then stop descending for dialect errors; it may still be inspected for description warnings if requested.
- Apply `optional-without-nullable` to object properties, not arbitrary root schemas. A nullable optional form is not flagged, though documentation should recommend replacing an optional field with a required nullable field for structured output.
- Define “leaf” as an object property whose unwrapped schema does not lead to another object-property structure. Arrays of primitives use the property path; arrays of objects recurse with `[]`.
- A description on any transparent wrapper at that property boundary satisfies `requireDescribe`; a parent object’s description does not satisfy its child leaves.
- Return findings in deterministic depth-first path order and avoid duplicate `(code, path)` entries.
- Return fresh plain objects and an ordinary mutable array; readonly fields are a type contract, not a new deep-freezing policy.

---

## File-by-file change plan

### PR-1

#### `packages/agent-core/src/molecules/toolbox.ts`

- Replace the “future output validation” wording with current behavior:
  - Legacy object definitions remain metadata-only.
  - `defineTool` opts into validation.
- Add `defineTool`.
- Add the private globally tagged output-validation failure mechanism.
- Extend `Toolbox.execute` with a narrow catch that adds the tool name only for tagged return-schema failures.
- Add the private `LiteralToolbox` and exported `toolbox()` factory.
- Preserve parameter parsing and verbatim context forwarding.

#### `packages/agent-core/src/molecules/capability.ts`

- Add exported `capability(spec)`.
- Implement only as a positional-constructor adapter.

#### `packages/agent-core/src/molecules/index.ts`

Change value exports to include:

```ts
export { Toolbox, defineTool, toolbox } from "./toolbox.js";
export { Capability, capability } from "./capability.js";
```

No change is needed in `src/index.ts`; it already star-exports the molecule barrel.

#### `packages/agent-core/src/molecules/__tests__/tool-authoring.test.ts` — new

Add the PR-1 runtime and type-level tests described below.

#### `docs/authoring-a-toolbox.md` — new

Add the required before/after guide.

#### `packages/agent-core/README.md`

- Replace the invalid abstract-`Toolbox` example.
- Link to the authoring guide.
- Correct the nearby Playbook/Capability constructor example while touching this section.

#### `CHANGELOG.md`

Add separate PR-1 feature bullets:

- `defineTool`: typed parameters, compile-checked schema input return, parsed output validation by default.
- `toolbox` and `capability`: literal construction helpers.

#### `packages/agent-core/package.json` and `bun.lock`

- Bump core to `0.11.0`.
- Refresh only the core workspace version metadata in the lockfile.
- Do not bump runtime, server, dashboard, or CLI.

### PR-2

#### `packages/agent-core/src/molecules/model-facing-schema-lint.ts` — new

- Define all public linter types and `lintModelFacingSchema`.
- Keep Zod-tree helpers and dialect registry private.
- Borrow the version-tolerant structural approach of the runtime guard, but do not import runtime or move the existing guard.

#### `packages/agent-core/src/molecules/index.ts`

Export:

```ts
export { lintModelFacingSchema } from "./model-facing-schema-lint.js";
export type {
  SchemaLintCode,
  SchemaLintDialect,
  SchemaLintFinding,
  SchemaLintOptions,
  SchemaLintSeverity,
} from "./model-facing-schema-lint.js";
```

#### `packages/agent-core/src/molecules/__tests__/model-facing-schema-lint.test.ts` — new

Add all dialect, path, warning, recursion, and Zod-version tests below.

#### `tools/check-model-facing-schemas.ts` — new

Create a repository acceptance sweep that:

- Builds/loads the shipped calculator, todo, writing-coach, and toolsmith agents.
- Walks every toolbox tool and playbook play.
- Lints `parameters` and present `returns` under `gemini-bifrost`, with `requireDescribe: false`.
- Throws with agent/capability/tool/schema labels if any finding is returned.

The official server demo identifies calculator, todo, and writing coach as the shipped preset set ([live-demo.ts:52](/Users/dug/Projects/dug/agentic-patterns-ts/packages/agent-server/examples/live-demo.ts:52)); the toolsmith example supplies additional nested parameters, returns schemas, and a playbook ([toolsmith/agent.ts:58](/Users/dug/Projects/dug/agentic-patterns-ts/examples/agents/toolsmith/agent.ts:58), [toolsmith/agent.ts:162](/Users/dug/Projects/dug/agentic-patterns-ts/examples/agents/toolsmith/agent.ts:162)).

#### Root `package.json`

Add `check:model-facing-schemas` and append it to `check` after build/typecheck/lint/test. The existing `check` script is the repository’s required aggregate verification path ([package.json:10](/Users/dug/Projects/dug/agentic-patterns-ts/package.json:10)).

This is an acceptance harness, not a runtime package change.

#### `docs/authoring-a-toolbox.md`

Add a “Lint model-facing schemas in CI” section showing:

- Tool parameter/return traversal with `gemini-bifrost`.
- Structured-output checking with `openai`.
- Failure on `severity === "error"`.
- Optional warnings through `requireDescribe: true`.

#### `CHANGELOG.md`

Add a separate feature bullet for the static linter and its two initial dialects.

#### `packages/agent-core/package.json` and `bun.lock`

Bump core to `0.12.0`; no lockstep package bump.

---

## Test plan

### PR-1: `defineTool`

Add these named cases to `tool-authoring.test.ts`:

1. **“infers parsed parameter output in execute”**
   - Parameters include required, optional, defaulted, and transformed fields.
   - `expectTypeOf(args)` equals the corresponding `z.infer<P>` shape.

2. **“returns a plain ToolDefinition”**
   - `expectTypeOf(definition).toEqualTypeOf<ToolDefinition>()`.
   - Runtime object contains `description`, `parameters`, `returns`, and `execute`.

3. **“compile-rejects output outside z.input<R>”**
   - Add a `// @ts-expect-error` on an `execute` callback returning a number where `returns` requires a string.
   - Add another negative case for a missing/incorrect object property.
   - The package’s `tsc --noEmit` includes `src`, so unused or ineffective expectations fail typecheck ([tsconfig.json:2](/Users/dug/Projects/dug/agentic-patterns-ts/packages/agent-core/tsconfig.json:2)).

4. **“validates returns by default and names the tool”**
   - Invoke through `toolbox.execute("list_meetings", …)`.
   - Assert the exact prefix:
     `tool 'list_meetings' output violated its returns schema:`
   - Assert the original parse error is retained as `cause`.

5. **“returns the parsed output”**
   - Use an object schema that strips an extra property.
   - Use a transform/default and assert the post-parse value is returned.

6. **“validateReturns false returns the verbatim value”**
   - Assert extra properties and pre-transform values survive.
   - Assert `returns` remains visible through `getToolSchemas()`.

7. **“does not reparse parameters”**
   - Use a parameter transform with a counter and assert it runs once at `Toolbox.execute`.

8. **“forwards ToolExecutionContext by identity”**
   - Assert the author callback receives the exact object reference.

9. **“passes terminal through”**
   - Assert `definition.terminal` and resulting `ToolSchema.terminal` are `true`.

10. **“does not rewrap ordinary execution errors”**
    - Throw a sentinel error from the callback and assert object identity is preserved.

11. **“legacy ToolDefinitions remain unvalidated”**
    - Create a plain object definition with a mismatched `returns` schema.
    - Assert existing behavior remains unchanged.

12. **“supports async return refinements/transforms”**
    - Prove the implementation uses the asynchronous parsing path.

### PR-1: literal factories

1. **“toolbox creates a Toolbox instance with inherited behavior”**
   - `instanceof Toolbox`.
   - Exact `name`, `description`, and `tools` record identity.
   - `getToolNames`, `getToolSchemas`, and `execute` match a subclass fixture.

2. **“toolbox preserves returns, terminal, and context behavior”**
   - Compare literal and subclass forms.

3. **“capability creates a frozen Capability instance”**
   - `instanceof Capability` and `Object.isFrozen(result)`.
   - Exact toolbox/manual/playbook reference identity.

4. **“capability preserves guidance and combines toolbox/playbook schemas”**
   - Assert `getGuidance`, `getTools`, and `toPrompt`.

5. **“capability works without optional manual/playbook”**

### PR-2: killer constructs

Tests must name each live-failure class directly:

1. **“gemini-bifrost: flags OpenAPI 3 boolean exclusive bounds from `.positive()`, `.gt()`, `.negative()`, and `.lt()`”**
   - Assert lower and upper bound paths.
   - Assert inclusive `.min()`/`.max()` do not produce findings.

2. **“gemini-bifrost: flags recursive `z.lazy` schemas”**
   - Assert a recursive child path such as `$.children[]`.
   - Assert a non-recursive lazy wrapper is clean.

3. **“gemini-bifrost: flags `z.tuple` array-form items”**
   - Test root and nested tuples.

4. **“openai: flags structured-output `.optional()` without `.nullable()`”**
   - Test root-object property and nested property paths.
   - Assert a required nullable field is clean.
   - Assert nullable-optional is not reported by this specifically named rule.

### PR-2: supporting linter behavior

- Default dialect is `gemini-bifrost`.
- Dialect isolation: Gemini rules do not appear under `openai`, and vice versa.
- `requireDescribe` defaults off.
- Missing leaf descriptions produce `warning`, never `error`.
- Descriptions on optional/nullable wrappers are recognized.
- Parent object descriptions do not hide undescribed child leaves.
- Nested arrays, objects, unions, intersections, effects/pipes, defaults, readonly, and branded wrappers produce correct paths.
- Reused schema nodes at different paths report both paths.
- Recursive graphs terminate deterministically.
- Finding order and deduplication are stable.
- Mirror the four killer tests with `zod/v4`, casting only at the test call boundary if the repository’s Zod 3 compile-time root makes the two `ZodTypeAny` declarations nominally incompatible. The installed Zod 3.25 package explicitly exposes the `zod/v4` subpath (`node_modules/.bun/zod@3.25.76/node_modules/zod/package.json:54`).

### Zero-false-positive sweep

`tools/check-model-facing-schemas.ts` must return zero findings for:

- Calculator preset tool parameters.
- Todo preset tool parameters.
- Writing coach, which has no tools.
- Toolsmith tool parameters and returns.
- Toolsmith playbook parameters and returns.
- `ManualToolbox`’s two built-in parameter schemas.

Run with the correct `gemini-bifrost` tool-schema dialect and `requireDescribe: false`. Do not run the `openai` structured-output rule against tool-input schemas.

### Verification commands

Each PR must pass:

```bash
bun run --filter=@agentic-patterns/core build
bun run --filter=@agentic-patterns/core typecheck
bun run --filter=@agentic-patterns/core lint
bun run --filter=@agentic-patterns/core test
bun run check
```

PR-2 additionally runs:

```bash
bun run check:model-facing-schemas
```

---

## Documentation plan

Create `docs/authoring-a-toolbox.md` with:

1. **Before**
   - `class XToolbox extends Toolbox`.
   - `Record<string, ToolDefinition>`.
   - Manual argument cast.
   - Manual output wire type.
   - Manual `returns.parse`.

2. **After**
   - Reusable `parameters` and `returns` schemas.
   - `defineTool` with inferred arguments and checked raw return.
   - `toolbox()` static record.
   - `capability()` named object.
   - Default parsed-output behavior and `validateReturns: false`.

3. **Execution contract**
   - Parameters are parsed once at `Toolbox.execute`.
   - Return validation is opt-in by adopting `defineTool`.
   - Parsed output reaches the host/model.
   - Named errors arise at the toolbox boundary.
   - Plain legacy definitions retain existing behavior.

4. **Schema linting**
   - Dialect matrix.
   - CI example.
   - `requireDescribe`.
   - Why no automatic lint occurs in `defineTool`.

5. **Migration and non-goals**
   - Migrate one tool at a time.
   - No camel/snake mapping.
   - No description compression.
   - No host-specific filter envelopes.
   - Playbook parity is tracked separately.

Add three distinct CHANGELOG bullets—one each for `defineTool`, literal factories, and schema linting—so the pieces remain independently discoverable.

---

## Risks and compatibility

| Risk | Mitigation |
|---|---|
| **Published `.d.ts` leaks concrete Zod types** | Keep `ToolDefinition` non-generic and the factory return explicitly `ToolDefinition`. Test that inferred factory output is exactly that stable type. |
| **Zod 3/4 internal skew** | Core currently builds against 3.25.76 while accepting Zod 4 peers ([package.json:43](/Users/dug/Projects/dug/agentic-patterns-ts/packages/agent-core/package.json:43)). Walk `_def` and `_zod.def` structurally; avoid Zod-class `instanceof`; test both installed subpaths. |
| **Dual copies of core** | Use a `Symbol.for` validation marker rather than a private error-class identity check. |
| **Parsed returns strip or transform data** | This is intentional and opt-in through `defineTool`. Document it prominently; `validateReturns: false` preserves verbatim output. Existing plain definitions do not change. |
| **Type-changing transforms diverge from generated JSON Schema** | Recommend shape-preserving return transforms. Document that `zod-to-json-schema` cannot express arbitrary transforms. |
| **Consumers depend on a `ZodError` instance** | Uniform factory validation errors are ordinary named errors with the original parse error preserved as `cause`. Legacy definitions remain unchanged. |
| **Literal toolbox freezing breaks decorators** | Do not freeze or clone the toolbox/tool map. `capability()` still uses the existing frozen constructor. |
| **Schema linter false positives** | Keep rules dialect-specific, make description warnings opt-in, detect actual lazy cycles rather than all lazies, and maintain the shipped-agent sweep. |
| **OpenAI rule is applied to tool inputs accidentally** | Document that the initial `openai` rule set represents structured-output conversion. Do not imply a general provider-wide rule. |
| **Existing runtime guard overlaps schema linting** | Leave `guardOpenObjectSchemas` and `runStructured` untouched; it currently runs before an LLM call ([agent-runner.ts:876](/Users/dug/Projects/dug/agentic-patterns-ts/packages/agent-runtime/src/runner/agent-runner.ts:876)). Consolidation is outside #264. |
| **Terminal tool returns fail validation** | Validation failure is an errored call, so current terminal semantics correctly do not terminate; the existing contract already says only successful terminal calls end the loop ([toolbox.ts:66](/Users/dug/Projects/dug/agentic-patterns-ts/packages/agent-core/src/molecules/toolbox.ts:66)). |
| **Dealbrain migration breakage** | Adoption is per tool. Tools already self-calling `returns.parse` should remove that call when moving to `defineTool`; tools intentionally emitting extra keys can temporarily set `validateReturns: false`. No downstream toolbox/capability/runtime type changes are required. |

---

## Acceptance mapping

| Issue acceptance criterion | Planned satisfaction |
|---|---|
| `defineTool` returns a spec-compatible `ToolDefinition` | Explicit non-generic return signature; runtime and `expectTypeOf` tests. |
| Typed arguments | `args: z.infer<P>` plus transformed/defaulted parameter test. |
| Compile-checked return | Callback returns `Promise<z.input<R>>`; negative `@ts-expect-error` tests. |
| Runtime returns validation on by default | `parseAsync` wrapper and valid/invalid tests. |
| Uniform tool-named errors | Private tagged parse failure plus naming in `Toolbox.execute(name, …)`. |
| Parsed vs verbatim behavior is defined | Parsed `z.output<R>` by default; raw callback value when `validateReturns: false`. |
| `terminal` passes through | Definition and `ToolSchema` assertions. |
| Literal toolbox behaves like subclass | Private subclass, same record reference, inherited schema/name/execute comparison tests. |
| Literal capability retains manual/playbook behavior | Direct constructor adapter; frozen/reference/guidance/playbook tests. |
| Four killer constructs caught | Dedicated exclusive-bound, recursive-lazy, tuple, and optional-without-nullable tests, including nested paths. |
| Warn on undescribed leaves | Opt-in `missing-description` warnings with wrapper/nesting tests. |
| Zero false positives on shipped examples | Root acceptance sweep over calculator, todo, writing coach, toolsmith, plays, and `ManualToolbox`. |
| Core stays vendor-independent | Pure structural Zod walker; dialects are closed data/rule sets; zero SDK imports. |
| Decide automatic linting | Explicitly disabled; CI/manual invocation only. |
| Playbook parity addressed | Explicitly deferred to a linked issue covering envelope/serialization/context decisions. |
| Docs before/after page | New `docs/authoring-a-toolbox.md`, linked from corrected core README. |
| CHANGELOG entries per piece | Separate bullets for `defineTool`, literal factories, and linter. |
| PR-1 closes #43; PR-2 separable | PR slicing and linked child tracker defined above. |
| No runtime/server/CLI implementation changes | Verified structural consumers; only core production code, docs, changelog, and root acceptance harness change. |
| Non-goals remain out | No casing mapper, prose compression, or host-specific filter envelope work. |
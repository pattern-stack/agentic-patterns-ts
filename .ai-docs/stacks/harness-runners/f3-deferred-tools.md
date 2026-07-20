# F-3 spike — `deferred_tool_use` semantics in the Claude Agent SDK

**Issue:** #320 (epic #317) · **Gates:** #325 strategy choice (design.md §4 A-2)
**Date:** 2026-07-19
**Versions tested:** `@anthropic-ai/claude-agent-sdk@0.3.215` (fresh install, scratch dir) driving CLI `2.1.215` (local install; the binary the SDK resolved). Auth: local Claude Code Max login. Model: `haiku`.
**Method:** typings + CLI-binary string analysis to locate the trigger, then five live end-to-end runs. All scripts inline below; every quoted message flow is pasted from an actual run.

---

## ANSWER

**Confirmed, with one load-bearing caveat.**

1. **Hand-back: CONFIRMED.** A `PreToolUse` hook returning `permissionDecision: "defer"` terminates the print-mode run *before the tool executes*, and `SDKResultSuccess` carries the full call as data:
   `{ stop_reason: "tool_deferred", terminal_reason: "tool_deferred", is_error: false, deferred_tool_use: { id, name, input } }`.
   No deny gets written into history (unlike the current `canUseTool` deny+`interrupt` hack) — the transcript ends with the *pending* `tool_use` block plus a persisted `hook_deferred_tool` attachment.

2. **Resume: CONFIRMED — but the semantics are "execute-on-resume", not "result-injection".** `query({ options: { resume: sessionId } })` detects the pending deferred call **eagerly on session load** (before any input message is processed) and the **CLI executes the deferred tool itself** through its registered tool surface, splices a real `tool_result` under the original `tool_use` id, and continues the model turn coherently. The host supplies the result *by controlling the tool's execution seam*, not by appending a message:
   - **stdio MCP server (host-controlled): WORKS end-to-end.** Verified: host wrote the result between defer and resume; the model consumed it verbatim and answered from it.
   - **`PostToolUse` hook `updatedToolOutput`: WORKS** (must match the tool's per-tool Output shape, e.g. `{stdout, stderr, ...}` for Bash — a bare string is silently ignored). Verified: replaced Bash output reached the model.
   - **SDK-type (in-process) MCP server: BROKEN on 2.1.215.** The eager availability check runs before SDK MCP servers register (the server is absent from `mcpServerStatus()` at that moment), so resume yields `stop_reason: "tool_deferred_unavailable"`, `is_error: true` — every time, regardless of streaming-input mode or waiting. The pending `tool_use` then gets repaired as `[Tool result missing due to internal error]` on the next turn (degraded but not wedged).

## RECOMMENDATION for #325

**Adopt strategy 1 (deferred tools), with framework tools exposed to the CLI through a host-controlled stdio MCP shim.** Note that strategies 1 and 2 collapse into one mechanism: defer *is* resume-with-host-controlled-result — the defer gives clean call extraction and the resume executes through a seam the host owns. Preference order for the provider implementation:

1. **Deferred + stdio shim** — the provider registers one stdio MCP server exposing the agent's toolbox schemas; `PreToolUse` hook defers; `doGenerate` returns the deferred call as an LMv2 tool-call; on the next `doGenerate` (prompt now contains the tool result) the provider parks the result where the shim serves it and resumes. Append-only session, prompt-cache friendly, no history re-flatten, no fake denials.
2. **Re-test the SDK-server path each CLI upgrade** — `tool_deferred_unavailable` on in-process servers looks like an ordering bug, not a design position (the code's own error message anticipates MCP tools being resumable). If fixed, drop the stdio shim and serve results from the in-process handler keyed by `tool_use_id`.
3. **Stateless flatten stays as the fallback rung** (v1 behavior) for CLI versions predating defer or if the solo-only constraint (below) bites in practice.

Straight resume+result-injection *without* defer (option 2 as originally framed: deny, then resume and paste results as a user message) is now strictly dominated: it records a denial in history and delivers results out-of-band as user text, where defer records nothing and delivers a real `tool_result` block.

### Constraints to design around

- **Print-mode only.** Interactive mode ignores defer (binary: `"returned permissionDecision=defer in interactive mode; ignoring (defer is print-mode only)"`). SDK `query()` is print mode — fine for the provider.
- **Solo-only.** Parallel tool-call batches ignore defer (binary: `"permissionDecision=defer but ${n} tool calls are in this batch; ignoring (defer is solo-only — siblings would be orphaned on resume)"`). Mitigation: with the stdio shim the batch still executes through host-owned tools, so nothing breaks — the loop just isn't LMv2-mediated for that batch; optionally discourage parallel calls via system prompt.
- **`canUseTool` cannot defer** — `PermissionResult` is `allow | deny` only; `defer` exists only in `HookPermissionDecision` (PreToolUse hooks). The provider must move from `canUseTool` to a hooks-based intercept.
- **One deferred call per run** — `deferred_tool_use` is a single object, matching solo-only.
- **Resume fires eagerly** — the deferred execution + continuation happen before the resume prompt is processed; an empty resume prompt then produces one junk extra turn ("Continue from where you left off" is synthesized). The provider should consume the first result message and interrupt/close.
- **`tool_deferred_unavailable` poisons the call** — a failed availability check consumes the deferred state and the next turn sees `[Tool result missing due to internal error]`. Don't resume until the serving tool surface is guaranteed up (stdio `alwaysLoad: true` blocks startup on connect, capped 5s).

---

## Evidence

### E1. Where the machinery lives (typings + binary)

`sdk.d.ts` (0.3.215):

```ts
export declare type SDKDeferredToolUse = { id: string; name: string; input: Record<string, unknown> };
// SDKResultSuccess: ... deferred_tool_use?: SDKDeferredToolUse; terminal_reason?: TerminalReason;
export declare type HookPermissionDecision = 'allow' | 'deny' | 'ask' | 'defer';
export declare type TerminalReason = /* ... */ 'tool_deferred' | /* ... */ 'tool_deferred_unavailable' | /* ... */;
// PermissionResult (canUseTool): behavior: 'allow' | 'deny' — no defer.
```

CLI 2.1.215 binary (via `strings`), the resume handler:

```
if (deferredToolUse && !this.hasHandledDeferredToolResume) {
  this.hasHandledDeferredToolResume = true
  if (!toolAvailable(tools, j.toolName, aliases)) {
    log("Deferred tool resume: tool '...' is no longer available (MCP server disconnected or tool removed)")
    yield { type:"result", subtype:"success", is_error:true, stop_reason:"tool_deferred_unavailable", ...,
            deferred_tool_use:{id,name,input} }; return
  }
  for await (msg of runDeferredTool(j, ...)) { /* re-defer possible via hook_deferred_tool attachment */ }
  ...
}
```

(Paraphrased from minified source; the deferred call is *executed* on resume, and a fresh `PreToolUse` defer during that execution can chain another `tool_deferred` result.)

### E2. Test 1 — trigger (SDK MCP tool, defer hook)

`defer-test.mjs`:

```js
import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

const weather = tool("get_weather", "Get current weather for a city", { city: z.string() },
  async ({ city }) => {
    console.error(`[HOST] tool handler EXECUTED (should NOT happen)`);
    return { content: [{ type: "text", text: `72F and sunny in ${city}` }] };
  },
  { alwaysLoad: true } // else the call defers behind ToolSearch and you defer ToolSearch instead
);

const q = query({
  prompt: "Use the get_weather tool to get the weather in Tokyo, then report the temperature.",
  options: {
    model: "haiku", maxTurns: 3,
    allowedTools: ["mcp__spike__get_weather"],
    mcpServers: { spike: createSdkMcpServer({ name: "spike", tools: [weather] }) },
    hooks: { PreToolUse: [{ matcher: "mcp__spike__get_weather", hooks: [async () => ({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "defer",
                            permissionDecisionReason: "host executes this tool" } })] }] },
  },
});
for await (const msg of q) console.log(JSON.stringify(msg));
```

Observed flow (run `b329d588`, exact):

```
assistant  tool_use {"id":"toolu_01QT...","name":"mcp__spike__get_weather","input":{"city":"Tokyo"}}
[HOOK] PreToolUse fired for mcp__spike__get_weather
result     { subtype:"success", is_error:false, stop_reason:"tool_deferred", terminal_reason:"tool_deferred",
             deferred_tool_use:{ id:"toolu_01QT...", name:"mcp__spike__get_weather", input:{city:"Tokyo"} },
             num_turns:1, session_id:"dc23cd0a-..." }
```

The host handler never ran. The persisted transcript ends: `assistant tool_use` → `attachment {type:"hook_deferred_tool", toolUseID, toolName, toolInput, hookEvent:"PreToolUse"}`.

Incidental proof of generality: without `alwaysLoad`, the model called `ToolSearch` first and *that* built-in call deferred identically.

### E3. Test 2/3 — resume with SDK-type MCP server: FAILS

Resuming (string prompt `""`, and separately streaming input with delays and with `mcpServerStatus()` polling) always produced, *before* `system init` and before any input was consumed:

```
result { subtype:"success", is_error:true, stop_reason:"tool_deferred_unavailable",
         terminal_reason:"tool_deferred_unavailable", deferred_tool_use:{...same call...} }
```

`mcpServerStatus()` at that moment lists user-config servers (linear, slack, ...) but **not** the SDK-type `spike` server — it has not registered yet when the eager availability check runs. The subsequent model turn then saw `[Tool result missing due to internal error]` and improvised. Structural on 2.1.215: the check races SDK-server registration and the race is not winnable from the host side.

### E4. Test 5 — resume executes a deferred built-in tool; PostToolUse can replace its output

Defer `Bash` (`echo SPIKE_MARKER_ORIGINAL`) → same clean `tool_deferred` hand-back (session `0334b1be`). Resume with a host-side `PostToolUse` hook returning shape-correct `updatedToolOutput`:

```js
hookSpecificOutput: { hookEventName: "PostToolUse",
  updatedToolOutput: { stdout: "HOST-REPLACED OUTPUT: XYZZY-42", stderr: "",
                       interrupted: false, isImage: false, noOutputExpected: false } }
```

Observed flow (exact):

```
[HOOK] PostToolUse fired for Bash; original response: {"stdout":"SPIKE_MARKER_ORIGINAL",...}
user   tool_result [{"tool_use_id":"toolu_01EE...","content":"HOST-REPLACED OUTPUT: XYZZY-42","is_error":false}]
assistant "The exact output ... is: XYZZY-42 ..."
result { stop_reason:"end_turn", terminal_reason:"completed" }
```

So: the CLI executed the deferred call itself (the echo really ran — first attempt with a bare-string `updatedToolOutput` was ignored and the model saw `SPIKE_MARKER_ORIGINAL`), the hook fired in the host process, and the shape-correct replacement reached the model. Caveat: the tool still executes; to suppress side effects, rewrite the input to a no-op via PreToolUse `updatedInput` on resume, then replace the output.

### E5. Test 7 — the winning path: stdio MCP shim, host-injected result

`stdio-weather-server.mjs` (spawned by the CLI):

```js
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFileSync } from "node:fs";
const server = new McpServer({ name: "spikeio", version: "1.0.0" });
server.tool("get_weather", "Get current weather for a city", { city: z.string() },
  async ({ city }) => {
    let text = `72F and sunny in ${city} (stdio default)`;
    try { text = readFileSync(new URL("./result.txt", import.meta.url), "utf8").trim(); } catch {}
    return { content: [{ type: "text", text }] };
  });
await server.connect(new StdioServerTransport());
```

Driver: same defer hook; server config `{ type: "stdio", command: node, args: [server.mjs], alwaysLoad: true }`.

Run 1 (defer, session `e6b8a522`): identical `tool_deferred` hand-back, handler never called.
Host writes `result.txt` = `HOST-INJECTED: 55F and raining in Tokyo (marker: XYZZY-42)`.
Run 2 (resume, exact observed flow):

```
user   tool_result [{"tool_use_id":"toolu_01Mt...","content":[{"type":"text",
         "text":"HOST-INJECTED: 55F and raining in Tokyo (marker: XYZZY-42)"}]}]
assistant thinking: "...I just reported the weather ... The result was 55F and raining ..."
assistant "The current temperature in Tokyo is **55°F** and it's raining."
result { stop_reason:"end_turn", terminal_reason:"completed", is_error:false }
```

Deferred call handed out → host computed the result out-of-band → resume executed the call through the host-controlled server → model continued coherently on the injected result. This is the full execute+resume loop #325 needs, verified.

---

*Scratch artifacts (scripts + raw logs) live in the session scratchpad (`defer-spike/`): `defer-test.mjs`, `resume-test.mjs`, `resume-stream-test.mjs`, `resume-mcp-ready-test.mjs`, `bash-defer-test.mjs`, `bash-resume-test.mjs`, `stdio-weather-server.mjs`, `stdio-defer-test.mjs`, logs `run1`–`run7b`. Everything needed to re-run is inline above.*

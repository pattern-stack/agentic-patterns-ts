# Playground menus & popovers — one style, overlay, stay in bounds

> **Type:** `spec` (design-reference canvas). Run it with:
> `/sdlc:design-loop --reference=.ai-docs/design/playground-menus/reference.md --surface=http://localhost:5173/chat`
> Loop the build→grade→fix cycle; don't one-shot it. Verify in a browser every round.

## Reference

Three asks from the user, all about menus (verbatim intent):

1. **Bounds** — *"the left sidebar, the style menu button — it opens the options underneath, which is off screen. need this popup to respect the boundaries of the page."*
2. **No reflow** — *"we have a number of menus like this — they open up and rearrange the space on the page — i don't like that."* (Screenshot: the **Scope context** panel expanding inline and pushing the page around.)
3. **One style** — *"i want all dropdown boxes to use the same style. Sessions is great. but then the agent choice is macos default. Settings popover is nice — the context popover isnt."*

### Locked decisions

- **LD1 — The kit `DropdownMenu` (`components/kit/DropdownMenu.tsx`) is THE single popover primitive for every menu.**
  *Justification:* `Sessions ▾` and `⚙ Settings` already use it and the user named both as the bar ("Sessions is great", "Settings popover is nice"). Every surface they disliked is one that diverges from it. Fix the primitive once; callers inherit.
- **LD2 — Popovers overlay; they never reflow the page.**
  *Justification:* ask #2 is explicit. Today `ScopeContextPanel` and `CaptureCasePanel` are *inline expands* — a collapsed button that swaps into a bordered `div` in the header flow, pushing siblings. They must become absolutely-positioned panels.
- **LD3 — Popovers are viewport-bounded: flip up (or clamp) so the panel is always fully on-screen.**
  *Justification:* ask #1. `DropdownMenu` hard-codes `top: calc(100% + 6px)` (`DropdownMenu.tsx:57`) — always downward. `ThemeToggle` sits at the sidebar's bottom, so its panel renders below the fold. This belongs in the primitive, not per-caller.
- **LD4 — A native `<select>` is not an acceptable menu style on the chat surface.**
  *Justification:* ask #3 — the agent picker (`ChatPage.tsx:587`) renders macOS-default chrome beside styled kit menus.

### Atoms

The primitive gains placement + a `close` handle (the latter is why `CopyChatMenu` was hand-rolled — the kit owns `open` internally and passes no `close` to children, so a menu can't close on select):

```ts
export type DropdownPlacement = "bottom" | "top" | "auto"; // auto = flip when short on space

export interface DropdownMenuProps {
  trigger: (state: { open: boolean; toggle: () => void; close: () => void }) => ReactNode;
  /** Render-prop form lets a menu close itself on select (CopyChatMenu). */
  children: ReactNode | ((api: { close: () => void }) => ReactNode);
  align?: "left" | "right";
  /** Default "auto": open downward; flip up when the panel would cross the viewport edge. */
  placement?: DropdownPlacement;
  width?: number;
  maxHeight?: number;
}
```

### Inventory — what changes

| Surface | File | Today | Target |
|---|---|---|---|
| `Sessions ▾` | `pages/ChatPage.tsx` `SessionsMenu` | kit DropdownMenu ✅ | **reference bar** — unchanged |
| `⚙ Settings` | `pages/ChatPage.tsx` `RunSettingsMenu` | kit DropdownMenu ✅ | unchanged |
| Theme picker | `components/ThemeToggle.tsx` | kit DropdownMenu, opens **down** at sidebar bottom → off-screen | flips up (LD3) |
| Agent picker | `pages/ChatPage.tsx:587` | native `<select>` | kit dropdown (LD4) |
| Scope context | `pages/ChatPage.tsx` `ScopeContextPanel` (~951) | inline expand → **reflows** | popover (LD2) |
| Capture as eval case | `chat/CaptureCasePanel.tsx` (~82) | inline expand → **reflows** | popover (LD2) |
| `Copy ▾` | `pages/ChatPage.tsx` `CopyChatMenu` (~708) | **bespoke** hand-rolled popover | fold into kit once it has `close` |
| scope chip | `pages/ChatPage.tsx` `ScopeChip` | kit DropdownMenu + `JsonBlock` | keep; consider matching the rail's key→value Scope layout instead of raw JSON |
| Run picker | `pages/RunSurfacePage.tsx` | kit DropdownMenu | inherits the fix free |

**Out of scope for round 1** (note, don't do): the other native `<select>`s — `eval/RunLaunchForm.tsx` (×4), `eval/EvalRunsPage.tsx:330`, `RunSurfacePage.tsx:663`, `CaptureCasePanel.tsx:257/273/324`. Land the chat surface + the primitive first; sweep the rest in a follow-up once the pattern is proven.

## Surface

`http://localhost:5173/chat` — the chat Console, plus the left sidebar's theme picker (present on every route).

Dev loop:
- **backend:** `env -u OPENAI_API_KEY -u AGENT_MODEL -u AGENT_TIER bun packages/agent-cli/src/cli.ts playground examples/agents --port 3456 --no-dashboard`
- **frontend:** `bun run --filter=@agentic-patterns/dashboard dev` (vite :5173, proxies API → :3456)
- **Agents:** `Workspace` (rich — 2 capabilities + a bound scope), `Toolsmith` (unscoped), `Pipeline2` (no capabilities). Deep-link `/chat/workspace`.
- **Gotcha:** vite binds **IPv6** — headless Chrome must use `http://[::1]:5173` (`localhost` resolves v4 and hangs).
- **Gotcha:** a chat turn cannot complete keyless in this repo (see handoff Notes). Every check below is verifiable without a live reply.

## Checks

Each is falsifiable and gradable:

1. **Bounds** — open the sidebar theme picker (bottom-left): the panel's rect is fully on-screen (`rect.bottom <= innerHeight && rect.top >= 0`). *Fails today.* [runtime]
2. **No reflow** — opening ANY menu (Sessions, agent picker, ⚙ Settings, Copy ▾, Scope context, Capture, theme) leaves every sibling's bounding rect unchanged (Δ ≤ 1px) and `body.scrollHeight` unchanged. *Scope context + Capture fail today.* [runtime]
3. **Overlay, not inline** — `ScopeContextPanel` + `CaptureCasePanel` render as absolutely/fixed-positioned panels, not bordered divs in the header flow; the chat column below does not move when they open. [runtime + visual]
4. **No native select on chat** — the agent picker is not a `<select>`; it renders the kit trigger + panel. [DOM]
5. **One style** — every menu on `/chat` (Sessions, agent, ⚙ Settings, Copy ▾, Scope context, scope chip) shares the same panel chrome (border/radius/shadow/bg — same component) and the same trigger idiom. [visual + DOM]
6. **Regression** — no horizontal overflow at 1600×1000 **and** 1280×800; the header stays 2 rows; `bun run build && bun run typecheck && bun run lint && bun run test` green (CI `check` is the merge gate). [typecheck/lint/runtime]

## Themes

Verify in **light and dark** (theme picker: Blue/Earth/Chalk × System/Light/Dark). The user's menu screenshots are light-mode; the prior session's work was verified dark — the popover chrome must hold in both.

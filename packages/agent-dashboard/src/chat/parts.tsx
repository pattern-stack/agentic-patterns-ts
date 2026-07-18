/**
 * Part renderers — one component per `Part` kind, plus a dispatcher. Adding a
 * new part kind = add a case here; nothing else changes.
 */
import { Fragment, useEffect, useRef, useState } from "react";
import { CodeBlock, Markdown } from "./atoms";
import { type InputAnswer, useInputResponder } from "./input-responder";
import type { Part } from "./model";
import type { StateDeltaPart as StateDelta } from "./state-accessors";

const fmt = (v: unknown): string => {
  if (v == null) return "";
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
};
const preview = (s: string, n = 72): string => (s.length > n ? `${s.slice(0, n)}…` : s);
const count = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/* ── [#N] citation chips (#226) ─────────────────────────────────────────────
 * Canonical backpack handles in assistant prose become live chips: hover
 * reveals the minting frame's rendered line + provenance (a lazily-set native
 * title — pure DOM projection, nothing fabricated); click seeks the minting
 * Δ frame inside the chat scroll column (never the page). With the density
 * toggle at Off the frames are hidden — the seek honestly reveals them first
 * (a bubbled `chat:reveal-state-frames` ChatPage listens for, flipping the
 * toggle back inside flushSync so the frames are visible again BEFORE the
 * dispatch returns) rather than scrolling to nothing.
 *
 * Resolution scope: [#N] indexes are per-pack and restart at [#1] every run
 * (= every send), so a panel-global first match could land on an EARLIER
 * turn's frame. The minting frame lives in the same assistant message as the
 * prose citing it — resolve within the citing message first, panel-wide only
 * as a fallback. (Two packs minting the same index inside ONE message can
 * still collide — disambiguating that needs pack-key stamps on both ends.)
 */

/** Resolve idx's minting frame: the citing message (`.chat-row`) first, then
 *  the whole panel — see the scope note above. */
function resolveMintingFrame(chip: HTMLElement, idx: string): HTMLElement | null {
  const sel = `[data-minted~="${idx}"]`;
  const local = chip.closest(".chat-row")?.querySelector<HTMLElement>(sel);
  return local ?? chip.closest(".chat-root")?.querySelector<HTMLElement>(sel) ?? null;
}

/** Wrap [#N] handles (outside code/pre) in cite buttons. Exported for tests. */
export function linkifyCites(html: string): string {
  const segs = html.split(/(<pre[\s\S]*?<\/pre>|<code[\s\S]*?<\/code>)/g);
  return segs
    .map((seg, i) =>
      i % 2 === 1
        ? seg
        : seg.replace(
            /\[#(\d+)\]/g,
            '<button type="button" class="cite" data-idx="$1">[#$1]</button>',
          ),
    )
    .join("");
}

/**
 * Open + flash + center `frame` inside the chat column's OWN scroll container
 * (`.chat-scroll`) — never the page. Shared by the [#N] cite seeks below and
 * the Scratchpad rail's row→frame seeks (ScratchpadRail.tsx). `root` is the
 * `.chat-root` element the frame lives in.
 */
export function seekStateFrame(root: Element, frame: HTMLElement): void {
  // Open the frame AND every ancestor <details> up to the panel root — a
  // completed agent_step's <details> closes itself, leaving nested frames
  // display:none (zero rect → garbage scroll target, off-screen flash).
  // Opening is synchronous DOM, so the rect read below is correct.
  if (frame instanceof HTMLDetailsElement) frame.open = true;
  for (let el = frame.parentElement; el && el !== root; el = el.parentElement) {
    if (el instanceof HTMLDetailsElement) el.open = true;
  }
  frame.classList.remove("flash");
  void frame.offsetWidth; // restart the animation
  frame.classList.add("flash");
  const scroller = root.querySelector<HTMLElement>(".chat-scroll");
  if (
    scroller &&
    typeof scroller.scrollTo === "function" &&
    scroller.scrollHeight > scroller.clientHeight
  ) {
    const cr = scroller.getBoundingClientRect();
    const er = frame.getBoundingClientRect();
    scroller.scrollTo({
      top: scroller.scrollTop + (er.top - cr.top) - scroller.clientHeight / 2 + er.height / 2,
      behavior: "smooth",
    });
  } else if (typeof frame.scrollIntoView === "function") {
    frame.scrollIntoView({ behavior: "smooth", block: "center" });
  }
}

function seekCite(chip: HTMLElement, idx: string): void {
  if (!idx) return;
  const root = chip.closest(".chat-root");
  if (!root) return;
  const frame = resolveMintingFrame(chip, idx);
  if (!frame) return;
  const layout = chip.closest<HTMLElement>("[data-density]");
  if (layout && layout.getAttribute("data-density") === "off") {
    // ChatPage's listener flips the toggle back to Writes inside flushSync —
    // dispatchEvent runs listeners synchronously, so the `.sd` frames are
    // display:none no longer when the rect math below runs. Without the
    // synchronous commit the frame would measure as a zero rect and the
    // scroll would land at the top of the column instead of on the frame.
    layout.dispatchEvent(new CustomEvent("chat:reveal-state-frames", { bubbles: true }));
  }
  seekStateFrame(root, frame);
}

function ensureCiteTitle(chip: HTMLElement): void {
  if (chip.title) return;
  const idx = chip.getAttribute("data-idx") ?? "";
  const frame = idx ? resolveMintingFrame(chip, idx) : null;
  if (!frame) {
    chip.title = `[#${idx}] — minting frame not in this transcript`;
    return;
  }
  // The [#idx] row lives INSIDE the minting frame — never resolve it panel-
  // globally (another turn's pack can render the same index).
  const row = frame.querySelector(`.d-row[data-idx="${idx}"] .lbl`);
  const prov = frame.getAttribute("data-prov");
  chip.title = row?.textContent
    ? `[#${idx}] ${row.textContent}${prov ? ` — ${prov}` : ""}`
    : `[#${idx}]${prov ? ` — ${prov}` : " — minted here (no preview on record)"}`;
}

/* ── text ───────────────────────────────────────────────────────────────────*/
function AssistantText({ content }: { content: string }) {
  const ref = useRef<HTMLDivElement>(null);
  // Cite chips live inside dangerouslySetInnerHTML — native delegation on the
  // bubble (not JSX handlers) so the buttons stay plain markup.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const chipOf = (ev: Event): HTMLElement | null => {
      const t = ev.target;
      return t instanceof Element ? (t.closest(".cite") as HTMLElement | null) : null;
    };
    const onClick = (ev: Event) => {
      const chip = chipOf(ev);
      if (chip) seekCite(chip, chip.getAttribute("data-idx") ?? "");
    };
    const onOver = (ev: Event) => {
      const chip = chipOf(ev);
      if (chip) ensureCiteTitle(chip);
    };
    el.addEventListener("click", onClick);
    el.addEventListener("mouseover", onOver);
    return () => {
      el.removeEventListener("click", onClick);
      el.removeEventListener("mouseover", onOver);
    };
  }, []);
  return (
    <div ref={ref} className="chat-bubble assistant" style={{ position: "relative" }}>
      <Markdown content={content} className="chat-bubble assistant" postprocess={linkifyCites} />
    </div>
  );
}

function TextPart({ content, role }: { content: string; role: "user" | "assistant" }) {
  // User text is plain (no markdown surprises); assistant text is markdown.
  if (role === "user") {
    return (
      <div className={`chat-bubble ${role}`}>
        <span style={{ whiteSpace: "pre-wrap" }}>{content}</span>
      </div>
    );
  }
  return <AssistantText content={content} />;
}

/* ── thinking ───────────────────────────────────────────────────────────────*/
function ThinkingPart({ content, complete }: { content: string; complete: boolean }) {
  const empty = !content.trim();
  // Redacted/signature-only thinking: a non-interactive chip, not a fake toggle.
  if (complete && empty) {
    return (
      <div
        className="chat-thinking"
        style={{ padding: "6px 11px", fontSize: "var(--fz-tiny)", color: "var(--mute)" }}
      >
        <span className="glyph">✦</span> reasoned privately
      </div>
    );
  }
  return (
    <details className="chat-thinking" open={!complete}>
      <summary>
        <span className="glyph">✦</span>
        {complete ? "Thought" : "Thinking…"}
        {complete && content.trim() && (
          <span style={{ color: "var(--mute)" }}>· {preview(content.replace(/\s+/g, " "))}</span>
        )}
      </summary>
      <div className="thinking-body">{content}</div>
    </details>
  );
}

/* ── tool call ──────────────────────────────────────────────────────────────*/
function ToolCallPart({ part }: { part: Extract<Part, { kind: "tool_call" }> }) {
  const running = part.result === undefined && !part.error;
  const status = part.error ? "err" : running ? "running" : "ok";
  const badge = part.rejected ? "⊘" : part.error ? "✗" : running ? "⋯" : "✓";
  const args = fmt(part.arguments);
  const out = fmt(part.result);
  return (
    <details className={`chat-tool ${status}`} open={!!part.error}>
      <summary>
        <span aria-hidden>{badge}</span>
        <span className="tool-name">{part.name}</span>
        {part.durationMs != null && <span className="tool-dur">{part.durationMs}ms</span>}
      </summary>
      <div className="tool-io">
        {args && (
          <div>
            <div className="io-label">input</div>
            <CodeBlock text={args} copyable maxHeight={180} />
          </div>
        )}
        {part.error ? (
          <div>
            <div className="io-label">{part.rejected ? "rejected" : "error"}</div>
            <CodeBlock text={part.error} danger />
          </div>
        ) : (
          out && (
            <div>
              <div className="io-label">output</div>
              <CodeBlock text={out} copyable maxHeight={240} />
            </div>
          )
        )}
      </div>
    </details>
  );
}

/* ── agent step (delegation) ─────────────────────────────────────────────────*/
function AgentStepPart({
  part,
  role,
}: {
  part: Extract<Part, { kind: "agent_step" }>;
  role: "user" | "assistant";
}) {
  const running = part.result === undefined && !part.error;
  const status = part.error ? "err" : running ? "running" : "ok";
  const badge = part.error ? "✗" : running ? "⋯" : "✓";
  const args = fmt(part.arguments);
  const out = fmt(part.result);
  return (
    <details className={`chat-tool chat-step ${status}`} open={running || !!part.error}>
      <summary>
        <span aria-hidden>◆</span>
        <span className="tool-name">{part.name}</span>
        <span className="step-kind">agent{part.agentName ? ` · ${part.agentName}` : ""}</span>
        {part.durationMs != null && <span className="tool-dur">{part.durationMs}ms</span>}
        <span aria-hidden>{badge}</span>
      </summary>
      <div className="tool-io">
        {args && (
          <div>
            <div className="io-label">input</div>
            <CodeBlock text={args} copyable maxHeight={180} />
          </div>
        )}
        {part.error ? (
          <div>
            <div className="io-label">error</div>
            <CodeBlock text={part.error} danger />
          </div>
        ) : (
          out && (
            <div>
              <div className="io-label">output</div>
              <CodeBlock text={out} copyable maxHeight={240} />
            </div>
          )
        )}
        {part.children.length > 0 && (
          <div className="step-children">
            <div className="io-label">tools called</div>
            {part.children.map((child, i) => (
              <PartView key={child.kind === "tool_call" ? child.id : i} part={child} role={role} />
            ))}
          </div>
        )}
      </div>
    </details>
  );
}

/* ── human-input request (approval / select / text) ──────────────────────────*/
function InputRequestPart({ part }: { part: Extract<Part, { kind: "input_request" }> }) {
  const respond = useInputResponder();
  const [answered, setAnswered] = useState<InputAnswer | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  const answer = async (a: InputAnswer) => {
    if (answered || busy || !respond) return;
    setBusy(true);
    try {
      await respond(part.correlationId, a);
      setAnswered(a);
    } finally {
      setBusy(false);
    }
  };

  const args = fmt(part.arguments);
  const resolved =
    answered &&
    (answered.decision === "deny"
      ? "⊘ Denied"
      : answered.value !== undefined
        ? `✓ ${answered.value}`
        : "✓ Approved");

  return (
    <div className={`chat-approval${answered ? " resolved" : ""}`}>
      <div className="approval-head">
        <span aria-hidden>⏸</span>
        <span className="approval-prompt">{part.prompt}</span>
        {part.toolName && <span className="approval-tool">{part.toolName}</span>}
      </div>
      {args && (
        <div className="approval-args">
          <CodeBlock text={args} copyable maxHeight={140} />
        </div>
      )}
      {resolved ? (
        <div className="approval-resolved">{resolved}</div>
      ) : !respond ? (
        <div className="approval-readonly">Awaiting a decision (read-only view).</div>
      ) : part.inputKind === "select" ? (
        <div className="approval-actions">
          {(part.options ?? []).map((opt) => (
            <button
              key={opt}
              type="button"
              className="approval-btn"
              disabled={busy}
              onClick={() => answer({ decision: "approve", value: opt })}
            >
              {opt}
            </button>
          ))}
          <button
            type="button"
            className="approval-btn deny"
            disabled={busy}
            onClick={() => answer({ decision: "deny" })}
          >
            Cancel
          </button>
        </div>
      ) : part.inputKind === "text" ? (
        <form
          className="approval-actions"
          onSubmit={(e) => {
            e.preventDefault();
            answer({ decision: "approve", value: text });
          }}
        >
          <input
            className="approval-input"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Type a response…"
          />
          <button type="submit" className="approval-btn" disabled={busy || !text.trim()}>
            Send
          </button>
        </form>
      ) : (
        <div className="approval-actions">
          <button
            type="button"
            className="approval-btn approve"
            disabled={busy}
            onClick={() => answer({ decision: "approve" })}
          >
            Approve
          </button>
          <button
            type="button"
            className="approval-btn deny"
            disabled={busy}
            onClick={() => answer({ decision: "deny" })}
          >
            Deny
          </button>
        </div>
      )}
    </div>
  );
}

/* ── state delta (Δ / ◇ / ⇄ frames — #226) ──────────────────────────────────
 * One frame per Backpack/Scratchpad mutation, in the tool-card grammar's
 * violet family (`.chat-delta`, chat.css — class grammar and copy text from
 * the approved mockup). Every frame carries `.sd` (the density toggle's CSS
 * hook); innate frames are dashed with an `auto` chip ("the framework saved
 * this, not the agent"); drop/absorb frames expose `data-minted` (the [#N]
 * handles they minted — the cite chips' seek target) and `data-prov`.
 *
 * Honest-degradation note (spec divergence, verified against WI-1): the wire
 * carries byte-capped ENTRY previews only — no raw TIn payload — so the
 * mockup's per-row expansion pane (raw → expand() → entry) cannot be rendered
 * without fabricating data; the diff table renders the previews as-is.
 */

function InnateChip() {
  return (
    <span className="innate-chip" title="innate — written by the framework, not by agent code">
      auto
    </span>
  );
}

/**
 * A mono slot key inside a Δ frame — the byte-exact join key with the
 * Scratchpad rail. Clicking finds the slot's row on the rail (the REVERSE of a
 * rail row's frame seek): bubbles a `chat:seek-rail` event that ChatPage
 * bridges, flipping the side panel to the Scratchpad tab first so the seek
 * never lands on a hidden rail. Inside a <summary>, the click must not toggle
 * the frame.
 */
function SlotKey({ k }: { k: string }) {
  return (
    <button
      type="button"
      className="d-key"
      title={`click to find "${k}" in the Scratchpad rail`}
      onClick={(e) => {
        // Inside a <summary> — the click must not toggle the frame.
        e.preventDefault();
        e.stopPropagation();
        e.currentTarget.dispatchEvent(
          new CustomEvent("chat:seek-rail", { detail: { key: k }, bubbles: true }),
        );
      }}
    >
      {k}
    </button>
  );
}

type DropDelta = Extract<StateDelta, { op: "drop" }>;
type AbsorbDelta = Extract<StateDelta, { op: "absorb" }>;
type ReadDelta = Extract<StateDelta, { op: "read" }>;
type WriteDelta = Extract<StateDelta, { op: "write" }>;
type TravelDelta = Extract<StateDelta, { op: "travel" }>;
type ForkDelta = Extract<StateDelta, { op: "fork" }>;
type JoinDelta = Extract<StateDelta, { op: "join" }>;

const dropProv = (part: DropDelta | AbsorbDelta): string => {
  const bits = [part.dropSeq != null ? `drop #${part.dropSeq}` : "drop"];
  if (part.via) bits.push(`↳ ${part.via}`);
  return bits.join(" · ");
};

function DropFrame({ part }: { part: DropDelta }) {
  const innate = part.origin === "innate";
  const prov = dropProv(part);
  return (
    <details
      className={`chat-delta sd${innate ? " innate" : ""}`}
      data-minted={part.indexes.join(" ") || undefined}
      data-prov={prov}
      data-skey={part.key}
      data-drop-seq={part.dropSeq}
    >
      <summary>
        <span className="d-badge" aria-hidden>
          Δ
        </span>
        <SlotKey k={part.key} />
        {part.accepted > 0 && <span className="pill add">+{part.accepted}</span>}
        {part.merged > 0 && <span className="pill mrg">~{part.merged}</span>}
        {part.skipped > 0 && <span className="pill skp">ø{part.skipped}</span>}
        <span className="d-size">
          {part.sizeBefore} → {part.sizeAfter}
        </span>
        {innate && <InnateChip />}
        <span className="d-prov">{prov}</span>
      </summary>
      <div className="d-body">
        <div className="d-diff">
          {part.previews.map((row) =>
            row.op === "added" ? (
              <div key={row.index} className="d-row add" data-idx={row.index}>
                <span className="gut" aria-hidden>
                  +
                </span>
                <span className="hnd">[#{row.index}]</span>
                <span className="lbl">{row.preview}</span>
              </div>
            ) : (
              <div key={row.index} className="d-row mrg" data-idx={row.index}>
                <span className="gut" aria-hidden>
                  ~
                </span>
                <span className="lbl">
                  merged into <span className="hnd">[#{row.index}]</span> · {row.preview}
                </span>
              </div>
            ),
          )}
          {part.skipped > 0 && (
            <div className="d-row skp">
              <span className="gut" aria-hidden>
                ø
              </span>
              <span className="lbl">
                {count(part.skipped, "raw")} skipped by expand() · skip recorded in manifest
              </span>
            </div>
          )}
          {part.previewsOmitted > 0 && (
            <div className="d-row skp">
              <span className="gut" aria-hidden>
                …
              </span>
              <span className="lbl">
                {count(part.previewsOmitted, "more row")} not previewed (frame preview budget)
              </span>
            </div>
          )}
        </div>
        {part.tag && (
          <div className="d-foot">
            <span className="tag-chip">{part.tag}</span>
          </div>
        )}
      </div>
    </details>
  );
}

function AbsorbFrame({ part }: { part: AbsorbDelta }) {
  const first = part.appendedIndexes[0];
  const last = part.appendedIndexes[part.appendedIndexes.length - 1];
  const appended =
    first != null && last != null
      ? first === last
        ? `appended [#${first}]`
        : `appended [#${first}..#${last}]`
      : "no new entries";
  return (
    <details
      className="chat-delta sd"
      data-minted={part.appendedIndexes.join(" ") || undefined}
      data-prov={dropProv(part)}
      data-skey={part.key}
      data-drop-seq={part.dropSeq}
    >
      <summary>
        <span className="d-badge" aria-hidden>
          ⇄
        </span>
        <SlotKey k={part.key} />
        <span className="d-note">absorb</span>
        {part.accepted > 0 && <span className="pill add">+{part.accepted}</span>}
        {part.merged > 0 && <span className="pill mrg">~{part.merged}</span>}
        <span className="d-size">
          {part.sizeBefore} → {part.sizeAfter}
        </span>
        <span className="d-prov">{appended}</span>
      </summary>
      <div className="d-body">
        <div className="d-row">
          <span className="micro" style={{ padding: "4px 8px" }}>
            branch pack of {count(part.childSize, "entry", "entries")} absorbed · +{part.accepted}{" "}
            new, ~{part.merged} merged · parent indexes stay stable
          </span>
        </div>
      </div>
    </details>
  );
}

function ReadFrame({ part }: { part: ReadDelta }) {
  const innate = part.origin === "innate";
  if (part.scope === "backpack") {
    if (part.memoHit) {
      return (
        <div className="strip sd readframe" data-skey={part.key}>
          <span className="d-badge read" aria-hidden>
            ◇
          </span>
          <SlotKey k={part.key} />
          <span>
            · finalized() · memo hit
            {part.size != null ? ` · ${count(part.size, "entry", "entries")}` : ""}
          </span>
        </div>
      );
    }
    return (
      <details className={`chat-delta readframe sd${innate ? " innate" : ""}`} data-skey={part.key}>
        <summary>
          <span className="d-badge read" aria-hidden>
            ◇
          </span>
          <SlotKey k={part.key} />
          <span className="d-note">finalized() · memo miss</span>
          {innate && <InnateChip />}
          <span className="d-prov">
            {part.size != null ? count(part.size, "entry", "entries") : "finalized"}
          </span>
        </summary>
        {part.preview && (
          <div className="d-body">
            <div>
              <div className="io-label">final (preview only)</div>
              <CodeBlock text={part.preview} maxHeight={200} />
            </div>
          </div>
        )}
      </details>
    );
  }
  if (innate) {
    return (
      <details className="chat-delta innate readframe sd" data-skey={part.key}>
        <summary>
          <span className="d-badge read" aria-hidden>
            ◇
          </span>
          <SlotKey k={part.key} />
          <span className="d-note">→ prompt</span>
          <InnateChip />
          <span className="d-prov">
            {part.previewRedacted ? "preview redacted" : "exact injected text ▾"}
          </span>
        </summary>
        <div className="d-body">
          <div>
            <div className="io-label">injected prompt block — what the model actually saw</div>
            {part.previewRedacted ? (
              <div className="d-redacted">
                injected prompt text streams live but is never stored — replay keeps the frame, not
                the text
              </div>
            ) : (
              <CodeBlock text={part.preview ?? ""} maxHeight={240} />
            )}
          </div>
        </div>
      </details>
    );
  }
  return (
    <div className="strip sd readframe" data-skey={part.key}>
      <span className="d-badge read" aria-hidden>
        ◇
      </span>
      <SlotKey k={part.key} />
      <span>· read{part.preview ? ` · ${preview(part.preview, 48)}` : ""}</span>
    </div>
  );
}

function WriteFrame({ part }: { part: WriteDelta }) {
  const innate = part.origin === "innate";
  return (
    <details className={`chat-delta sd${innate ? " innate" : ""}`} data-skey={part.key}>
      <summary>
        <span className="d-badge" aria-hidden>
          Δ
        </span>
        <SlotKey k={part.key} />
        <span className="d-note">
          {innate ? "← stage output · saved for next stage" : part.writeOp}
        </span>
        {innate && <InnateChip />}
        <span className="d-prov">
          {part.via ? `↳ ${part.via}` : `${part.writeOp} · ${part.hadValue ? "{…}" : "null"} → {…}`}
        </span>
      </summary>
      <div className="d-body">
        <div className="ba">
          <div>
            <div className="io-label">before</div>
            <CodeBlock
              text={part.hadValue ? (part.before ?? "(not previewed)") : "null"}
              maxHeight={160}
            />
          </div>
          <div className="arr" aria-hidden>
            →
          </div>
          <div>
            <div className="io-label">after</div>
            <CodeBlock text={part.after} maxHeight={160} />
          </div>
        </div>
      </div>
    </details>
  );
}

function TravelFrame({ part }: { part: TravelDelta }) {
  const total = part.records.reduce((acc, r) => acc + r.covered, 0);
  const items = count(part.items, "item");
  return (
    <details className={`travel sd${part.quiet ? " quiet" : ""}`} data-skey={part.key}>
      <summary>
        <span className="t-glyph" aria-hidden>
          ⇄
        </span>
        <span className="t-title">
          <SlotKey k={part.key} /> travels → {part.toStep}
        </span>
        <span className="t-sub">
          {part.quiet
            ? `no new drops${part.sinceStep ? ` since ${part.sinceStep}` : ""} · still ${items}`
            : `${items} · [#1..#${part.items}]`}
        </span>
        {!part.quiet && total > 0 && (
          <span
            className="m-strip"
            title={part.records.map((r) => `drop #${r.drop} · ${r.covered} covered`).join(" / ")}
          >
            {part.records.map((r) => (
              <i
                key={r.drop}
                title={`drop #${r.drop} · ${r.covered} covered`}
                style={{
                  width: `${(r.covered / total) * 100}%`,
                  background: `color-mix(in oklch, var(--accent) ${r.drop % 2 === 0 ? 60 : 85}%, var(--paper))`,
                }}
              />
            ))}
          </span>
        )}
        <span
          className="innate-chip"
          title="derived client-side from drop receipts + stage boundaries — not a runtime event"
        >
          derived
        </span>
      </summary>
      <div className="t-body">
        <pre className="chat-code">
          {part.quiet
            ? `Pack unchanged — still ${items} across ${count(part.records.length, "drop")}.`
            : part.previews.map((row) => `[#${row.index}] ${row.preview}`).join("\n") ||
              `${items} carried — no previews on record.`}
        </pre>
      </div>
    </details>
  );
}

function ForkStrip({ part }: { part: ForkDelta }) {
  return (
    <div className="strip sd">
      <span className="d-badge" aria-hidden>
        ⑂
      </span>
      <span>
        fork
        {part.sharedKeys.length > 0
          ? ` · shared: ${part.sharedKeys.join(", ")}`
          : " · no run-scoped keys shared"}
      </span>
    </div>
  );
}

function JoinStrip({ part }: { part: JoinDelta }) {
  return (
    <div className="strip sd">
      <span className="d-badge" aria-hidden>
        ⨝
      </span>
      <span>join · merged: {part.mergedKeys.length > 0 ? part.mergedKeys.join(", ") : "none"}</span>
      {part.discardedKeys.length > 0 && (
        <span className="strip-discard">
          · discarded: {part.discardedKeys.join(", ")} (no merge reducer)
        </span>
      )}
    </div>
  );
}

export function StateDeltaPart({ part }: { part: StateDelta }) {
  switch (part.op) {
    case "drop":
      return <DropFrame part={part} />;
    case "absorb":
      return <AbsorbFrame part={part} />;
    case "read":
      return <ReadFrame part={part} />;
    case "write":
      return <WriteFrame part={part} />;
    case "travel":
      return <TravelFrame part={part} />;
    case "fork":
      return <ForkStrip part={part} />;
    case "join":
      return <JoinStrip part={part} />;
    default:
      return null;
  }
}

/* ── coalesced state ops (#226 — 3+ consecutive same-site write frames) ─────*/
function groupLine(f: StateDelta): string {
  if (f.op === "drop")
    return `drop${f.dropSeq != null ? ` #${f.dropSeq}` : ""} · +${f.accepted}${
      f.merged ? ` ~${f.merged}` : ""
    }${f.skipped ? ` ø${f.skipped}` : ""} · ${f.key}`;
  if (f.op === "absorb")
    return `absorb${f.dropSeq != null ? ` #${f.dropSeq}` : ""} · +${f.accepted}${
      f.merged ? ` ~${f.merged}` : ""
    } · ${f.key}`;
  if (f.op === "write") return `${f.key} · ${f.writeOp}`;
  return f.op;
}

export function StateGroupPart({ parts }: { parts: StateDelta[] }) {
  const byKey = new Map<string, { adds: number; writes: number }>();
  const minted: number[] = [];
  for (const f of parts) {
    if (f.op !== "drop" && f.op !== "absorb" && f.op !== "write") continue;
    let agg = byKey.get(f.key);
    if (!agg) {
      agg = { adds: 0, writes: 0 };
      byKey.set(f.key, agg);
    }
    if (f.op === "write") agg.writes++;
    else {
      agg.adds += f.accepted;
      minted.push(...(f.op === "drop" ? f.indexes : f.appendedIndexes));
    }
  }
  const ords = parts
    .map((f) => f.ordinal)
    .filter((o): o is number => o != null)
    .sort((a, b) => a - b);
  const first = ords[0];
  const last = ords[ords.length - 1];
  const prov = first != null && last != null ? `w#${first}–w#${last} · expand ▾` : "expand ▾";
  return (
    <details className="chat-delta sd" data-minted={minted.join(" ") || undefined}>
      <summary>
        <span className="d-badge" aria-hidden>
          Δ
        </span>
        <span className="d-key ops">{parts.length} state ops</span>
        {[...byKey].map(([key, agg]) => (
          <Fragment key={key}>
            {agg.adds > 0 && (
              <span className="pill add">
                {key} +{agg.adds}
              </span>
            )}
            {agg.writes > 0 && (
              <span className="pill mrg">
                {key} ✎{agg.writes}
              </span>
            )}
          </Fragment>
        ))}
        <span className="d-prov">{prov}</span>
      </summary>
      <div className="d-body">
        <pre className="chat-code">{parts.map(groupLine).join("\n")}</pre>
      </div>
    </details>
  );
}

/* ── error ──────────────────────────────────────────────────────────────────*/
function ErrorPart({ errorType, message }: { errorType: string; message: string }) {
  return (
    <div className="chat-error">
      <span aria-hidden>⚠</span>
      <span>
        <strong>{errorType}</strong>
        {message ? ` — ${message}` : ""}
      </span>
    </div>
  );
}

/* ── dispatcher ─────────────────────────────────────────────────────────────*/
export function PartView({
  part,
  role,
}: {
  part: Part;
  role: "user" | "assistant";
}) {
  switch (part.kind) {
    case "text":
      return <TextPart content={part.content} role={role} />;
    case "thinking":
      return <ThinkingPart content={part.content} complete={part.complete} />;
    case "tool_call":
      return <ToolCallPart part={part} />;
    case "agent_step":
      return <AgentStepPart part={part} role={role} />;
    case "input_request":
      return <InputRequestPart part={part} />;
    case "state_delta":
      return <StateDeltaPart part={part} />;
    case "state_group":
      return <StateGroupPart parts={part.parts} />;
    case "error":
      return <ErrorPart errorType={part.errorType} message={part.message} />;
    default:
      return null;
  }
}

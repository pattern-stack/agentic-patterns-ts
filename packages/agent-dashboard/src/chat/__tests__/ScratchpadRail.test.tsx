/**
 * ScratchpadRail (#226) — rail states (empty / streaming / scrubbed /
 * mismatch), the mockup's copy + class grammar, bidirectional seeks (always
 * scoped to the chat column, density-honest), the evidence provenance
 * popover (500ms) + click-pinned detail card, the peek line, and the
 * RailDelta recency contract (cursor+1 animates, jumps settle).
 * Testing-library render + fireEvent, per `state-delta-parts.test.tsx`.
 */
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EventLike } from "../../graph/trace-from-events";
import { type RailSeekRequest, ScratchpadRail, type ScratchpadRailSource } from "../ScratchpadRail";

// Replay mode fetches the linked run's events — mocked so the seek tests can
// control WHEN the feed lands (the mount-before-events retry seam).
const fetchRunEventsMock = vi.hoisted(() => vi.fn());
vi.mock("../../lib/runsApi", () => ({ fetchRunEvents: fetchRunEventsMock }));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  fetchRunEventsMock.mockReset();
});

// ---------------------------------------------------------------------------
// A compact run: retrieve drops evidence (1 skipped, tool-attributed), the
// framework saves the stage output, brief starts and injects it, agent code
// keeps brief.highlights. Wire shape = live SSE post-toEventLike.
// ---------------------------------------------------------------------------

const EVENTS: EventLike[] = [
  { type: "step.start", span_id: "s1", step_name: "retrieve", agent_name: "retrieve" },
  { type: "tool.start", tool_call_id: "t1", tool_name: "search_deal_context" },
  {
    type: "backpack.drop",
    key: "backpack.observations",
    origin: "explicit",
    ordinal: 1,
    accepted: 2,
    merged: 0,
    skipped: 1,
    indexes: [1, 2],
    size_before: 0,
    size_after: 2,
    previews: [
      { index: 1, op: "added", preview: "obs · security review gating" },
      { index: 2, op: "added", preview: "obs · CFO approved budget" },
    ],
    previews_omitted: 0,
    tool_call_id: "t1",
    tag: '{"facet":"observations"}',
    display: { caption: "Evidence" },
  },
  {
    type: "scratchpad.write",
    key: "agents.retrieve",
    origin: "innate",
    ordinal: 2,
    op: "set",
    had_value: false,
    after: "gathered",
  },
  { type: "step.end", span_id: "s1", step_name: "retrieve", result: "gathered" },
  { type: "step.start", span_id: "s2", step_name: "brief", agent_name: "brief" },
  { type: "scratchpad.read", key: "agents.retrieve", origin: "innate", ordinal: 3, preview: "g" },
  {
    type: "scratchpad.write",
    key: "brief.highlights",
    origin: "explicit",
    ordinal: 4,
    op: "set",
    had_value: false,
    after: '["#1"]',
  },
];

const live = (events: EventLike[], streaming = false): ScratchpadRailSource => ({
  kind: "live",
  events,
  streaming,
});

/** Rail + a stand-in chat column carrying the frames the seeks target. */
function Harness({
  events = EVENTS,
  streaming = false,
  cursor,
  seekKey = null,
  density = "writes",
  frames = true,
  source,
  onSeekConsumed,
}: {
  events?: EventLike[];
  streaming?: boolean;
  cursor?: number;
  seekKey?: RailSeekRequest | null;
  density?: string;
  frames?: boolean;
  source?: ScratchpadRailSource;
  onSeekConsumed?: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div>
      <div ref={ref} className="chat-route" data-density={density}>
        <div className="chat-root">
          <div className="chat-scroll">
            {frames && (
              <>
                <details
                  className="chat-delta sd"
                  data-skey="backpack.observations"
                  data-minted="1 2"
                  data-drop-seq="0"
                  data-testid="frame-drop"
                >
                  <summary>Δ</summary>
                </details>
                <details
                  className="chat-delta sd innate"
                  data-skey="agents.retrieve"
                  data-testid="frame-stage"
                >
                  <summary>Δ</summary>
                </details>
                <details
                  className="chat-delta sd"
                  data-skey="brief.highlights"
                  data-testid="frame-slot"
                >
                  <summary>Δ</summary>
                </details>
                {/* LATER in document order: the same keys' read + derived
                    travel frames — parts.tsx stamps data-skey on those too.
                    Producing-frame seeks must NOT land here even though these
                    are each key's LAST match. */}
                <details
                  className="travel sd"
                  data-skey="backpack.observations"
                  data-testid="frame-travel"
                >
                  <summary>⇄</summary>
                </details>
                <div
                  className="strip sd readframe"
                  data-skey="agents.retrieve"
                  data-testid="frame-stage-read"
                />
                <div
                  className="strip sd readframe"
                  data-skey="brief.highlights"
                  data-testid="frame-slot-read"
                />
                <button type="button" className="cite" data-idx="1">
                  [#1]
                </button>
              </>
            )}
          </div>
        </div>
      </div>
      <ScratchpadRail
        source={source ?? live(events, streaming)}
        cursor={cursor}
        chatRoot={ref}
        seekKey={seekKey}
        onSeekConsumed={onSeekConsumed}
      />
    </div>
  );
}

const rail = (c: HTMLElement) => c.querySelector(".scratchpad-rail") as HTMLElement;

// ---------------------------------------------------------------------------
// Rail states
// ---------------------------------------------------------------------------

describe("rail states", () => {
  it("empty: teaches the mental model — orientation line + three caption skeletons, no footer", () => {
    const { container } = render(<Harness events={[]} />);
    const r = rail(container);
    expect(r.querySelector(".rail-head .t")?.textContent).toBe("Scratchpad");
    // The redundant, truncating ".sub" caption was removed — the ConsoleRail tab
    // strip already labels "Scratchpad" and the teaching line below + the header
    // `title` tooltip carry the full "what this run carries between stages" copy.
    expect(r.querySelector(".rail-head .sub")).toBeNull();
    expect(r.querySelector(".rail-head")?.getAttribute("title")).toContain(
      "Not user memory: it lives and dies with the run.",
    );
    expect(r.querySelector(".rail-teach")?.textContent).toContain(
      "What this run carries between stages.",
    );
    expect(r.querySelector(".rail-teach")?.textContent).toContain(
      "click a row to jump to its write",
    );
    const caps = [...r.querySelectorAll(".rail-teach-caps .rail-cap")].map((c) => c.textContent);
    expect(caps).toEqual([
      "Evidence packs fill as tools add results",
      "Stage outputs saved when each stage finishes",
      "Kept values appears when agent code keeps one",
    ]);
    expect(r.querySelector(".rail-foot")).toBeNull();
    expect(r.querySelector(".hero")).toBeNull();
  });

  it("steady state: three-writer captions, hero grammar, collapsed ledger, receipt footer", () => {
    const { container } = render(<Harness />);
    const r = rail(container);

    // Backpack caption from the event-carried display metadata (demo: Evidence).
    const caps = [...r.querySelectorAll(".rail-body > div > .rail-cap")];
    expect(caps.map((c) => c.textContent)).toEqual([
      "Evidence ↳ added by tools",
      "Stage outputs ↳ saved by the framework",
      "Kept values · 1 ↳ written by agent code",
    ]);

    // Hero: mono key with de-emphasized namespace, sub-line (nonzero segments
    // only), focal numeral.
    const hero = r.querySelector('.hero[data-key="backpack.observations"]');
    expect(hero?.querySelector(".hero-key .k")?.textContent).toBe("backpack.observations");
    expect(hero?.querySelector(".hero-key .k .ns")?.textContent).toBe("backpack.");
    expect(hero?.querySelector(".hero-key .s")?.textContent).toBe("1 drop · 1 skipped");
    expect(hero?.querySelector(".hero-n")?.textContent).toBe("2");
    expect(hero?.querySelector(".hero-main")?.getAttribute("title")).toBe(
      'drop #0 · ↳ search_deal_context · {"facet":"observations"} · 2 covered',
    );

    // Ledger collapsed by default; chevron (own target) toggles it.
    const chev = hero?.querySelector(".chev") as HTMLElement;
    const ledger = r.querySelector(".idx-list") as HTMLElement;
    expect(chev.getAttribute("aria-expanded")).toBe("false");
    expect(ledger.hidden).toBe(true);
    fireEvent.click(chev);
    expect(ledger.hidden).toBe(false);
    expect([...ledger.querySelectorAll(".idx-row .hnd")].map((h) => h.textContent)).toEqual([
      "[#1]",
      "[#2]",
    ]);

    // Stage chain reads as memory, not progress: "1/2 saved".
    const chain = r.querySelector(".chain") as HTMLElement;
    expect(chain.textContent).toBe("retrieve → brief");
    expect(chain.querySelector(".done")?.textContent).toBe("retrieve");
    expect(chain.querySelector(".cur")?.textContent).toBe("brief");
    expect(r.querySelector(".frac")?.textContent).toBe("1/2");
    expect(r.querySelector(".saved-sfx")?.textContent).toBe("saved");

    // Stage rows behind the chevron: auto chip + ✓ set + pending.
    const stageRows = r.querySelector(".stage-rows") as HTMLElement;
    expect(stageRows.hidden).toBe(true);
    fireEvent.click(r.querySelector('[aria-controls="rail-stage-rows"]') as HTMLElement);
    expect(stageRows.hidden).toBe(false);
    expect(stageRows.querySelector(".innate-chip")?.textContent).toBe("auto");
    expect(stageRows.querySelector(".innate-chip")?.getAttribute("title")).toContain("innate");
    const srows = [...stageRows.querySelectorAll(".srow")];
    expect(srows[0]?.textContent).toContain("agents.retrieve");
    expect(srows[0]?.querySelector(".st")?.textContent).toBe("✓ set");
    expect(srows[0]?.querySelector(".sfx")?.textContent).toBe("→ prompt");
    expect(srows[1]?.textContent).toContain("agents.brief");
    expect(srows[1]?.classList.contains("pending")).toBe(true);

    // Quiet slot row.
    const slot = r.querySelector('.slot-row[data-key="brief.highlights"]');
    expect(slot?.querySelector(".k")?.textContent).toBe("brief.highlights");
    expect(slot?.querySelector(".v")?.textContent).toBe('["#1"]');

    // Receipt-language footer, healthy = near-silent.
    const foot = r.querySelector(".rail-foot") as HTMLElement;
    expect(foot.classList.contains("mismatch")).toBe(false);
    expect(foot.textContent).toContain("✓ matches all write receipts");
    expect(foot.textContent).toContain("rebuilt from 1 drop receipt");
  });

  it("caption falls back to GATHERED ↳ added by tools when the spec sets no display", () => {
    const events = EVENTS.map((e) =>
      e.type === "backpack.drop" ? { ...e, display: undefined } : e,
    );
    const { container } = render(<Harness events={events} />);
    expect(rail(container).querySelector(".rail-cap")?.textContent).toBe(
      "Gathered ↳ added by tools",
    );
  });

  it("streaming: live dot on, verdict withheld", () => {
    const { container } = render(<Harness streaming />);
    const r = rail(container);
    expect(r.querySelector(".live-dot")?.textContent).toContain("live");
    const foot = r.querySelector(".rail-foot") as HTMLElement;
    expect(foot.textContent).not.toContain("✓ matches");
    expect(foot.textContent).toContain("reconciling — run in progress");
  });

  it("scrubbed: the as-of pill replaces the live dot and the gauge tints violet", () => {
    const { container } = render(<Harness cursor={3} streaming />);
    const r = rail(container);
    expect(r.classList.contains("scrubbed")).toBe(true);
    expect(r.querySelector(".asof")?.textContent).toBe("as of step 3/8");
    expect(r.querySelector(".live-dot")).toBeNull();
    // fold(0..3) — the drop landed, nothing else yet.
    expect(r.querySelector(".hero-n")?.textContent).toBe("2");
    expect(r.querySelector(".slot-row")).toBeNull();
  });

  it("mismatch: the ONLY loud state — receipts language, clickable, seeks the divergence", () => {
    const events = EVENTS.map((e) => (e.type === "backpack.drop" ? { ...e, size_after: 3 } : e));
    const { container } = render(<Harness events={events} />);
    const foot = rail(container).querySelector(".rail-foot.mismatch") as HTMLElement;
    expect(foot).not.toBeNull();
    expect(foot.textContent).toContain("⚠ receipts disagree — receipts say 2, scratchpad shows 3");
    fireEvent.click(foot);
    const frame = container.querySelector('[data-testid="frame-drop"]') as HTMLDetailsElement;
    expect(frame.classList.contains("flash")).toBe(true);
    expect(frame.open).toBe(true);
  });

  it("replay with no linked run explains honestly instead of fabricating", () => {
    const { container } = render(<Harness source={{ kind: "replay", runId: null }} />);
    expect(rail(container).textContent).toContain("No run linked to this exchange");
  });
});

// ---------------------------------------------------------------------------
// Ledger overflow
// ---------------------------------------------------------------------------

describe("ledger overflow", () => {
  it("folds past 12 rows behind 'N excluded · show'", () => {
    const previews = Array.from({ length: 15 }, (_, i) => ({
      index: i + 1,
      op: "added" as const,
      preview: `obs · ${i + 1}`,
    }));
    const events: EventLike[] = [
      {
        type: "backpack.drop",
        key: "backpack.observations",
        origin: "explicit",
        ordinal: 1,
        accepted: 15,
        merged: 0,
        skipped: 0,
        indexes: previews.map((p) => p.index),
        size_before: 0,
        size_after: 15,
        previews,
        previews_omitted: 0,
      },
    ];
    const { container } = render(<Harness events={events} />);
    const r = rail(container);
    fireEvent.click(r.querySelector(".chev") as HTMLElement);
    expect(r.querySelectorAll(".idx-row")).toHaveLength(12);
    const more = r.querySelector(".idx-more") as HTMLElement;
    expect(more.textContent).toBe("3 excluded · show");
    fireEvent.click(more);
    expect(r.querySelectorAll(".idx-row")).toHaveLength(15);
    expect(r.querySelector(".idx-more")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Bidirectional seeks
// ---------------------------------------------------------------------------

describe("seeks", () => {
  it("rail row → producing frame: opens + flashes the DROP frame, not the key's later travel frame", () => {
    const { container } = render(<Harness />);
    fireEvent.click(rail(container).querySelector(".hero-main") as HTMLElement);
    const frame = container.querySelector('[data-testid="frame-drop"]') as HTMLDetailsElement;
    expect(frame.open).toBe(true);
    expect(frame.classList.contains("flash")).toBe(true);
    // The travel frame is the key's LAST [data-skey] match in document order —
    // a bare last-match seek would land there instead of the write.
    expect(
      (container.querySelector('[data-testid="frame-travel"]') as HTMLElement).classList.contains(
        "flash",
      ),
    ).toBe(false);
  });

  it("stage row and slot row seek their WRITE frames, skipping the keys' later read frames", () => {
    const { container } = render(<Harness />);
    const r = rail(container);
    fireEvent.click(r.querySelector('[aria-controls="rail-stage-rows"]') as HTMLElement);
    fireEvent.click(r.querySelector('.srow[data-key="agents.retrieve"]') as HTMLElement);
    expect(
      (container.querySelector('[data-testid="frame-stage"]') as HTMLElement).classList.contains(
        "flash",
      ),
    ).toBe(true);
    // agents.retrieve's later "→ prompt" ReadFrame carries the same data-skey.
    expect(
      (
        container.querySelector('[data-testid="frame-stage-read"]') as HTMLElement
      ).classList.contains("flash"),
    ).toBe(false);
    fireEvent.click(r.querySelector('.slot-row[data-key="brief.highlights"]') as HTMLElement);
    expect(
      (container.querySelector('[data-testid="frame-slot"]') as HTMLElement).classList.contains(
        "flash",
      ),
    ).toBe(true);
    expect(
      (
        container.querySelector('[data-testid="frame-slot-read"]') as HTMLElement
      ).classList.contains("flash"),
    ).toBe(false);
  });

  it("density Off: a rail seek bubbles the honest reveal event before seeking", () => {
    const { container } = render(<Harness density="off" />);
    let revealed = 0;
    (container.querySelector(".chat-route") as HTMLElement).addEventListener(
      "chat:reveal-state-frames",
      () => {
        revealed += 1;
      },
    );
    fireEvent.click(rail(container).querySelector(".hero-main") as HTMLElement);
    expect(revealed).toBe(1);
  });

  it("reverse seek (`.d-key` → rail): flashes the slot row for the key", () => {
    const { container } = render(<Harness seekKey={{ key: "brief.highlights", nonce: 1 }} />);
    const row = rail(container).querySelector('[data-key="brief.highlights"]') as HTMLElement;
    expect(row.classList.contains("flash")).toBe(true);
  });

  it("reverse seek to a stage key opens the stage rows first (never seeks to nothing)", () => {
    const { container } = render(<Harness seekKey={{ key: "agents.retrieve", nonce: 1 }} />);
    const r = rail(container);
    expect((r.querySelector(".stage-rows") as HTMLElement).hidden).toBe(false);
    expect(
      (r.querySelector('.srow[data-key="agents.retrieve"]') as HTMLElement).classList.contains(
        "flash",
      ),
    ).toBe(true);
  });

  it("a handled reverse seek is CONSUMED exactly once — a re-render can't replay the same nonce", () => {
    const onSeekConsumed = vi.fn();
    const { container, rerender } = render(
      <Harness seekKey={{ key: "brief.highlights", nonce: 5 }} onSeekConsumed={onSeekConsumed} />,
    );
    expect(
      (
        rail(container).querySelector('[data-key="brief.highlights"]') as HTMLElement
      ).classList.contains("flash"),
    ).toBe(true);
    expect(onSeekConsumed).toHaveBeenCalledTimes(1);
    // The bridge not yet cleared: a NEW request object with the SAME nonce
    // (fresh effect run) must be recognized as already handled.
    rerender(
      <Harness seekKey={{ key: "brief.highlights", nonce: 5 }} onSeekConsumed={onSeekConsumed} />,
    );
    expect(onSeekConsumed).toHaveBeenCalledTimes(1);
  });

  it("a reverse seek for a key with no row consumes once the feed is settled (live)", () => {
    const onSeekConsumed = vi.fn();
    render(<Harness seekKey={{ key: "not.carried", nonce: 6 }} onSeekConsumed={onSeekConsumed} />);
    expect(onSeekConsumed).toHaveBeenCalledTimes(1);
  });

  it("replay: a seek arriving before the run's events load RETRIES once the fold lands, then consumes", async () => {
    let resolveEvents!: (v: unknown) => void;
    fetchRunEventsMock.mockReturnValue(
      new Promise((resolve) => {
        resolveEvents = resolve;
      }),
    );
    const onSeekConsumed = vi.fn();
    const { container } = render(
      <Harness
        source={{ kind: "replay", runId: "run-1" }}
        seekKey={{ key: "brief.highlights", nonce: 7 }}
        onSeekConsumed={onSeekConsumed}
      />,
    );
    // Events still in flight: no rows yet — the request must stay PENDING
    // (not silently dropped, not consumed).
    expect(rail(container).querySelector('[data-key="brief.highlights"]')).toBeNull();
    expect(onSeekConsumed).not.toHaveBeenCalled();

    // The feed lands (persisted rows: `{ ...data, type }` — persistedToEventLike).
    await act(async () => {
      resolveEvents({
        kind: "ok",
        data: {
          runId: "run-1",
          events: EVENTS.map((e, i) => ({
            id: i + 1,
            type: `agent.${e.type}`,
            timestamp: "2026-07-12T00:00:00Z",
            traceId: "t",
            runId: "run-1",
            spanId: null,
            ccSessionId: null,
            ccHookName: null,
            ccCwd: null,
            data: { ...e, type: `agent.${e.type}` },
          })),
        },
      });
    });

    const row = rail(container).querySelector('[data-key="brief.highlights"]') as HTMLElement;
    expect(row.classList.contains("flash")).toBe(true);
    expect(onSeekConsumed).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Evidence provenance: hover popover (500ms) + click-pinned detail card
// ---------------------------------------------------------------------------

describe("evidence provenance", () => {
  const openLedger = (container: HTMLElement) => {
    fireEvent.click(rail(container).querySelector(".chev") as HTMLElement);
  };

  it("hovering an evidence row 500ms shows the popover — a pure receipt projection", () => {
    vi.useFakeTimers();
    const { container } = render(<Harness />);
    openLedger(container);
    const row = rail(container).querySelector(".idx-row") as HTMLElement;
    fireEvent.mouseEnter(row);
    act(() => vi.advanceTimersByTime(499));
    expect(rail(container).querySelector(".prov.pop")).toBeNull(); // not yet — 500ms delay
    act(() => vi.advanceTimersByTime(1));
    const pop = rail(container).querySelector(".prov.pop") as HTMLElement;
    expect(pop).not.toBeNull();
    expect(pop.textContent).toContain("[#1]");
    expect(pop.textContent).toContain("obs · security review gating");
    expect(pop.textContent).toContain("drop #0 · ↳ search_deal_context");
    expect(pop.textContent).toContain('{"facet":"observations"}');
    expect(pop.textContent).toContain("click to pin · jump to write · light lineage");
    fireEvent.mouseLeave(row);
    expect(rail(container).querySelector(".prov.pop")).toBeNull();
  });

  it("clicking pins the detail card in-flow; jump to write seeks; close unpins", () => {
    const { container } = render(<Harness />);
    openLedger(container);
    const row = rail(container).querySelector(".idx-row") as HTMLElement;
    fireEvent.click(row);
    const card = rail(container).querySelector(".prov.pinned") as HTMLElement;
    expect(card).not.toBeNull();
    expect(row.classList.contains("pinned-row")).toBe(true);

    const jump = [...card.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("jump to write"),
    ) as HTMLElement;
    fireEvent.click(jump);
    const frame = container.querySelector('[data-testid="frame-drop"]') as HTMLDetailsElement;
    expect(frame.open).toBe(true);
    expect(frame.classList.contains("flash")).toBe(true);

    const close = [...card.querySelectorAll("button")].find(
      (b) => b.textContent === "close",
    ) as HTMLElement;
    fireEvent.click(close);
    expect(rail(container).querySelector(".prov.pinned")).toBeNull();
  });

  it("light lineage flashes EVERY frame that touched the identity", () => {
    const { container } = render(<Harness />);
    openLedger(container);
    fireEvent.click(rail(container).querySelector(".idx-row") as HTMLElement);
    const lineage = [...rail(container).querySelectorAll("button")].find((b) =>
      b.textContent?.includes("light lineage"),
    ) as HTMLElement;
    fireEvent.click(lineage);
    // the harness's drop frame carries data-minted="1 2" — it lights up
    const frame = container.querySelector('[data-testid="frame-drop"]') as HTMLDetailsElement;
    expect(frame.open).toBe(true);
    expect(frame.classList.contains("flash")).toBe(true);
  });

  it("a write missing from the transcript says so instead of a dead seek", () => {
    const { container } = render(<Harness frames={false} />);
    openLedger(container);
    fireEvent.click(rail(container).querySelector(".idx-row") as HTMLElement);
    const jump = [...rail(container).querySelectorAll("button")].find((b) =>
      b.textContent?.includes("jump to write"),
    ) as HTMLElement;
    fireEvent.click(jump);
    expect(rail(container).querySelector(".prov.pinned")?.textContent).toContain(
      "write not in this transcript",
    );
  });
});

// ---------------------------------------------------------------------------
// Peek line + cross-highlight
// ---------------------------------------------------------------------------

describe("peek line", () => {
  it("hovering a [#N] chip with the ledger COLLAPSED overlays the peek line (zero reflow)", () => {
    const { container } = render(<Harness />);
    const chip = container.querySelector(".cite") as HTMLElement;
    fireEvent.mouseOver(chip);
    const hero = rail(container).querySelector(
      '.hero[data-key="backpack.observations"]',
    ) as HTMLElement;
    expect(hero.classList.contains("peeking")).toBe(true);
    expect(hero.querySelector(".peek")?.textContent).toBe("[#1] obs · security review gating");
    fireEvent.mouseOut(chip);
    expect(hero.querySelector(".peek")).toBeNull();
  });

  it("with the ledger OPEN the row highlights instead", () => {
    const { container } = render(<Harness />);
    fireEvent.click(rail(container).querySelector(".chev") as HTMLElement);
    fireEvent.mouseOver(container.querySelector(".cite") as HTMLElement);
    const row = rail(container).querySelector('.idx-row[data-idx="1"]') as HTMLElement;
    expect(row.classList.contains("hl")).toBe(true);
    expect(rail(container).querySelector(".peek")).toBeNull();
  });

  it("keyboard parity: focusing a [#N] chip cross-highlights too (mockup wires focus/blur)", () => {
    const { container } = render(<Harness />);
    const chip = container.querySelector(".cite") as HTMLElement;
    fireEvent.focusIn(chip);
    const hero = rail(container).querySelector(
      '.hero[data-key="backpack.observations"]',
    ) as HTMLElement;
    expect(hero.classList.contains("peeking")).toBe(true);
    fireEvent.focusOut(chip);
    expect(hero.querySelector(".peek")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// RailDelta motion contract — pure function of the cursor diff
// ---------------------------------------------------------------------------

describe("RailDelta recency", () => {
  it("a jump (fresh mount) settles instantly: tick present but .settled", () => {
    const { container } = render(<Harness />);
    const slot = rail(container).querySelector('[data-key="brief.highlights"]') as HTMLElement;
    expect(slot.classList.contains("recent")).toBe(true);
    expect(slot.classList.contains("settled")).toBe(true);
  });

  it("cursor+1 animates one-shot: tick WITHOUT .settled on the newly-written row", () => {
    const { container, rerender } = render(<Harness cursor={3} />);
    // fold(0..3): last write is the drop — evidence hero holds the tick.
    const hero = rail(container).querySelector(
      '.hero[data-key="backpack.observations"]',
    ) as HTMLElement;
    expect(hero.classList.contains("recent")).toBe(true);

    rerender(<Harness cursor={4} />);
    // fold(0..4): +1 event (the innate stage write) — the stage hero animates.
    const stageHero = rail(container).querySelector(".chain")?.closest(".hero") as HTMLElement;
    expect(stageHero.classList.contains("recent")).toBe(true);
    expect(stageHero.classList.contains("settled")).toBe(false);

    // …and a JUMP from there settles instantly.
    rerender(<Harness cursor={8} />);
    const slot = rail(container).querySelector('[data-key="brief.highlights"]') as HTMLElement;
    expect(slot.classList.contains("recent")).toBe(true);
    expect(slot.classList.contains("settled")).toBe(true);
  });
});

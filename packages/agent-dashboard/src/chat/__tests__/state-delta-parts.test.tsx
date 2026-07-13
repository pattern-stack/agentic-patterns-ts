/**
 * StateDeltaPart component family (#226) — one render test per frame type,
 * pinning the mockup's class grammar (`.chat-delta` violet family, `.sd`
 * density hook, dashed `.innate` + `auto` chip, glyphs Δ/◇/⇄/⨝, pills,
 * `data-minted` seek targets) plus [#N] cite linkification + seek.
 * Testing-library render + fireEvent, per `CaptureCasePanel.test.tsx`.
 */
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Part } from "../model";
import { PartView, StateGroupPart, linkifyCites } from "../parts";
import type { StateDeltaPart as StateDelta } from "../state-accessors";

afterEach(cleanup);

// PartView's `role` prop is the chat role, not an ARIA role — a const
// expression keeps biome's useValidAriaRole from misreading the literal.
const ROLE = "assistant" as const;

const renderPart = (part: Part) =>
  render(
    <div className="chat-root">
      <PartView part={part} role={ROLE} />
    </div>,
  );

const drop: Extract<StateDelta, { op: "drop" }> = {
  kind: "state_delta",
  op: "drop",
  key: "backpack.observations",
  origin: "explicit",
  ordinal: 1,
  toolCallId: "t1",
  via: "search_deal_context",
  accepted: 4,
  merged: 1,
  skipped: 1,
  indexes: [1, 2, 3, 4],
  sizeBefore: 0,
  sizeAfter: 4,
  previews: [
    { index: 1, op: "added", preview: "obs · security review gating" },
    { index: 2, op: "merged", preview: "same observation resurfaced" },
  ],
  previewsOmitted: 2,
  tag: '{"facet":"observations"}',
  dropSeq: 0,
};

describe("DROP frame", () => {
  it("renders the diff-card grammar: Δ badge, key, +/~/ø pills, size, provenance, data-minted", () => {
    const { container } = renderPart(drop);
    const frame = container.querySelector("details.chat-delta.sd");
    expect(frame).not.toBeNull();
    expect(frame?.getAttribute("data-minted")).toBe("1 2 3 4");
    expect(frame?.querySelector(".d-badge")?.textContent).toBe("Δ");
    expect(frame?.querySelector(".d-key")?.textContent).toBe("backpack.observations");
    expect(frame?.querySelector(".pill.add")?.textContent).toBe("+4");
    expect(frame?.querySelector(".pill.mrg")?.textContent).toBe("~1");
    expect(frame?.querySelector(".pill.skp")?.textContent).toBe("ø1");
    expect(frame?.querySelector(".d-size")?.textContent).toBe("0 → 4");
    expect(frame?.querySelector(".d-prov")?.textContent).toBe("drop #0 · ↳ search_deal_context");
    // diff rows: one .add with [#N] handle, one .mrg, the ø summary row, and
    // the honest previews-omitted row (never silently clipped).
    expect(frame?.querySelector('.d-row.add[data-idx="1"] .hnd')?.textContent).toBe("[#1]");
    expect(frame?.querySelector(".d-row.mrg .lbl")?.textContent).toContain("merged into");
    expect(frame?.querySelectorAll(".d-row.skp")).toHaveLength(2);
    expect(frame?.textContent).toContain("skipped by expand()");
    expect(frame?.textContent).toContain("2 more rows not previewed");
    expect(frame?.querySelector(".tag-chip")?.textContent).toBe('{"facet":"observations"}');
    // explicit drop: solid violet card, NOT dashed-innate
    expect(frame?.classList.contains("innate")).toBe(false);
  });
});

describe("INNATE write frame", () => {
  it("renders dashed + `auto` chip (tooltip preserves 'innate') and the stage-output caption", () => {
    const write: StateDelta = {
      kind: "state_delta",
      op: "write",
      key: "agents.retrieve",
      origin: "innate",
      ordinal: 2,
      writeOp: "set",
      hadValue: false,
      after: "{…}",
    };
    const { container } = renderPart(write);
    const frame = container.querySelector("details.chat-delta.sd.innate");
    expect(frame).not.toBeNull();
    const chip = frame?.querySelector(".innate-chip");
    expect(chip?.textContent).toBe("auto");
    expect(chip?.getAttribute("title")).toContain("innate");
    expect(frame?.textContent).toContain("← stage output · saved for next stage");
    expect(frame?.querySelector(".d-prov")?.textContent).toBe("set · null → {…}");
    // before/after pair
    expect(frame?.querySelector(".ba")).not.toBeNull();
    expect(frame?.textContent).toContain("before");
    expect(frame?.textContent).toContain("after");
  });
});

describe("WRITE frame (explicit)", () => {
  it("renders op + before/after previews", () => {
    const write: StateDelta = {
      kind: "state_delta",
      op: "write",
      key: "brief.highlights",
      origin: "explicit",
      ordinal: 3,
      writeOp: "update",
      hadValue: true,
      before: '["#1"]',
      after: '["#1","#2"]',
    };
    const { container } = renderPart(write);
    const frame = container.querySelector("details.chat-delta.sd");
    expect(frame?.classList.contains("innate")).toBe(false);
    expect(frame?.querySelector(".d-note")?.textContent).toBe("update");
    expect(frame?.textContent).toContain('["#1"]');
    expect(frame?.textContent).toContain('["#1","#2"]');
  });
});

describe("READ frames", () => {
  it("memo hit renders the one-line ◇ strip (never a tall card)", () => {
    const read: StateDelta = {
      kind: "state_delta",
      op: "read",
      key: "backpack.observations",
      scope: "backpack",
      origin: "explicit",
      ordinal: 4,
      memoHit: true,
      size: 6,
    };
    const { container } = renderPart(read);
    const strip = container.querySelector(".strip.sd.readframe");
    expect(strip).not.toBeNull();
    expect(container.querySelector("details")).toBeNull();
    expect(strip?.querySelector(".d-badge.read")?.textContent).toBe("◇");
    expect(strip?.textContent).toContain("finalized() · memo hit · 6 entries");
  });

  it("memo miss renders the expandable readframe with the finalized preview", () => {
    const read: StateDelta = {
      kind: "state_delta",
      op: "read",
      key: "backpack.observations",
      scope: "backpack",
      origin: "explicit",
      ordinal: 4,
      memoHit: false,
      size: 6,
      preview: '{ "timeline": ["#3","#2"] } (preview only)',
    };
    const { container } = renderPart(read);
    const frame = container.querySelector("details.chat-delta.readframe.sd");
    expect(frame).not.toBeNull();
    expect(frame?.textContent).toContain("finalized() · memo miss");
    expect(frame?.textContent).toContain("(preview only)");
  });

  it("innate prompt read renders dashed with the exact injected text", () => {
    const read: StateDelta = {
      kind: "state_delta",
      op: "read",
      key: "agents.correlate",
      scope: "scratchpad",
      origin: "innate",
      ordinal: 5,
      preview: "TASK: Write the deal brief with citations.",
    };
    const { container } = renderPart(read);
    const frame = container.querySelector("details.chat-delta.innate.readframe.sd");
    expect(frame).not.toBeNull();
    expect(frame?.textContent).toContain("→ prompt");
    expect(frame?.textContent).toContain("exact injected text ▾");
    expect(frame?.textContent).toContain("what the model actually saw");
    expect(frame?.textContent).toContain("TASK: Write the deal brief with citations.");
  });

  it("redacted innate prompt read (replay) keeps the frame, says why the text is gone", () => {
    const read: StateDelta = {
      kind: "state_delta",
      op: "read",
      key: "agents.correlate",
      scope: "scratchpad",
      origin: "innate",
      ordinal: 5,
      previewRedacted: true,
    };
    const { container } = renderPart(read);
    expect(container.textContent).toContain("preview redacted");
    expect(container.querySelector(".d-redacted")?.textContent).toContain("never stored");
  });
});

describe("TRAVEL frame (UI-derived)", () => {
  it("renders ⇄ title, item range, manifest strip segments ∝ covered, and the derived chip", () => {
    const travel: StateDelta = {
      kind: "state_delta",
      op: "travel",
      key: "backpack.observations",
      origin: "innate",
      derived: true,
      toStep: "correlate",
      items: 6,
      records: [
        { drop: 0, covered: 4 },
        { drop: 1, covered: 2 },
      ],
      previews: [{ index: 1, op: "added", preview: "obs · one" }],
    };
    const { container } = renderPart(travel);
    const frame = container.querySelector("details.travel.sd");
    expect(frame).not.toBeNull();
    expect(frame?.classList.contains("quiet")).toBe(false);
    expect(frame?.querySelector(".t-glyph")?.textContent).toBe("⇄");
    expect(frame?.querySelector(".t-title")?.textContent).toContain(
      "backpack.observations travels → correlate",
    );
    expect(frame?.querySelector(".t-sub")?.textContent).toBe("6 items · [#1..#6]");
    const segs = frame?.querySelectorAll(".m-strip i") ?? [];
    expect(segs).toHaveLength(2);
    expect((segs[0] as HTMLElement).style.width).toBe(`${(4 / 6) * 100}%`);
    expect((segs[1] as HTMLElement).style.width).toBe(`${(2 / 6) * 100}%`);
    expect(frame?.textContent).toContain("derived");
    expect(frame?.querySelector(".t-body")?.textContent).toContain("[#1] obs · one");
  });

  it("quiet variant is honest when nothing changed", () => {
    const travel: StateDelta = {
      kind: "state_delta",
      op: "travel",
      key: "backpack.observations",
      origin: "innate",
      derived: true,
      toStep: "brief",
      items: 6,
      records: [{ drop: 0, covered: 6 }],
      previews: [],
      quiet: true,
      sinceStep: "retrieve",
    };
    const { container } = renderPart(travel);
    const frame = container.querySelector("details.travel.quiet");
    expect(frame).not.toBeNull();
    expect(frame?.querySelector(".t-sub")?.textContent).toBe(
      "no new drops since retrieve · still 6 items",
    );
    expect(frame?.querySelector(".m-strip")).toBeNull(); // no strip when quiet
  });
});

describe("ABSORB frame", () => {
  it("renders the branch fan-in with appended handles + stable-parent-index note", () => {
    const absorb: StateDelta = {
      kind: "state_delta",
      op: "absorb",
      key: "backpack.observations",
      origin: "innate",
      ordinal: 8,
      childSize: 3,
      accepted: 2,
      merged: 1,
      sizeBefore: 12,
      sizeAfter: 14,
      appendedIndexes: [13, 14],
    };
    const { container } = renderPart(absorb);
    const frame = container.querySelector("details.chat-delta.sd");
    expect(frame?.getAttribute("data-minted")).toBe("13 14");
    expect(frame?.querySelector(".d-badge")?.textContent).toBe("⇄");
    expect(frame?.querySelector(".d-prov")?.textContent).toBe("appended [#13..#14]");
    expect(frame?.querySelector(".pill.add")?.textContent).toBe("+2");
    expect(frame?.querySelector(".pill.mrg")?.textContent).toBe("~1");
    expect(frame?.textContent).toContain("parent indexes stay stable");
  });
});

describe("FORK / JOIN strips", () => {
  it("join calls out the silent-discard trap in error ink", () => {
    const join: StateDelta = {
      kind: "state_delta",
      op: "join",
      origin: "innate",
      ordinal: 9,
      mergedKeys: ["notes.draft"],
      discardedKeys: ["temp.scratch"],
    };
    const { container } = renderPart(join);
    const strip = container.querySelector(".strip.sd");
    expect(strip?.querySelector(".d-badge")?.textContent).toBe("⨝");
    expect(strip?.textContent).toContain("merged: notes.draft");
    expect(strip?.querySelector(".strip-discard")?.textContent).toContain(
      "discarded: temp.scratch (no merge reducer)",
    );
  });

  it("fork lists the shared keys", () => {
    const fork: StateDelta = {
      kind: "state_delta",
      op: "fork",
      origin: "innate",
      ordinal: 10,
      sharedKeys: ["notes.draft", "brief.highlights"],
    };
    const { container } = renderPart(fork);
    expect(container.querySelector(".strip.sd")?.textContent).toContain(
      "shared: notes.draft, brief.highlights",
    );
  });
});

describe("state_group (coalesced summary)", () => {
  it("renders 'N state ops', per-key pills, the w# ordinal range, and compact lines", () => {
    const frames: StateDelta[] = [
      { ...drop, ordinal: 3, dropSeq: 4, accepted: 1, indexes: [12], previews: [], tag: undefined },
      {
        kind: "state_delta",
        op: "write",
        key: "notes.progress",
        origin: "explicit",
        ordinal: 4,
        writeOp: "update",
        hadValue: true,
        after: "deal 4/12",
      },
      { ...drop, ordinal: 5, dropSeq: 5, accepted: 1, indexes: [13], previews: [], tag: undefined },
    ];
    const { container } = render(<StateGroupPart parts={frames} />);
    const frame = container.querySelector("details.chat-delta.sd");
    expect(frame?.querySelector(".d-key.ops")?.textContent).toBe("3 state ops");
    expect(frame?.querySelector(".pill.add")?.textContent).toBe("backpack.observations +2");
    expect(frame?.querySelector(".pill.mrg")?.textContent).toBe("notes.progress ✎1");
    expect(frame?.querySelector(".d-prov")?.textContent).toBe("w#3–w#5 · expand ▾");
    expect(frame?.getAttribute("data-minted")).toBe("12 13");
    const body = frame?.querySelector(".chat-code")?.textContent ?? "";
    expect(body).toContain("drop #4 · +1 ~1 ø1 · backpack.observations");
    expect(body).toContain("notes.progress · update");
  });
});

describe("[#N] cite chips in assistant markdown", () => {
  it("linkifyCites wraps handles outside code, leaves code/pre untouched", () => {
    const html = linkifyCites("<p>see [#1] and [#12]</p><code>[#2]</code><pre>[#3]</pre>");
    expect(html).toContain('<button type="button" class="cite" data-idx="1">[#1]</button>');
    expect(html).toContain('<button type="button" class="cite" data-idx="12">[#12]</button>');
    expect(html).toContain("<code>[#2]</code>");
    expect(html).toContain("<pre>[#3]</pre>");
  });

  it("a text part renders cite buttons; clicking one opens + flashes the minting frame", () => {
    const { container } = render(
      <div className="chat-root">
        <PartView part={drop} role={ROLE} />
        <PartView part={{ kind: "text", content: "Security review is gating [#1]." }} role={ROLE} />
      </div>,
    );
    const chip = container.querySelector("button.cite");
    expect(chip).not.toBeNull();
    expect(chip?.textContent).toBe("[#1]");
    const frame = container.querySelector('details[data-minted~="1"]') as HTMLDetailsElement;
    expect(frame.open).toBe(false);
    fireEvent.click(chip as HTMLElement);
    expect(frame.open).toBe(true);
    expect(frame.classList.contains("flash")).toBe(true);
  });

  it("hovering a chip sets a provenance title from the minting frame's rendered row", () => {
    const { container } = render(
      <div className="chat-root">
        <PartView part={drop} role={ROLE} />
        <PartView part={{ kind: "text", content: "see [#1]" }} role={ROLE} />
      </div>,
    );
    const chip = container.querySelector("button.cite") as HTMLElement;
    fireEvent.mouseOver(chip);
    expect(chip.title).toBe("[#1] obs · security review gating — drop #0 · ↳ search_deal_context");
  });

  it("a chip with no minting frame in the transcript says so honestly on hover", () => {
    const { container } = render(
      <div className="chat-root">
        <PartView part={{ kind: "text", content: "see [#9]" }} role={ROLE} />
      </div>,
    );
    const chip = container.querySelector("button.cite") as HTMLElement;
    fireEvent.mouseOver(chip);
    expect(chip.title).toBe("[#9] — minting frame not in this transcript");
    // and clicking it is a safe no-op
    fireEvent.click(chip);
  });

  it("clicking a cite opens ancestor <details> too — a completed step otherwise hides nested frames", () => {
    // Mirrors AgentStepPart's markup once `open={running || !!part.error}`
    // has flipped to false: the drop frame sits inside a CLOSED <details>,
    // so without the ancestor walk the seek would measure a hidden element.
    const { container } = render(
      <div className="chat-root">
        <details className="chat-tool chat-step ok">
          <summary>delegate</summary>
          <div className="step-children">
            <PartView part={drop} role={ROLE} />
          </div>
        </details>
        <PartView part={{ kind: "text", content: "see [#1]" }} role={ROLE} />
      </div>,
    );
    const step = container.querySelector("details.chat-step") as HTMLDetailsElement;
    const frame = container.querySelector('details[data-minted~="1"]') as HTMLDetailsElement;
    expect(step.open).toBe(false);
    fireEvent.click(container.querySelector("button.cite") as HTMLElement);
    expect(step.open).toBe(true);
    expect(frame.open).toBe(true);
    expect(frame.classList.contains("flash")).toBe(true);
  });

  it("resolves the minting frame within the citing message first — [#N] restarts every run/turn", () => {
    const turn1: typeof drop = {
      ...drop,
      previews: [{ index: 1, op: "added", preview: "turn-one entry" }],
    };
    const turn2: typeof drop = {
      ...drop,
      previews: [{ index: 1, op: "added", preview: "turn-two entry" }],
    };
    const { container } = render(
      <div className="chat-root">
        <div className="chat-row assistant">
          <PartView part={turn1} role={ROLE} />
        </div>
        <div className="chat-row assistant">
          <PartView part={turn2} role={ROLE} />
          <PartView part={{ kind: "text", content: "see [#1]" }} role={ROLE} />
        </div>
      </div>,
    );
    const frames = container.querySelectorAll<HTMLDetailsElement>('details[data-minted~="1"]');
    expect(frames).toHaveLength(2);
    const chip = container.querySelector("button.cite") as HTMLElement;
    // hover title comes from the citing turn's frame, not turn 1's
    fireEvent.mouseOver(chip);
    expect(chip.title).toBe("[#1] turn-two entry — drop #0 · ↳ search_deal_context");
    // click seeks the citing turn's frame, not turn 1's
    fireEvent.click(chip);
    expect(frames[1]?.open).toBe(true);
    expect(frames[1]?.classList.contains("flash")).toBe(true);
    expect(frames[0]?.open).toBe(false);
    expect(frames[0]?.classList.contains("flash")).toBe(false);
  });

  it("falls back to a panel-wide lookup when the citing message has no minting frame", () => {
    const { container } = render(
      <div className="chat-root">
        <div className="chat-row assistant">
          <PartView part={drop} role={ROLE} />
        </div>
        <div className="chat-row assistant">
          <PartView part={{ kind: "text", content: "see [#1]" }} role={ROLE} />
        </div>
      </div>,
    );
    fireEvent.click(container.querySelector("button.cite") as HTMLElement);
    const frame = container.querySelector('details[data-minted~="1"]') as HTMLDetailsElement;
    expect(frame.open).toBe(true);
    expect(frame.classList.contains("flash")).toBe(true);
  });

  it("hovering a minted-but-not-previewed handle stays honest: provenance only, no other row's text", () => {
    // drop mints [#1..#4] but previews only rows 1 and 2 — [#3]'s title must
    // never borrow a different row's label.
    const { container } = render(
      <div className="chat-root">
        <PartView part={drop} role={ROLE} />
        <PartView part={{ kind: "text", content: "see [#3]" }} role={ROLE} />
      </div>,
    );
    const chip = container.querySelector("button.cite") as HTMLElement;
    fireEvent.mouseOver(chip);
    expect(chip.title).toBe("[#3] — drop #0 · ↳ search_deal_context");
  });

  it("cite seek with density Off bubbles the honest reveal event before seeking", () => {
    let revealed = 0;
    const { container } = render(
      <div data-density="off">
        <div className="chat-root">
          <PartView part={drop} role={ROLE} />
          <PartView part={{ kind: "text", content: "see [#1]" }} role={ROLE} />
        </div>
      </div>,
    );
    (container.firstElementChild as HTMLElement).addEventListener(
      "chat:reveal-state-frames",
      () => {
        revealed++;
      },
    );
    fireEvent.click(container.querySelector("button.cite") as HTMLElement);
    expect(revealed).toBe(1);
  });
});

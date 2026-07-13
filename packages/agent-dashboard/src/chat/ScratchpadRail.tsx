/**
 * ScratchpadRail (#226) — the third Console rail tab: "Scratchpad · what this
 * run carries between stages". Rail v3 (the self-captioning Carry Gauge):
 * every group gets exactly ONE focal number, every list lives behind
 * disclosure, healthy states are nearly silent, and a receipt mismatch is the
 * only loud element the rail is ever allowed.
 *
 * Everything rendered is `foldInventory(events[0..cursor])` — a pure fold
 * sharing the tolerant accessor module with the timeline's `applyParts`, so
 * the two surfaces can never drift. Only disclosure state is rail-local.
 *
 * RailDelta motion contract: choreography is a pure function of
 * `diff(fold(0..cursor-1), fold(0..cursor))` — cursor+1 animates the recency
 * tick one-shot, any jump settles instantly (`.settled`), and reduced-motion
 * renders the fold-derived static tick (CSS, scratchpad-rail.css).
 *
 * Bridges (both directions, always scoped to the chat column's own scroll —
 * never the page):
 *   rail row → frame  — click seeks the producing Δ frame (`data-skey` /
 *     `data-minted` / `data-drop-seq` stamps from parts.tsx); with the density
 *     toggle at Off it first bubbles `chat:reveal-state-frames` (ChatPage
 *     flips the toggle inside flushSync) — it never seeks to nothing.
 *   frame `.d-key` → rail row — ChatPage bridges the bubbled `chat:seek-rail`
 *     into the `seekKey` prop; the rail scrolls to + flashes the row.
 *   [#N] hover in chat → cross-highlight — an open ledger highlights the row;
 *     a collapsed one overlays the peek line on the hero (zero reflow).
 */
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type EventLike, persistedToEventLike } from "../graph/trace-from-events";
import { fetchRunEvents } from "../lib/runsApi";
import {
  type EvidenceEntry,
  type InventorySnapshot,
  type PackSnapshot,
  type RailSection,
  type SlotSnapshot,
  type StageSnapshot,
  foldInventory,
} from "./fold-inventory";
import { seekStateFrame } from "./parts";
import "./scratchpad-rail.css";

export type ScratchpadRailSource =
  | { kind: "live"; events: EventLike[]; streaming: boolean }
  | { kind: "replay"; runId: string | null };

/** A `.d-key` reverse-seek request bridged by ChatPage (`chat:seek-rail`). */
export interface RailSeekRequest {
  key: string;
  nonce: number;
}

/** Ledger rows shown before the "N excluded · show" overflow control. */
const LEDGER_FOLD = 12;
/** Past this many rows an expanded ledger scrolls inside its own 40vh box. */
const LEDGER_TALL = 24;

const HEADER_TITLE =
  "The run's scratchpad — shared working state every stage reads and writes. " +
  "The chat shows the writes (Δ); this shows what they left behind. " +
  "Not user memory: it lives and dies with the run.";
const EVIDENCE_TITLE =
  "Backpacks — deduped evidence pools tools add results to (the API verb is drop, as in: " +
  "drop into the bag — nothing here is ever discarded). The model gets back [#N] handles; " +
  "the data lives here.";
const STAGES_TITLE =
  "When a stage finishes, the framework saves its output under agents.<stage> " +
  "so later stages can have it injected into their prompts.";
const KEPT_TITLE =
  "Named values agent code explicitly kept (onEmit / fn writes) to pass forward. " +
  "Appears only once something is written.";

const count = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
const escAttr = (s: string): string => s.replace(/["\\]/g, "\\$&");

function flashEl(el: HTMLElement): void {
  el.classList.remove("flash");
  void el.offsetWidth;
  el.classList.add("flash");
}

export function ScratchpadRail({
  source,
  cursor,
  chatRoot,
  seekKey,
}: {
  source: ScratchpadRailSource;
  /** Scrub cursor (events folded); omitted = the live edge. */
  cursor?: number;
  /** The chat column element — frame seek root + density-reveal target. */
  chatRoot?: React.RefObject<HTMLElement | null>;
  /** Reverse-seek request from a Δ frame's `.d-key` click. */
  seekKey?: RailSeekRequest | null;
}) {
  const railRef = useRef<HTMLElement>(null);

  // ── replay feed (mirrors TraceRail: one fold, two feeds) ─────────────────
  const [replayEvents, setReplayEvents] = useState<EventLike[] | null>(null);
  const [replayError, setReplayError] = useState<string | null>(null);
  const [replayLoading, setReplayLoading] = useState(false);
  const replayRunId = source.kind === "replay" ? source.runId : null;
  useEffect(() => {
    if (source.kind !== "replay" || !replayRunId) {
      setReplayEvents(null);
      setReplayError(null);
      setReplayLoading(false);
      return;
    }
    let cancelled = false;
    setReplayLoading(true);
    setReplayError(null);
    fetchRunEvents(replayRunId)
      .then((res) => {
        if (cancelled) return;
        if (res.kind === "unconfigured") {
          setReplayError("run history is not configured on this server");
          setReplayEvents(null);
          return;
        }
        if (res.kind === "not-found") {
          setReplayError("this run's events are no longer available");
          setReplayEvents(null);
          return;
        }
        setReplayEvents(res.data.events.map(persistedToEventLike));
      })
      .catch((e) => {
        if (!cancelled) setReplayError(e instanceof Error ? e.message : "Failed to load events");
      })
      .finally(() => {
        if (!cancelled) setReplayLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [source.kind, replayRunId]);

  const events = source.kind === "live" ? source.events : (replayEvents ?? []);
  const streaming = source.kind === "live" && source.streaming;

  // ── the fold + the RailDelta cursor diff ─────────────────────────────────
  const effCursor = Math.max(0, Math.min(cursor ?? events.length, events.length));
  const snap: InventorySnapshot = useMemo(
    () => foldInventory(events, effCursor),
    [events, effCursor],
  );
  const scrubbed = cursor != null && effCursor < events.length;
  const prevCursorRef = useRef<number | null>(null);
  const oneShot = prevCursorRef.current != null && effCursor === prevCursorRef.current + 1;
  useEffect(() => {
    prevCursorRef.current = effCursor;
  }, [effCursor]);
  const recent = snap.lastWrite;
  const recentClass = (section: RailSection, key: string): string =>
    recent && recent.section === section && recent.key === key
      ? ` recent${oneShot ? "" : " settled"}`
      : "";
  /** Remount the row when a NEW write lands on it so the tick re-animates. */
  const recentKey = (section: RailSection, key: string): string =>
    recent && recent.section === section && recent.key === key ? `@${recent.ordinal}` : "";

  // ── rail-local disclosure ────────────────────────────────────────────────
  const [openLedgers, setOpenLedgers] = useState<ReadonlySet<string>>(new Set());
  const [showAll, setShowAll] = useState<ReadonlySet<string>>(new Set());
  const [stagesOpen, setStagesOpen] = useState(false);
  const [hlIdx, setHlIdx] = useState<string | null>(null);
  const [pop, setPop] = useState<{ key: string; idx: number; top: number } | null>(null);
  const [pinned, setPinned] = useState<{ key: string; idx: number; missing?: boolean } | null>(
    null,
  );
  const popTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (popTimer.current) clearTimeout(popTimer.current);
    },
    [],
  );

  const toggleSet = (set: ReadonlySet<string>, key: string): ReadonlySet<string> => {
    const next = new Set(set);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  };

  // ── rail row → producing frame (chat-scroll scoped, density-honest) ──────
  const seekSelector = useCallback(
    (selector: string): boolean => {
      const root = chatRoot?.current;
      if (!root) return false;
      if (root.getAttribute("data-density") === "off") {
        // Honestly re-reveal at Writes before seeking — never seek to nothing.
        // ChatPage's listener commits the flip inside flushSync, so the frames
        // are visible again before dispatchEvent returns.
        root.dispatchEvent(new CustomEvent("chat:reveal-state-frames", { bubbles: true }));
      }
      const matches = root.querySelectorAll<HTMLElement>(selector);
      const frame = matches[matches.length - 1]; // the CURRENT turn's frame
      if (!frame) return false;
      seekStateFrame(root.querySelector(".chat-root") ?? root, frame);
      return true;
    },
    [chatRoot],
  );

  const jumpToWrite = useCallback(
    (packKey: string, index: number): boolean =>
      seekSelector(`[data-skey="${escAttr(packKey)}"][data-minted~="${index}"]`) ||
      seekSelector(`[data-skey="${escAttr(packKey)}"]`),
    [seekSelector],
  );

  /** Flash EVERY frame that touched the identity, then seek the minting one. */
  const lightLineage = useCallback(
    (packKey: string, index: number): void => {
      const root = chatRoot?.current;
      if (!root) return;
      for (const f of root.querySelectorAll<HTMLElement>(`[data-minted~="${index}"]`)) {
        if (f instanceof HTMLDetailsElement) f.open = true;
        flashEl(f);
      }
      jumpToWrite(packKey, index);
    },
    [chatRoot, jumpToWrite],
  );

  // ── frame `.d-key` → rail row (the reverse seek, bridged by ChatPage) ────
  useEffect(() => {
    if (!seekKey) return;
    const root = railRef.current;
    if (!root) return;
    const target = root.querySelector<HTMLElement>(`[data-key="${escAttr(seekKey.key)}"]`);
    if (!target) return;
    if (target.closest(".stage-rows")) setStagesOpen(true);
    const body = root.querySelector<HTMLElement>(".rail-body");
    if (body && typeof body.scrollTo === "function" && body.scrollHeight > body.clientHeight) {
      const br = body.getBoundingClientRect();
      const tr = target.getBoundingClientRect();
      body.scrollTo({
        top: body.scrollTop + (tr.top - br.top) - body.clientHeight / 2,
        behavior: "smooth",
      });
    }
    flashEl(target);
  }, [seekKey]);

  // ── [#N] hover in chat → cross-highlight / peek (delegated) ──────────────
  useEffect(() => {
    const root = chatRoot?.current;
    if (!root) return;
    const sel = ".cite, .d-row[data-idx]";
    const over = (ev: Event) => {
      const t = ev.target;
      const el = t instanceof Element ? t.closest<HTMLElement>(sel) : null;
      if (el) setHlIdx(el.getAttribute("data-idx"));
    };
    const out = (ev: Event) => {
      const t = ev.target;
      if (t instanceof Element && t.closest(sel)) setHlIdx(null);
    };
    root.addEventListener("mouseover", over);
    root.addEventListener("mouseout", out);
    // Keyboard parity (the mockup wires focus/blur too): focusin/out bubble.
    root.addEventListener("focusin", over);
    root.addEventListener("focusout", out);
    return () => {
      root.removeEventListener("mouseover", over);
      root.removeEventListener("mouseout", out);
      root.removeEventListener("focusin", over);
      root.removeEventListener("focusout", out);
    };
  }, [chatRoot]);

  // ── evidence rows: 500ms hover popover + click-pinned detail ─────────────
  const rowEnter = (packKey: string, index: number) => (ev: React.MouseEvent<HTMLElement>) => {
    if (pinned && pinned.key === packKey && pinned.idx === index) return;
    const row = ev.currentTarget;
    if (popTimer.current) clearTimeout(popTimer.current);
    const top = row.offsetTop + row.offsetHeight;
    popTimer.current = setTimeout(() => setPop({ key: packKey, idx: index, top }), 500);
  };
  const rowLeave = () => {
    if (popTimer.current) clearTimeout(popTimer.current);
    setPop(null);
  };
  const rowClick = (packKey: string, index: number) => () => {
    if (popTimer.current) clearTimeout(popTimer.current);
    setPop(null);
    setPinned((cur) =>
      cur && cur.key === packKey && cur.idx === index ? null : { key: packKey, idx: index },
    );
  };

  // ── render ───────────────────────────────────────────────────────────────
  const showBody = !(source.kind === "replay" && (!source.runId || replayLoading || replayError));

  return (
    <aside className={`scratchpad-rail${scrubbed ? " scrubbed" : ""}`} ref={railRef}>
      <div className="rail-head" title={HEADER_TITLE}>
        <span className="t">Scratchpad</span>
        <span className="sub">· what this run carries between stages</span>
        {scrubbed ? (
          <span className="asof">
            as of step {effCursor}/{events.length}
          </span>
        ) : streaming ? (
          <span className="live-dot">
            <i />
            live
          </span>
        ) : null}
      </div>

      <div className="rail-body">
        {source.kind === "replay" && !source.runId && (
          <div className="rail-hint">
            No run linked to this exchange — this turn predates run persistence, or the framework
            didn't capture one.
          </div>
        )}
        {replayLoading && <div className="rail-hint">Loading scratchpad…</div>}
        {replayError && <div className="rail-error">{replayError}</div>}

        {showBody && snap.empty && (
          <>
            <div className="rail-teach">
              What this run carries between stages.
              <br />
              Every row is written by a Δ frame in the timeline — click a row to jump to its write.
            </div>
            <div className="rail-teach-caps">
              <div className="rail-cap">
                Evidence <span className="attr">packs fill as tools add results</span>
              </div>
              <div className="rail-cap">
                Stage outputs <span className="attr">saved when each stage finishes</span>
              </div>
              <div className="rail-cap">
                Kept values <span className="attr">appears when agent code keeps one</span>
              </div>
            </div>
          </>
        )}

        {showBody && !snap.empty && (
          <>
            {snap.packs.length > 0 && (
              <div>
                <div className="rail-cap" title={EVIDENCE_TITLE}>
                  {snap.packsDisplay?.caption ?? "Gathered"}{" "}
                  <span className="attr">
                    ↳ {snap.packsDisplay?.attribution ?? "added by tools"}
                  </span>
                </div>
                {snap.packs.map((pack, i) => (
                  <PackGroup
                    key={pack.key + recentKey("evidence", pack.key)}
                    pack={pack}
                    ledgerId={`rail-ledger-${i}`}
                    open={openLedgers.has(pack.key)}
                    onToggle={() => setOpenLedgers((s) => toggleSet(s, pack.key))}
                    showAll={showAll.has(pack.key)}
                    onShowAll={() => setShowAll((s) => toggleSet(s, pack.key))}
                    recentClass={recentClass("evidence", pack.key)}
                    hlIdx={hlIdx}
                    pop={pop}
                    pinned={pinned}
                    rowEnter={rowEnter}
                    rowLeave={rowLeave}
                    rowClick={rowClick}
                    onSeek={() => seekSelector(`[data-skey="${escAttr(pack.key)}"]`)}
                    onJump={(index) => {
                      const found = jumpToWrite(pack.key, index);
                      if (!found) setPinned({ key: pack.key, idx: index, missing: true });
                    }}
                    onLineage={(index) => lightLineage(pack.key, index)}
                    onUnpin={() => setPinned(null)}
                  />
                ))}
              </div>
            )}

            {snap.stages.length > 0 && (
              <div>
                <div className="rail-cap" title={STAGES_TITLE}>
                  Stage outputs <span className="attr">↳ saved by the framework</span>
                </div>
                <StageGroup
                  stages={snap.stages}
                  savedCount={snap.savedCount}
                  open={stagesOpen}
                  onToggle={() => setStagesOpen((v) => !v)}
                  recentClass={recentClass("stages", recent?.key ?? "")}
                  recentAnimKey={
                    recent?.section === "stages" ? recentKey("stages", recent.key) : ""
                  }
                  onSeekStage={(name) => seekSelector(`[data-skey="agents.${escAttr(name)}"]`)}
                />
              </div>
            )}

            {snap.slots.length > 0 && (
              <div>
                <div className="rail-cap" title={KEPT_TITLE}>
                  Kept values · {snap.slots.length}{" "}
                  <span className="attr">↳ written by agent code</span>
                </div>
                {snap.slots.map((slot) => (
                  <SlotRow
                    key={slot.key + recentKey("kept", slot.key)}
                    slot={slot}
                    recentClass={recentClass("kept", slot.key)}
                    onSeek={() => seekSelector(`[data-skey="${escAttr(slot.key)}"]`)}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {showBody && !snap.empty && (
        <Footer
          snap={snap}
          streaming={streaming}
          derived={source.kind === "replay"}
          onSeekMismatch={() => {
            const m = snap.health.mismatch;
            if (!m) return;
            if (!seekSelector(`[data-skey="${escAttr(m.key)}"][data-drop-seq="${m.recordSeq}"]`))
              seekSelector(`[data-skey="${escAttr(m.key)}"]`);
          }}
        />
      )}
    </aside>
  );
}

/* ── evidence pack: hero row + collapsible ledger ───────────────────────────*/

function heroSub(pack: PackSnapshot): string {
  const segs = [count(pack.records.length, "drop")];
  if (pack.merged > 0) segs.push(`${pack.merged} merged`);
  if (pack.skipped > 0) segs.push(`${pack.skipped} skipped`);
  return segs.join(" · ");
}

function manifestTitle(pack: PackSnapshot): string {
  return pack.records
    .map(
      (r) =>
        `${r.kind === "absorb" ? "absorb" : "drop"} #${r.seq}${r.via ? ` · ↳ ${r.via}` : ""}${
          r.tag ? ` · ${r.tag}` : ""
        } · ${r.covered} covered`,
    )
    .join(" / ");
}

function PackGroup({
  pack,
  ledgerId,
  open,
  onToggle,
  showAll,
  onShowAll,
  recentClass,
  hlIdx,
  pop,
  pinned,
  rowEnter,
  rowLeave,
  rowClick,
  onSeek,
  onJump,
  onLineage,
  onUnpin,
}: {
  pack: PackSnapshot;
  ledgerId: string;
  open: boolean;
  onToggle: () => void;
  showAll: boolean;
  onShowAll: () => void;
  recentClass: string;
  hlIdx: string | null;
  pop: { key: string; idx: number; top: number } | null;
  pinned: { key: string; idx: number; missing?: boolean } | null;
  rowEnter: (key: string, index: number) => (ev: React.MouseEvent<HTMLElement>) => void;
  rowLeave: () => void;
  rowClick: (key: string, index: number) => () => void;
  onSeek: () => void;
  onJump: (index: number) => void;
  onLineage: (index: number) => void;
  onUnpin: () => void;
}) {
  const dot = pack.key.indexOf(".");
  const ns = dot >= 0 ? pack.key.slice(0, dot + 1) : "";
  const rest = dot >= 0 ? pack.key.slice(dot + 1) : pack.key;
  const entries = showAll ? pack.entries : pack.entries.slice(0, LEDGER_FOLD);
  const excluded = pack.entries.length - entries.length;
  const peekEntry =
    !open && hlIdx != null ? pack.entries.find((e) => String(e.index) === hlIdx) : undefined;
  return (
    <>
      <div className={`hero${recentClass}${peekEntry ? " peeking" : ""}`} data-key={pack.key}>
        <button
          type="button"
          className="chev"
          aria-expanded={open}
          aria-controls={ledgerId}
          aria-label={`toggle ${pack.key} ledger`}
          onClick={onToggle}
        >
          ▶
        </button>
        <button type="button" className="hero-main" title={manifestTitle(pack)} onClick={onSeek}>
          <span className="hero-key">
            <span className="k">
              {ns && <span className="ns">{ns}</span>}
              {rest}
            </span>
            <span className="s">{heroSub(pack)}</span>
          </span>
          <span className="hero-n">{pack.size}</span>
        </button>
        {peekEntry && (
          <div className="peek">
            [#{peekEntry.index}] {peekEntry.preview ?? "(not previewed)"}
          </div>
        )}
      </div>
      <div
        className={`idx-list${showAll && pack.entries.length > LEDGER_TALL ? " tall" : ""}`}
        id={ledgerId}
        hidden={!open}
      >
        {entries.map((entry) => {
          const isPinned = pinned?.key === pack.key && pinned.idx === entry.index;
          return (
            <Fragment key={entry.index}>
              <button
                type="button"
                className={`idx-row${String(entry.index) === hlIdx ? " hl" : ""}${
                  isPinned ? " pinned-row" : ""
                }`}
                data-idx={entry.index}
                onMouseEnter={rowEnter(pack.key, entry.index)}
                onMouseLeave={rowLeave}
                onClick={rowClick(pack.key, entry.index)}
              >
                <span className="hnd">[#{entry.index}]</span>
                <span className="l">{entry.preview ?? "(not previewed)"}</span>
              </button>
              {isPinned && (
                <ProvCard
                  entry={entry}
                  pinned
                  missing={pinned?.missing}
                  onJump={() => onJump(entry.index)}
                  onLineage={() => onLineage(entry.index)}
                  onClose={onUnpin}
                />
              )}
            </Fragment>
          );
        })}
        {excluded > 0 && (
          <button type="button" className="idx-more" onClick={onShowAll}>
            {excluded} excluded · show
          </button>
        )}
        {pop && pop.key === pack.key && pinned?.idx !== pop.idx && (
          <PopoverFor pack={pack} pop={pop} />
        )}
      </div>
    </>
  );
}

function PopoverFor({
  pack,
  pop,
}: {
  pack: PackSnapshot;
  pop: { key: string; idx: number; top: number };
}) {
  const entry = pack.entries.find((e) => e.index === pop.idx);
  if (!entry) return null;
  return <ProvCard entry={entry} top={pop.top} />;
}

/** Provenance card — pure projection of the fold (DropReceipt-derived); the
 *  runtime doesn't wire identity/backing/cut status, so only what the receipts
 *  actually carry is shown (nothing fabricated). One component, two
 *  placements: hover popover (transient) / click-pinned in-flow detail. */
function ProvCard({
  entry,
  pinned = false,
  missing = false,
  top,
  onJump,
  onLineage,
  onClose,
}: {
  entry: EvidenceEntry;
  pinned?: boolean;
  missing?: boolean;
  top?: number;
  onJump?: () => void;
  onLineage?: () => void;
  onClose?: () => void;
}) {
  return (
    <div
      className={`prov ${pinned ? "pinned" : "pop"}`}
      style={top != null ? { top } : undefined}
      role={pinned ? "group" : "tooltip"}
    >
      <div className="p-head">
        <span className="hnd">[#{entry.index}]</span>
        <span>{entry.preview ?? "(not previewed)"}</span>
      </div>
      <div className="p-row">
        <span className="pl">minted</span>
        <span className="pv">
          drop #{entry.mintedDrop}
          {entry.mintedVia ? ` · ↳ ${entry.mintedVia}` : ""}
        </span>
      </div>
      {entry.mintedTag && (
        <div className="p-row">
          <span className="pl">tags</span>
          <span className="pv">{entry.mintedTag}</span>
        </div>
      )}
      {entry.merges.length > 0 && (
        <div className="p-row">
          <span className="pl">merged</span>
          <span className="pv">{entry.merges.join(" / ")}</span>
        </div>
      )}
      {pinned ? (
        <>
          <div className="p-acts">
            <button type="button" className="txt-btn" onClick={onJump}>
              ↗ jump to write
            </button>
            <button type="button" className="txt-btn" onClick={onLineage}>
              ✳ light lineage
            </button>
            <button type="button" className="txt-btn close" onClick={onClose}>
              close
            </button>
          </div>
          {missing && <div className="p-note">write not in this transcript</div>}
        </>
      ) : (
        <div className="p-note">click to pin · jump to write · light lineage</div>
      )}
    </div>
  );
}

/* ── stages: ONE hero row (chain + ticks + fraction), rows behind chevron ───*/

function StageGroup({
  stages,
  savedCount,
  open,
  onToggle,
  recentClass,
  recentAnimKey,
  onSeekStage,
}: {
  stages: StageSnapshot[];
  savedCount: number;
  open: boolean;
  onToggle: () => void;
  recentClass: string;
  recentAnimKey: string;
  onSeekStage: (name: string) => void;
}) {
  const lastSaved = [...stages].reverse().find((s) => s.saved);
  return (
    <>
      <div className={`hero${recentClass}`} key={`stage-hero${recentAnimKey}`}>
        <button
          type="button"
          className="chev"
          aria-expanded={open}
          aria-controls="rail-stage-rows"
          aria-label="toggle stage rows"
          onClick={onToggle}
        >
          ▶
        </button>
        <button
          type="button"
          className="hero-main"
          onClick={() => lastSaved && onSeekStage(lastSaved.name)}
        >
          <span className="hero-key">
            <span className="k chain">
              {stages.map((s, i) => (
                <Fragment key={s.name}>
                  {i > 0 && <span className="sep"> → </span>}
                  <span
                    className={
                      s.status === "failed" ? "fail" : s.status === "current" ? "cur" : "done"
                    }
                  >
                    {s.name}
                  </span>
                </Fragment>
              ))}
            </span>
          </span>
          <span className="ticks">
            {stages.map((s) => (
              <i
                key={s.name}
                className={s.status === "failed" ? "fail" : s.saved ? "set" : "pend"}
                title={`${s.name} · ${
                  s.status === "failed" ? "failed" : s.saved ? "set" : "pending"
                }`}
              />
            ))}
          </span>
          <span className="frac">
            {savedCount}/{stages.length}
          </span>{" "}
          <span className="saved-sfx">saved</span>
        </button>
      </div>
      <div className="stage-rows" id="rail-stage-rows" hidden={!open}>
        <div className="srow-head">
          <span
            className="innate-chip"
            title="innate — written by the framework, not by agent code"
          >
            auto
          </span>
        </div>
        {stages.map((s) =>
          s.saved ? (
            <button
              key={s.name}
              type="button"
              className="srow"
              data-key={`agents.${s.name}`}
              onClick={() => onSeekStage(s.name)}
            >
              agents.{s.name} <span className="st">✓ set</span>
              {s.promptRead && <span className="sfx">→ prompt</span>}
            </button>
          ) : (
            <div key={s.name} className="srow pending" data-key={`agents.${s.name}`}>
              agents.{s.name} <span className="st">pending</span>
            </div>
          ),
        )}
      </div>
    </>
  );
}

/* ── kept values: quiet slot rows ───────────────────────────────────────────*/

function SlotRow({
  slot,
  recentClass,
  onSeek,
}: {
  slot: SlotSnapshot;
  recentClass: string;
  onSeek: () => void;
}) {
  return (
    <button
      type="button"
      className={`slot-row${recentClass}`}
      data-key={slot.key}
      title={`slot ${slot.key} · ${slot.writeOp} — click to jump to the write`}
      onClick={onSeek}
    >
      <span className="k">{slot.key}</span>
      <span className="v">{slot.value}</span>
    </button>
  );
}

/* ── health footer — receipt language; mismatch is the only loud state ──────*/

function Footer({
  snap,
  streaming,
  derived,
  onSeekMismatch,
}: {
  snap: InventorySnapshot;
  streaming: boolean;
  derived: boolean;
  onSeekMismatch: () => void;
}) {
  const m = snap.health.mismatch;
  if (m) {
    return (
      <button
        type="button"
        className="rail-foot mismatch"
        title="click seeks the earliest frame after the divergence"
        onClick={onSeekMismatch}
      >
        <span>
          ⚠ receipts disagree — receipts say {m.expected}, scratchpad shows {m.actual}
        </span>
      </button>
    );
  }
  const covered = snap.packs.reduce((n, p) => n + p.records.reduce((c, r) => c + r.covered, 0), 0);
  const skipped = snap.packs.reduce((n, p) => n + p.skipped, 0);
  return (
    <div
      className="rail-foot"
      title={`manifest: ${count(snap.dropReceipts, "record")} · ${covered} covered · ${skipped} skipped — every drop receipt reconciles with what's shown`}
    >
      {streaming ? (
        <span>reconciling — run in progress</span>
      ) : (
        <span>✓ matches all write receipts</span>
      )}
      {(derived || snap.dropReceipts > 0) && (
        <span>rebuilt from {count(snap.dropReceipts, "drop receipt")}</span>
      )}
    </div>
  );
}

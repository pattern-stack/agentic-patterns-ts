/**
 * Capture-from-session — "Add current conversation as an eval case" (#140,
 * E5d). Mounted on `ChatPage`'s `Header` (Decision 1 of the spec: the live
 * `conversationId` only exists there — the Drizzle-flavored
 * `ConversationDetailPage` is dormant in this server, see the spec's fact 1).
 *
 * Button-expands-a-form-Card (the `RunLauncher` idiom). Exchange pairs are
 * derived client-side from `chat.messages` — the Nth `role: "user"` message
 * paired with its following assistant message's concatenated text parts —
 * purely for the picker + the expected-textarea seed; the server is the
 * source of truth for `input` (always `exchange.user`, never client-sent).
 *
 * Lean by intent (spec): no case-browser embed, no tag editor, no input
 * editing — just set / split / expected, and a confirmation linking to /eval.
 *
 * Pages don't share code (the `EvalRunsPage`/`RunLauncher` precedent) — the
 * small style helpers below are a deliberate local duplicate of RunLauncher's.
 */

import { type CSSProperties, type ReactNode, useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { EvalSplit } from "../../api/types";
import type { ChatMessage, Part } from "../../chat";
import { Button } from "../../components/atoms/Button";
import { Card } from "../../components/atoms/Card";
import {
  type CaptureFromSessionResponse,
  captureFromSession,
  fetchEvalSets,
} from "../../lib/evalApi";

export interface CaptureCasePanelProps {
  conversationId: string | null;
  messages: ChatMessage[];
  streaming: boolean;
}

interface ExchangePair {
  /** 1-based — matches the server `Exchange.number` (one user+assistant pair per `send()` call). */
  number: number;
  user: string;
  assistant: string;
}

type SetsState =
  | { kind: "loading" }
  | { kind: "unconfigured" }
  | { kind: "error"; message: string }
  | { kind: "ok"; sets: Array<{ id: string; caseCount: number }> };

const SPLIT_OPTIONS: EvalSplit[] = ["train", "dev", "test"];
const NEW_SET_VALUE = "__new__";

/** Concatenate a message's text parts (there is normally exactly one). */
function textOf(m: ChatMessage): string {
  return m.parts
    .filter((p): p is Extract<Part, { kind: "text" }> => p.kind === "text")
    .map((p) => p.content)
    .join("");
}

/** The Nth user message paired with its immediately-following assistant message. */
function derivePairs(messages: ChatMessage[]): ExchangePair[] {
  const pairs: ExchangePair[] = [];
  let n = 0;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!m || m.role !== "user") continue;
    n += 1;
    const next = messages[i + 1];
    pairs.push({
      number: n,
      user: textOf(m),
      assistant: next && next.role === "assistant" ? textOf(next) : "",
    });
  }
  return pairs;
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export function CaptureCasePanel({ conversationId, messages, streaming }: CaptureCasePanelProps) {
  const [open, setOpen] = useState(false);
  const pairs = derivePairs(messages);
  const exchangeCount = pairs.length;

  const [exchangeNumber, setExchangeNumber] = useState(1);
  const [expected, setExpected] = useState("");
  const [sets, setSets] = useState<SetsState>({ kind: "loading" });
  const [setId, setSetId] = useState("");
  const [creatingNewSet, setCreatingNewSet] = useState(false);
  const [newSetId, setNewSetId] = useState("");
  const [newSetName, setNewSetName] = useState("");
  const [split, setSplit] = useState<EvalSplit>("train");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | undefined>(undefined);
  const [result, setResult] = useState<CaptureFromSessionResponse | undefined>(undefined);

  const resetForm = useCallback(() => {
    setOpen(false);
    setExchangeNumber(1);
    setExpected("");
    setSetId("");
    setCreatingNewSet(false);
    setNewSetId("");
    setNewSetName("");
    setSplit("train");
    setSubmitError(undefined);
    setResult(undefined);
  }, []);

  // Form state resets when the conversation changes (New Chat / agent switch).
  // resetForm is useCallback([])-stable; conversationId is the intended trigger.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reactive key is conversationId, not resetForm's identity
  useEffect(() => {
    resetForm();
  }, [conversationId]);

  // Fetch the set picker's options once the panel opens.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      setSets({ kind: "loading" });
      try {
        const res = await fetchEvalSets();
        if (cancelled) return;
        setSets(
          res.kind === "unconfigured" ? { kind: "unconfigured" } : { kind: "ok", sets: res.data },
        );
      } catch (e) {
        if (!cancelled) {
          setSets({ kind: "error", message: e instanceof Error ? e.message : String(e) });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  const canCapture = conversationId != null && exchangeCount > 0 && !streaming;

  const handleOpen = () => {
    const pair = pairs[0];
    setExchangeNumber(pair?.number ?? 1);
    setExpected(pair?.assistant ?? "");
    setResult(undefined);
    setSubmitError(undefined);
    setOpen(true);
  };

  const handleExchangeChange = (n: number) => {
    setExchangeNumber(n);
    const pair = pairs.find((p) => p.number === n);
    setExpected(pair?.assistant ?? "");
  };

  const handleSetChange = (value: string) => {
    if (value === NEW_SET_VALUE) {
      setCreatingNewSet(true);
      setSetId("");
    } else {
      setCreatingNewSet(false);
      setSetId(value);
    }
  };

  const handleSubmit = async () => {
    if (!conversationId) return;
    setSubmitError(undefined);
    setSubmitting(true);
    try {
      const targetSetId = creatingNewSet ? newSetId.trim() : setId;
      const res = await captureFromSession({
        conversationId,
        setId: targetSetId,
        exchange: exchangeNumber,
        expected,
        split,
        ...(creatingNewSet ? { createSet: { name: newSetName.trim() || undefined } } : {}),
      });
      if (res.kind === "unconfigured") {
        setSubmitError(
          "Eval persistence is not configured — start `ap playground` with AP_PERSISTENCE != 0.",
        );
        return;
      }
      setResult(res.data);
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  };

  if (!open) {
    return (
      <Button
        variant="ghost"
        size="sm"
        onClick={handleOpen}
        disabled={!canCapture}
        title={
          canCapture
            ? "Capture the current exchange as an eval case"
            : "Send a message first to capture it as an eval case"
        }
      >
        Capture eval case
      </Button>
    );
  }

  const targetSetId = creatingNewSet ? newSetId.trim() : setId;
  const canSubmit = targetSetId.length > 0 && !submitting;

  return (
    <Card style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 340 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ fontSize: 14, fontWeight: 600 }}>Capture eval case</div>
        <Button variant="ghost" size="sm" onClick={resetForm}>
          Close
        </Button>
      </div>

      {result ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, fontSize: 13 }}>
          <div>
            {result.created ? "Created" : "Updated existing case"}{" "}
            <code style={{ fontFamily: "var(--font-mono)" }}>{result.caseId}</code>
          </div>
          <div style={{ color: "var(--fg-muted)" }}>Input: {truncate(result.input, 120)}</div>
          <Link to="/eval" style={{ color: "var(--accent)" }}>
            View in Eval →
          </Link>
        </div>
      ) : (
        <>
          {exchangeCount > 1 && (
            <Field label="Exchange">
              <select
                value={exchangeNumber}
                onChange={(e) => handleExchangeChange(Number(e.target.value))}
                style={selectStyle}
                aria-label="Exchange"
              >
                {pairs.map((p) => (
                  <option key={p.number} value={p.number}>
                    exchange {p.number} — &quot;{truncate(p.user, 48)}&quot;
                  </option>
                ))}
              </select>
            </Field>
          )}

          <Field label="Expected">
            <textarea
              value={expected}
              onChange={(e) => setExpected(e.target.value)}
              rows={4}
              style={{ ...selectStyle, resize: "vertical", fontFamily: "inherit" }}
              aria-label="Expected"
            />
          </Field>

          {sets.kind === "unconfigured" ? (
            <div style={{ fontSize: 13, color: "var(--fg-muted)" }}>
              Eval persistence is not configured — start <code>ap playground</code> with{" "}
              <code>AP_PERSISTENCE != 0</code>.
            </div>
          ) : (
            <>
              <Field label="Set">
                <select
                  value={creatingNewSet ? NEW_SET_VALUE : setId}
                  onChange={(e) => handleSetChange(e.target.value)}
                  style={selectStyle}
                  aria-label="Set"
                >
                  <option value="">Select a set…</option>
                  {sets.kind === "ok" &&
                    sets.sets.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.id} ({s.caseCount})
                      </option>
                    ))}
                  <option value={NEW_SET_VALUE}>+ New set…</option>
                </select>
                {sets.kind === "error" && (
                  <div style={{ fontSize: 12, color: "var(--red)" }}>{sets.message}</div>
                )}
              </Field>

              {creatingNewSet && (
                <>
                  <Field label="New set id">
                    <input
                      value={newSetId}
                      onChange={(e) => setNewSetId(e.target.value)}
                      style={selectStyle}
                      aria-label="New set id"
                      placeholder="e.g. captured-from-chat"
                    />
                  </Field>
                  <Field label="New set name (optional)">
                    <input
                      value={newSetName}
                      onChange={(e) => setNewSetName(e.target.value)}
                      style={selectStyle}
                      aria-label="New set name"
                    />
                  </Field>
                </>
              )}

              <Field label="Split">
                <select
                  value={split}
                  onChange={(e) => setSplit(e.target.value as EvalSplit)}
                  style={selectStyle}
                  aria-label="Split"
                >
                  {SPLIT_OPTIONS.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </Field>

              {submitError && (
                <div style={{ fontSize: 13, color: "var(--red)" }}>{submitError}</div>
              )}

              <Button disabled={!canSubmit} onClick={handleSubmit}>
                {submitting ? "Capturing…" : "Capture"}
              </Button>
            </>
          )}
        </>
      )}
    </Card>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <div
        style={{
          fontSize: 11,
          fontWeight: 600,
          textTransform: "uppercase",
          letterSpacing: "0.05em",
          color: "var(--fg-muted)",
        }}
      >
        {label}
      </div>
      {children}
    </div>
  );
}

const selectStyle: CSSProperties = {
  padding: "6px 10px",
  fontSize: 13,
  fontFamily: "inherit",
  background: "var(--bg-surface)",
  color: "var(--fg-default)",
  border: "1px solid var(--border)",
  borderRadius: 6,
};

/**
 * CaptureCasePanel — "Capture as eval case" affordance mounted on `ChatPage`.
 *
 * Turns the live chat exchange into a `StoredEvalCase` via the already-shipped
 * `evalApi.captureFromSession` (server route + client fn ship separately —
 * this is purely the missing UI, see the #140 follow-on spec). A small state
 * machine: pre-send hint -> collapsed button -> lazily fetched set picker
 * form -> submitting -> outcome (with a "Capture another" reset).
 *
 * The server's `exchange` default is `history[0]` (the FIRST exchange) — this
 * panel always sends `exchange` explicitly, defaulted to the latest
 * (`exchangeCount`), so a plain click-through captures the exchange the
 * operator is actually looking at.
 */

import { useEffect, useRef, useState } from "react";
import type { EvalSetSummary, EvalSplit } from "../api/types";
import { Button } from "../components/atoms/Button";
import { Spinner } from "../components/atoms/Spinner";
import { Field, inputStyle } from "../components/kit/Field";
import { type CaptureFromSessionResponse, captureFromSession, fetchEvalSets } from "../lib/evalApi";
import type { ChatMessage, Part } from "./model";

export interface CaptureCasePanelProps {
  conversationId: string | null;
  messages: ChatMessage[];
  exchangeCount: number;
  disabled?: boolean;
  baseUrl?: string;
}

/** Sentinel select value for the "create a new set" branch. */
const NEW_SET_VALUE = "__new__";

const SPLIT_OPTIONS: readonly EvalSplit[] = ["train", "dev", "test"];

type SetsState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "unconfigured" }
  | { kind: "error"; message: string }
  | { kind: "loaded"; sets: EvalSetSummary[] };

type SubmitState =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "success"; data: CaptureFromSessionResponse }
  | { kind: "unconfigured" }
  | { kind: "error"; message: string };

const textOf = (parts: Part[]): string =>
  parts
    .filter((p): p is Extract<Part, { kind: "text" }> => p.kind === "text")
    .map((p) => p.content)
    .join("");

/** Last assistant message's text parts, concatenated — empty string if none. */
export function latestAssistantText(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === "assistant") return textOf(m.parts);
  }
  return "";
}

/** Short label for the Nth (1-based) user turn — falls back to "Exchange N". */
function exchangeSnippet(messages: ChatMessage[], exchange: number): string {
  const userTurns = messages.filter((m) => m.role === "user");
  const turn = userTurns[exchange - 1];
  const text = turn ? textOf(turn.parts).trim() : "";
  if (!text) return `Exchange ${exchange}`;
  return text.length > 40 ? `${text.slice(0, 40)}…` : text;
}

export function CaptureCasePanel({
  conversationId,
  messages,
  exchangeCount,
  disabled = false,
  baseUrl,
}: CaptureCasePanelProps) {
  const [expanded, setExpanded] = useState(false);
  const [setsState, setSetsState] = useState<SetsState>({ kind: "idle" });
  const [selectedSetId, setSelectedSetId] = useState("");
  const [newSlug, setNewSlug] = useState("");
  const [newName, setNewName] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [exchange, setExchange] = useState(exchangeCount);
  const [split, setSplit] = useState<EvalSplit>("train");
  const [expected, setExpected] = useState("");
  const [submit, setSubmit] = useState<SubmitState>({ kind: "idle" });

  // Keep the exchange picker pinned to the latest turn until the operator
  // deliberately picks an earlier one.
  useEffect(() => {
    setExchange(exchangeCount);
  }, [exchangeCount]);

  // Fetch exactly once per expand (a `setsRequested` ref, not `setsState` in
  // the deps array — the effect itself calls `setSetsState`, so depending on
  // `setsState.kind` would re-fire the effect on its own state transition and
  // the re-run's cleanup would cancel the still in-flight original fetch).
  const setsRequested = useRef(false);
  useEffect(() => {
    if (!expanded || setsRequested.current) return;
    setsRequested.current = true;
    let cancelled = false;
    setSetsState({ kind: "loading" });
    fetchEvalSets({ baseUrl })
      .then((res) => {
        if (cancelled) return;
        setSetsState(
          res.kind === "unconfigured"
            ? { kind: "unconfigured" }
            : { kind: "loaded", sets: res.data },
        );
      })
      .catch((e) => {
        if (!cancelled) {
          setSetsState({ kind: "error", message: e instanceof Error ? e.message : String(e) });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [expanded, baseUrl]);

  if (conversationId == null || exchangeCount === 0) {
    return (
      <div style={{ fontSize: 12, color: "var(--ink-2)" }}>
        Send a message first, then capture it as an eval case.
      </div>
    );
  }

  if (!expanded) {
    return (
      <Button variant="ghost" size="sm" disabled={disabled} onClick={() => setExpanded(true)}>
        Capture as eval case
      </Button>
    );
  }

  const isCreatingNew = selectedSetId === NEW_SET_VALUE;
  const expectedValue = expected || latestAssistantText(messages);
  const isBusy = submit.kind === "submitting";
  const canSubmit =
    !disabled && !isBusy && (isCreatingNew ? newSlug.trim().length > 0 : selectedSetId.length > 0);

  const resetToForm = () => setSubmit({ kind: "idle" });

  const handleCollapse = () => {
    setExpanded(false);
    setSubmit({ kind: "idle" });
  };

  const handleSubmit = async () => {
    setSubmit({ kind: "submitting" });
    try {
      const result = await captureFromSession(
        {
          conversationId,
          setId: isCreatingNew ? newSlug.trim() : selectedSetId,
          exchange,
          expected: expectedValue,
          split,
          ...(isCreatingNew
            ? {
                createSet: {
                  name: newName.trim() || undefined,
                  description: newDescription.trim() || undefined,
                },
              }
            : {}),
        },
        { baseUrl },
      );
      if (result.kind === "unconfigured") {
        setSubmit({ kind: "unconfigured" });
        return;
      }
      setSubmit({ kind: "success", data: result.data });
    } catch (e) {
      setSubmit({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    }
  };

  const showOutcome =
    submit.kind === "success" || submit.kind === "unconfigured" || submit.kind === "error";

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 8,
        padding: 10,
        border: "1px solid var(--line)",
        borderRadius: "var(--radius-lg)",
        background: "var(--paper)",
        maxWidth: 420,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: "var(--ink)" }}>
          Capture as eval case
        </div>
        <Button variant="ghost" size="sm" onClick={handleCollapse}>
          Close
        </Button>
      </div>

      {setsState.kind === "loading" && <Spinner size={14} />}

      {setsState.kind === "unconfigured" && (
        <div style={{ fontSize: 12, color: "var(--ink-2)" }}>
          Eval persistence isn't configured on this server.
        </div>
      )}

      {setsState.kind === "error" && (
        <div style={{ fontSize: 12, color: "var(--err)" }}>{setsState.message}</div>
      )}

      {setsState.kind === "loaded" && showOutcome && (
        <>
          {submit.kind === "success" && (
            <div
              style={{
                fontSize: 12,
                color: submit.data.created ? "var(--accent)" : "var(--ink-2)",
              }}
            >
              {submit.data.created ? "Created new case " : "Updated existing case "}
              <code style={{ fontFamily: "var(--font-mono)" }}>{submit.data.caseId}</code> in{" "}
              <code style={{ fontFamily: "var(--font-mono)" }}>{submit.data.setId}</code> (
              {submit.data.split})
            </div>
          )}
          {submit.kind === "unconfigured" && (
            <div style={{ fontSize: 12, color: "var(--ink-2)" }}>
              Eval persistence isn't configured on this server.
            </div>
          )}
          {submit.kind === "error" && (
            <div style={{ fontSize: 12, color: "var(--err)" }}>{submit.message}</div>
          )}
          <Button variant="ghost" size="sm" onClick={resetToForm}>
            Capture another
          </Button>
        </>
      )}

      {setsState.kind === "loaded" && !showOutcome && (
        <>
          <Field label="Exchange">
            <select
              aria-label="Exchange"
              value={exchange}
              onChange={(e) => setExchange(Number(e.target.value))}
              disabled={disabled || isBusy}
              style={inputStyle}
            >
              {Array.from({ length: exchangeCount }, (_, i) => i + 1).map((n) => (
                <option key={n} value={n}>
                  {n}. {exchangeSnippet(messages, n)}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Set">
            <select
              aria-label="Set"
              value={selectedSetId}
              onChange={(e) => setSelectedSetId(e.target.value)}
              disabled={disabled || isBusy}
              style={inputStyle}
            >
              <option value="">Select a set…</option>
              {setsState.sets.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name ?? s.id} ({s.caseCount})
                </option>
              ))}
              <option value={NEW_SET_VALUE}>➕ Create new set…</option>
            </select>
          </Field>

          {isCreatingNew && (
            <>
              <Field label="Set id (slug)">
                <input
                  aria-label="Set id"
                  value={newSlug}
                  onChange={(e) => setNewSlug(e.target.value)}
                  disabled={disabled || isBusy}
                  style={inputStyle}
                  placeholder="e.g. curator-smoke"
                />
              </Field>
              <Field label="Name (optional)">
                <input
                  aria-label="Set name"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  disabled={disabled || isBusy}
                  style={inputStyle}
                />
              </Field>
              <Field label="Description (optional)">
                <input
                  aria-label="Set description"
                  value={newDescription}
                  onChange={(e) => setNewDescription(e.target.value)}
                  disabled={disabled || isBusy}
                  style={inputStyle}
                />
              </Field>
            </>
          )}

          <Field label="Split">
            <select
              aria-label="Split"
              value={split}
              onChange={(e) => setSplit(e.target.value as EvalSplit)}
              disabled={disabled || isBusy}
              style={inputStyle}
            >
              {SPLIT_OPTIONS.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Expected">
            <textarea
              aria-label="Expected"
              value={expectedValue}
              onChange={(e) => setExpected(e.target.value)}
              disabled={disabled || isBusy}
              rows={4}
              style={{ ...inputStyle, resize: "vertical", fontFamily: "inherit" }}
            />
          </Field>

          <Button size="sm" disabled={!canSubmit} onClick={handleSubmit}>
            {isBusy ? (
              <>
                <Spinner size={12} /> Capturing…
              </>
            ) : (
              "Capture"
            )}
          </Button>
        </>
      )}
    </div>
  );
}

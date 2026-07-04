/**
 * Case banks — file-first, split-disciplined case supply for the eval engine
 * (spec `.ai-docs/stacks/eval-surface/specs/134.md` § Approach steps 3-5).
 *
 * `loadCasesJsonl` / `loadGold` read hand-authored jsonl files into `EvalCase[]`,
 * validating each row *strictly* at the loader boundary (an unknown top-level key
 * is almost certainly a typo, e.g. `"spilt"` — fail loud rather than silently
 * strip it and quietly shrink the bank). The engine's `EvalCaseSchema` stays
 * non-strict/unchanged; strictness here is loader-only.
 *
 * `filterBySplit` / `assertSplitSelectable` are the held-out discipline: selecting
 * the `test` split throws unless the caller opts in explicitly with
 * `{ allowTest: true }` — no env var, no `process.exit` (an argument keeps the
 * primitive embeddable; CLI/env mapping is #135's policy).
 *
 * Loaders are synchronous (`node:fs` `readFileSync`) — they run at harness boot
 * before any async work, which is what keeps the held-out refusal *free* (callable
 * before any client/DB/LLM setup, per the doc's "a validate refusal must be free").
 *
 * ADDITIVE: new file. No changes to `run-eval.ts` — the loaders/filter run before
 * `spec.cases` is handed to the engine.
 */

import { readFileSync } from "node:fs";
import { z } from "zod";
import { type EvalCase, EvalCaseSchema, type EvalSplit } from "./types.js";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Loader failure, addressed to file + line + case id where recoverable. */
export class CaseBankLoadError extends Error {
  readonly name = "CaseBankLoadError";
  readonly path: string;
  readonly line?: number; // 1-based physical line; absent for whole-file failures
  readonly caseId?: string; // absent when the row's id itself is unrecoverable

  constructor(message: string, fields: { path: string; line?: number; caseId?: string }) {
    super(message);
    this.path = fields.path;
    this.line = fields.line;
    this.caseId = fields.caseId;
  }
}

/** Thrown when the held-out `test` split is selected without the explicit opt-in. */
export class HeldOutSplitError extends Error {
  readonly name = "HeldOutSplitError";
}

// ---------------------------------------------------------------------------
// Row schemas (loader-boundary only — strict; the engine schema stays lax)
// ---------------------------------------------------------------------------

/** `{ id, input, expected?, tags?, split? }` — unknown top-level keys are errors. */
const CaseRowSchema = EvalCaseSchema.strict();

/** `{ id, expected }` — both required, no others; presence of `expected` is
 * checked separately (see below) because `z.unknown()` accepts a missing key. */
const GoldRowSchema = z.object({ id: z.string(), expected: z.unknown() }).strict();

// ---------------------------------------------------------------------------
// Internals — line reading + row-level parsing
// ---------------------------------------------------------------------------

interface RawLine {
  readonly line: number; // 1-based physical line number
  readonly text: string;
}

/** Read a file and split into non-blank physical lines, preserving true line numbers. */
function readRawLines(path: string): RawLine[] {
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch (error) {
    throw new CaseBankLoadError(
      `case-bank: cannot read ${path} — ${error instanceof Error ? error.message : String(error)}`,
      { path },
    );
  }

  const physicalLines = content.split("\n");
  const rows: RawLine[] = [];
  for (let i = 0; i < physicalLines.length; i++) {
    const text = physicalLines[i] as string;
    if (text.trim().length === 0) continue; // blank/whitespace-only — skipped but still counted
    rows.push({ line: i + 1, text });
  }
  return rows;
}

/** Extract a string `id` from an unvalidated parsed row, if recoverable. */
function extractRowId(raw: unknown): string | undefined {
  if (raw !== null && typeof raw === "object" && "id" in raw) {
    const id = (raw as { id?: unknown }).id;
    return typeof id === "string" ? id : undefined;
  }
  return undefined;
}

function parseJsonLine(path: string, line: number, text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new CaseBankLoadError(
      `case-bank: ${path}:${line}: invalid JSON — ${error instanceof Error ? error.message : String(error)}`,
      { path, line },
    );
  }
}

function parseCaseRow<TIn, TExpected>(
  path: string,
  line: number,
  text: string,
): EvalCase<TIn, TExpected> {
  const raw = parseJsonLine(path, line, text);

  const parsed = CaseRowSchema.safeParse(raw);
  if (!parsed.success) {
    const caseId = extractRowId(raw);
    const idSegment = caseId !== undefined ? ` (id=${caseId})` : "";
    throw new CaseBankLoadError(
      `case-bank: ${path}:${line}${idSegment}: invalid case — ${parsed.error.message}`,
      { path, line, caseId },
    );
  }
  return parsed.data as EvalCase<TIn, TExpected>;
}

// ---------------------------------------------------------------------------
// loadCasesJsonl
// ---------------------------------------------------------------------------

/**
 * Load a jsonl case bank: one strict EvalCase envelope per line
 * (`{ id, input, expected?, tags?, split? }` — unknown keys are errors).
 * Blank lines skipped; duplicate ids rejected. TIn/TExpected are caller assertions.
 */
export function loadCasesJsonl<TIn = unknown, TExpected = unknown>(
  path: string,
): EvalCase<TIn, TExpected>[] {
  const rows = readRawLines(path);
  const cases: EvalCase<TIn, TExpected>[] = [];
  const firstSeenAtLine = new Map<string, number>();

  for (const { line, text } of rows) {
    const evalCase = parseCaseRow<TIn, TExpected>(path, line, text);

    const firstLine = firstSeenAtLine.get(evalCase.id);
    if (firstLine !== undefined) {
      throw new CaseBankLoadError(
        `case-bank: ${path}:${line} (id=${evalCase.id}): duplicate case id (first at line ${firstLine})`,
        { path, line, caseId: evalCase.id },
      );
    }
    firstSeenAtLine.set(evalCase.id, line);
    cases.push(evalCase);
  }

  return cases;
}

// ---------------------------------------------------------------------------
// loadGold
// ---------------------------------------------------------------------------

/**
 * Load cases + overlay a gold file (`{ id, expected }` per line, both required) by id.
 * Gold wins over inline expected; an unmatched or duplicate gold id is an error;
 * cases without a gold row pass through unchanged.
 */
export function loadGold<TIn = unknown, TExpected = unknown>(
  casesPath: string,
  goldPath: string,
): EvalCase<TIn, TExpected>[] {
  const cases = loadCasesJsonl<TIn, TExpected>(casesPath);
  const caseIds = new Set(cases.map((c) => c.id));

  const goldRows = readRawLines(goldPath);
  const firstSeenAtLine = new Map<string, number>();
  const goldExpectedById = new Map<string, TExpected>();

  for (const { line, text } of goldRows) {
    const raw = parseJsonLine(goldPath, line, text);

    const parsed = GoldRowSchema.safeParse(raw);
    if (!parsed.success) {
      const rowId = extractRowId(raw);
      const idSegment = rowId !== undefined ? ` (id=${rowId})` : "";
      throw new CaseBankLoadError(
        `case-bank: ${goldPath}:${line}${idSegment}: invalid gold row — ${parsed.error.message}`,
        { path: goldPath, line, caseId: rowId },
      );
    }

    const { id } = parsed.data;

    // z.unknown() accepts a MISSING key (it parses as undefined), so schema
    // success alone can't prove `expected` was present — check the raw row.
    if (!Object.hasOwn(raw as object, "expected")) {
      throw new CaseBankLoadError(
        `case-bank: ${goldPath}:${line} (id=${id}): invalid gold row — missing required key "expected"`,
        { path: goldPath, line, caseId: id },
      );
    }

    const firstLine = firstSeenAtLine.get(id);
    if (firstLine !== undefined) {
      throw new CaseBankLoadError(
        `case-bank: ${goldPath}:${line} (id=${id}): duplicate gold id (first at line ${firstLine})`,
        { path: goldPath, line, caseId: id },
      );
    }
    firstSeenAtLine.set(id, line);

    if (!caseIds.has(id)) {
      throw new CaseBankLoadError(
        `case-bank: ${goldPath}:${line} (id=${id}): gold row has no matching case in ${casesPath}`,
        { path: goldPath, line, caseId: id },
      );
    }

    goldExpectedById.set(id, parsed.data.expected as TExpected);
  }

  return cases.map((c) =>
    goldExpectedById.has(c.id) ? { ...c, expected: goldExpectedById.get(c.id) } : c,
  );
}

// ---------------------------------------------------------------------------
// Split filter + held-out guard
// ---------------------------------------------------------------------------

export interface SplitSelectOptions {
  /** Explicit opt-in for the held-out `test` split. Mapping a CLI flag/env var here is #135's policy. */
  readonly allowTest?: boolean;
}

const HELD_OUT_MESSAGE =
  'case-bank: refusing the held-out "test" split — touch once, pre-ship only. Pass { allowTest: true } to run it deliberately.';

/** Throws HeldOutSplitError iff split === "test" without { allowTest: true }. Free — call before any loading. */
export function assertSplitSelectable(split: EvalSplit, opts?: SplitSelectOptions): void {
  if (split === "test" && opts?.allowTest !== true) {
    throw new HeldOutSplitError(HELD_OUT_MESSAGE);
  }
}

/** assertSplitSelectable, then cases with EXACTLY the given split (untagged cases excluded). */
export function filterBySplit<TIn, TExpected = unknown>(
  cases: readonly EvalCase<TIn, TExpected>[],
  split: EvalSplit,
  opts?: SplitSelectOptions,
): EvalCase<TIn, TExpected>[] {
  assertSplitSelectable(split, opts);
  return cases.filter((c) => c.split === split);
}

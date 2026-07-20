/**
 * Slice-3 seed invariants: family identity on sets/runs, composite case-id
 * discipline (the INSERT OR REPLACE collapse hazard), cross-referential
 * integrity between the sdc run's judge verdicts and the bundle's gold
 * expectations, curation's sourceSetId back-link, idempotent re-seeding, and
 * the meta.summary-vs-rows consistency invariant the contract's risk section
 * warns about (`packages/agent-dashboard/docs/eval-family-contract.md`).
 */

import { EvalStore } from "@agentic-patterns/runtime";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BANK_SET_ID,
  BUNDLE_SET_ID,
  CURATION_RUN_ID,
  RENDERER_RUN_ID,
  SDC_RUN_ID,
  seedEvalFamilies,
} from "../seed-eval-families.js";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** Gold expectation ids for one bundle fixture, read back from the store. */
function goldExpectationIds(store: EvalStore, fixtureId: string): Set<string> {
  const row = store.listEvalCases(BUNDLE_SET_ID).find((c) => c.caseId === fixtureId);
  expect(row, `bundle case ${fixtureId} exists`).toBeDefined();
  const expected = row?.expected;
  if (!isRecord(expected) || !isRecord(expected.ground_truth)) {
    throw new Error(`bundle case ${fixtureId}: expected.ground_truth missing`);
  }
  const expectations = expected.ground_truth.expectations;
  if (!Array.isArray(expectations)) {
    throw new Error(`bundle case ${fixtureId}: expectations missing`);
  }
  const ids = new Set<string>();
  for (const e of expectations) {
    if (isRecord(e) && typeof e.id === "string") ids.add(e.id);
  }
  return ids;
}

let store: EvalStore;

beforeEach(() => {
  store = new EvalStore({ path: ":memory:", Database });
  seedEvalFamilies(store);
});

afterEach(() => {
  store.close();
});

describe("seedEvalFamilies", () => {
  it("writes both family sets with family meta and full case banks", () => {
    const sets = store.listEvalSets();
    const bank = sets.find((s) => s.id === BANK_SET_ID);
    const bundle = sets.find((s) => s.id === BUNDLE_SET_ID);

    expect(bank?.meta).toEqual({ family: "answer-bank" });
    expect(bank?.caseCount).toBe(6);

    expect(bundle?.meta).toMatchObject({
      family: "question-bundle",
      source: "cache",
      benchmark: "sdc-bench",
      version: "v2",
    });
    expect(bundle?.caseCount).toBe(6);
  });

  it("writes one terminal run per family with the right meta.family", () => {
    const expected: Record<string, string> = {
      [RENDERER_RUN_ID]: "renderer",
      [SDC_RUN_ID]: "sdc",
      [CURATION_RUN_ID]: "curation",
    };
    for (const [runId, family] of Object.entries(expected)) {
      const run = store.getEvalRun(runId);
      expect(run, runId).not.toBeNull();
      expect(run?.status).toBe("ok");
      expect(run?.meta?.family).toBe(family);
    }
  });

  it("renderer uses composite <fid>#<variantKey> ids with >1 result per fid", () => {
    const results = store.evalRunResults(RENDERER_RUN_ID);
    expect(results).toHaveLength(12);

    const perFid = new Map<string, number>();
    for (const r of results) {
      expect(r.caseId).toMatch(/^fid-\d{3}#[a-z-]+$/);
      const fid = r.caseId.split("#")[0] ?? "";
      perFid.set(fid, (perFid.get(fid) ?? 0) + 1);
    }
    // The INSERT OR REPLACE hazard: without composite ids these would
    // collapse to one row per fid.
    expect(perFid.size).toBe(4);
    for (const [fid, n] of perFid) {
      expect(n, `results for ${fid}`).toBeGreaterThan(1);
    }
  });

  it("sdc judge verdicts reference only the bundle case's gold expectation ids", () => {
    const results = store.evalRunResults(SDC_RUN_ID);
    expect(results).toHaveLength(5);

    for (const r of results) {
      const gold = goldExpectationIds(store, r.caseId);
      const verdictScore = (r.scores ?? []).find(
        (s) => isRecord(s.detail) && s.detail.kind === "judge-verdicts",
      );
      expect(verdictScore, `judge-verdicts score on ${r.caseId}`).toBeDefined();
      const verdicts = isRecord(verdictScore?.detail) ? verdictScore.detail.verdicts : null;
      expect(Array.isArray(verdicts)).toBe(true);
      expect((verdicts as unknown[]).length).toBeGreaterThan(0);
      for (const v of verdicts as unknown[]) {
        expect(isRecord(v)).toBe(true);
        const id = isRecord(v) ? v.expectationId : null;
        expect(typeof id).toBe("string");
        expect(gold.has(id as string), `${r.caseId} verdict ${String(id)}`).toBe(true);
      }
    }
  });

  it("curation composite ids + meta.curation.sourceSetId back-link the bundle", () => {
    const results = store.evalRunResults(CURATION_RUN_ID);
    expect(results).toHaveLength(12);
    for (const r of results) {
      expect(r.caseId).toMatch(/^cfg-[a-z]+#fx-\d{3}$/);
    }

    const run = store.getEvalRun(CURATION_RUN_ID);
    const curation = run?.meta?.curation;
    expect(isRecord(curation)).toBe(true);
    expect((curation as Record<string, unknown>).sourceSetId).toBe(BUNDLE_SET_ID);
  });

  it("re-seeding is idempotent (counts unchanged)", () => {
    const counts = () => ({
      sets: store.listEvalSets().length,
      bankCases: store.listEvalCases(BANK_SET_ID).length,
      bundleCases: store.listEvalCases(BUNDLE_SET_ID).length,
      runs: store.listEvalRuns().length,
      renderer: store.evalRunResults(RENDERER_RUN_ID).length,
      sdc: store.evalRunResults(SDC_RUN_ID).length,
      curation: store.evalRunResults(CURATION_RUN_ID).length,
    });

    const before = counts();
    seedEvalFamilies(store);
    expect(counts()).toEqual(before);
    // Family identity survives the re-upsert (the meta_json-rewrite hazard).
    expect(store.listEvalSets().find((s) => s.id === BANK_SET_ID)?.meta).toEqual({
      family: "answer-bank",
    });
  });

  it("renderer meta.summary.detPassRate matches the recomputed rate from its rows", () => {
    const run = store.getEvalRun(RENDERER_RUN_ID);
    const summary = run?.meta?.summary;
    expect(isRecord(summary)).toBe(true);
    const declared = (summary as Record<string, unknown>).detPassRate;
    expect(typeof declared).toBe("number");

    const results = store.evalRunResults(RENDERER_RUN_ID);
    const gated = results.filter((r) => r.pass !== null);
    const recomputed = gated.filter((r) => r.pass === true).length / gated.length;
    expect(declared as number).toBeCloseTo(recomputed, 4);
  });
});

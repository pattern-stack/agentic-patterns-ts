/**
 * Detail-renderer registry seam. Proves: (1) a registered `kind` renders its
 * structured payload, (2) failing gates surface their tokens, (3) an unknown
 * kind or malformed payload resolves to no renderer (caller keeps its fallback).
 */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { detailKind, resolveDetailRenderer } from "../pages/eval/renderers";
import { RenderGradeDetail } from "../pages/eval/renderers/RenderGradeDetail";

afterEach(cleanup);

const passingReport = {
  kind: "render-grade",
  report: {
    inventedIds: { pass: true, inventedIds: [] },
    droppedIds: { pass: true, droppedIds: [], declared: true, dropRatio: 0 },
    inventedDates: { pass: true, invented: [] },
    inventedMoney: { pass: true, invented: [] },
    coverageHonesty: { status: "honest", pass: true, actualCarried: 5, actualTotal: 5 },
    tableIntegrity: { pass: true, strayPipeLines: [], unbalancedRowLines: [] },
    relativeLength: { stateWords: 100, renderedWords: 90, ratio: 0.9 },
    pass: true,
  },
};

describe("resolveDetailRenderer", () => {
  it("resolves a registered kind and returns null for unknown/absent", () => {
    expect(resolveDetailRenderer(passingReport)).toBeTypeOf("function");
    expect(resolveDetailRenderer({ kind: "not-registered", x: 1 })).toBeNull();
    expect(resolveDetailRenderer({ noKind: true })).toBeNull();
    expect(resolveDetailRenderer(undefined)).toBeNull();
  });

  it("detailKind reads the discriminant defensively", () => {
    expect(detailKind(passingReport)).toBe("render-grade");
    expect(detailKind({ kind: "" })).toBeNull();
    expect(detailKind({ kind: 3 as unknown as string })).toBeNull();
    expect(detailKind(undefined)).toBeNull();
  });
});

describe("RenderGradeDetail", () => {
  it("renders a chip per gate plus the length readout", () => {
    render(<RenderGradeDetail detail={passingReport} score={{ name: "render", value: 1 }} />);
    expect(screen.getByText(/invented ids/)).toBeTruthy();
    expect(screen.getByText(/coverage/)).toBeTruthy();
    expect(screen.getByText(/table/)).toBeTruthy();
    expect(screen.getByText(/length ratio 0\.90×/)).toBeTruthy();
  });

  it("surfaces offending tokens on a failing gate", () => {
    const failing = {
      kind: "render-grade",
      report: {
        ...passingReport.report,
        inventedIds: { pass: false, inventedIds: ["obs-abc", "obs-def"] },
        coverageHonesty: { status: "dishonest", pass: false, actualCarried: 2, actualTotal: 5 },
      },
    };
    render(<RenderGradeDetail detail={failing} score={{ name: "render", value: 0 }} />);
    // failing invented-ids chip carries a count + sample
    expect(screen.getByText(/invented ids ✕/)).toBeTruthy();
    expect(screen.getByText(/2: obs-abc, obs-def/)).toBeTruthy();
    expect(screen.getByText(/coverage ✕ · 2\/5/)).toBeTruthy();
  });

  it("returns null on a malformed payload so the caller can fall back", () => {
    expect(
      RenderGradeDetail({ detail: { kind: "render-grade" }, score: { name: "x", value: null } }),
    ).toBeNull();
    expect(
      RenderGradeDetail({
        detail: { kind: "render-grade", report: 42 },
        score: { name: "x", value: null },
      }),
    ).toBeNull();
  });
});

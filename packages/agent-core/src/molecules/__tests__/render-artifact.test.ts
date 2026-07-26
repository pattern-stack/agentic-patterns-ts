import { describe, expect, it } from "vitest";
import {
  DEFAULT_ARTIFACT_BYTE_CEILING,
  RenderArtifactSchema,
  TableArtifactDataSchema,
  artifactMarker,
  isTableArtifact,
  tableArtifact,
} from "../render-artifact.js";

describe("TableArtifactDataSchema", () => {
  it("accepts headers plus positional rows with heterogeneous cells", () => {
    const parsed = TableArtifactDataSchema.safeParse({
      columns: ["deal", "amount", "closed"],
      rows: [
        ["Acme", 1200, true],
        ["Globex", null, false],
      ],
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts an empty table", () => {
    expect(TableArtifactDataSchema.safeParse({ columns: [], rows: [] }).success).toBe(true);
  });

  it("rejects non-string columns", () => {
    expect(TableArtifactDataSchema.safeParse({ columns: [1], rows: [] }).success).toBe(false);
  });

  it("rejects rows that are not arrays", () => {
    expect(TableArtifactDataSchema.safeParse({ columns: ["a"], rows: [{ a: 1 }] }).success).toBe(
      false,
    );
  });
});

describe("RenderArtifactSchema", () => {
  it("accepts a minimal artifact", () => {
    const parsed = RenderArtifactSchema.safeParse({
      id: "crm_table:e891",
      displayType: "table",
      data: { columns: [], rows: [] },
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts an artifact with no data — the ceiling-marker case", () => {
    const parsed = RenderArtifactSchema.safeParse({
      id: "crm_table:e891",
      displayType: "table",
      truncated: true,
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts an unknown displayType — the hint is an open string", () => {
    const parsed = RenderArtifactSchema.safeParse({
      id: "x",
      displayType: "flamegraph",
      data: { anything: true },
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects an empty id or displayType", () => {
    expect(RenderArtifactSchema.safeParse({ id: "", displayType: "table" }).success).toBe(false);
    expect(RenderArtifactSchema.safeParse({ id: "x", displayType: "" }).success).toBe(false);
  });
});

describe("tableArtifact", () => {
  it("stamps displayType and carries the payload", () => {
    const a = tableArtifact("crm_table:e891", {
      columns: ["deal"],
      rows: [["Acme"]],
    });
    expect(a.displayType).toBe("table");
    expect(a.id).toBe("crm_table:e891");
    expect(a.data).toEqual({ columns: ["deal"], rows: [["Acme"]] });
  });

  it("omits optional keys entirely when not supplied", () => {
    const a = tableArtifact("x", { columns: [], rows: [] });
    expect("title" in a).toBe(false);
    expect("truncated" in a).toBe(false);
  });

  it("carries title and the producer's truncated advisory", () => {
    const a = tableArtifact(
      "x",
      { columns: [], rows: [] },
      { title: "Closed deals", truncated: true },
    );
    expect(a.title).toBe("Closed deals");
    expect(a.truncated).toBe(true);
  });

  it("freezes the artifact and its payload", () => {
    const a = tableArtifact("x", { columns: ["a"], rows: [["b"]] });
    expect(Object.isFrozen(a)).toBe(true);
    expect(Object.isFrozen(a.data)).toBe(true);
  });

  it("produces a value that satisfies the schema", () => {
    const a = tableArtifact("x", { columns: ["a"], rows: [["b"]] });
    expect(RenderArtifactSchema.safeParse(a).success).toBe(true);
  });
});

describe("isTableArtifact", () => {
  it("accepts a well-formed table artifact", () => {
    expect(isTableArtifact(tableArtifact("x", { columns: ["a"], rows: [["b"]] }))).toBe(true);
  });

  it("rejects a non-table displayType", () => {
    expect(isTableArtifact({ id: "x", displayType: "code", data: "hi" })).toBe(false);
  });

  it("rejects a table marker with no data — render the marker, never crash", () => {
    expect(isTableArtifact({ id: "x", displayType: "table", truncated: true })).toBe(false);
  });

  it("rejects a table whose data is malformed", () => {
    expect(isTableArtifact({ id: "x", displayType: "table", data: { columns: "nope" } })).toBe(
      false,
    );
  });
});

describe("artifactMarker", () => {
  it("drops the payload but keeps identity and asserts truncated", () => {
    const marker = artifactMarker(
      tableArtifact("crm_table:e891", { columns: ["a"], rows: [["b"]] }, { title: "Deals" }),
    );
    expect(marker.id).toBe("crm_table:e891");
    expect(marker.displayType).toBe("table");
    expect(marker.title).toBe("Deals");
    expect(marker.truncated).toBe(true);
    expect(marker.data).toBeUndefined();
  });

  it("asserts truncated even when the producer had not", () => {
    const marker = artifactMarker({
      id: "x",
      displayType: "table",
      data: { columns: [], rows: [] },
    });
    expect(marker.truncated).toBe(true);
  });

  it("still satisfies the schema", () => {
    const marker = artifactMarker({ id: "x", displayType: "table", data: 1 });
    expect(RenderArtifactSchema.safeParse(marker).success).toBe(true);
  });
});

describe("DEFAULT_ARTIFACT_BYTE_CEILING", () => {
  it("sits far above any plausible payload (a ~1M-token context is a few MB)", () => {
    expect(DEFAULT_ARTIFACT_BYTE_CEILING).toBe(64 * 1024 * 1024);
    expect(DEFAULT_ARTIFACT_BYTE_CEILING).toBeGreaterThan(10 * 1024 * 1024);
  });
});

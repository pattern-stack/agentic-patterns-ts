/**
 * `tokenize` — the ONE match-token rule both shipped backends share
 * (ADR-0009 D-3 / Decision 13).
 *
 * The cross-backend AGREEMENT is pinned by the conformance kit's Tier 2, which
 * runs the same corpus against every `search: "keyword"` backend and can
 * therefore catch a divergence this file cannot. What lives here is the shape
 * of the rule itself: the properties a Tier 2 table would only pin
 * incidentally, and the two non-features (no stemming, no stopword list) that
 * a well-meaning future edit would otherwise "improve" into a third semantic
 * neither FTS5 nor `plainto_tsquery` shares.
 */

import { describe, expect, it } from "vitest";
import { tokenize } from "../tokenize.js";

describe("tokenize", () => {
  it("splits on every non-letter, non-number and drops empties", () => {
    expect(tokenize("Prefers dark-mode in the editor.")).toEqual([
      "prefers",
      "dark",
      "mode",
      "in",
      "the",
      "editor",
    ]);
    expect(tokenize("The user's name is Doug.")).toEqual([
      "the",
      "user",
      "s",
      "name",
      "is",
      "doug",
    ]);
    expect(tokenize("  leading, trailing, and   collapsed   ")).toEqual([
      "leading",
      "trailing",
      "and",
      "collapsed",
    ]);
  });

  it("lowercases", () => {
    expect(tokenize("EDITOR Editor eDiToR")).toEqual(["editor", "editor", "editor"]);
  });

  it("folds diacritics — the axis in-memory used to lose and FTS5 always won", () => {
    expect(tokenize("café")).toEqual(["cafe"]);
    expect(tokenize("CAFÉ")).toEqual(["cafe"]);
    expect(tokenize("naïve résumé")).toEqual(["naive", "resume"]);
    // Decomposed input reaches the same tokens as composed input.
    expect(tokenize("café")).toEqual(tokenize("café"));
  });

  it("keeps digits, and keeps alphanumeric runs whole", () => {
    expect(tokenize("v0.39.0 ships 2 packages")).toEqual([
      "v0",
      "39",
      "0",
      "ships",
      "2",
      "packages",
    ]);
  });

  it("returns [] for blank and punctuation-only input", () => {
    // A blank-but-present query is a query, not an absence: every backend
    // resolves zero tokens as "matches nothing".
    expect(tokenize("")).toEqual([]);
    expect(tokenize("   ")).toEqual([]);
    expect(tokenize("?!—…")).toEqual([]);
    expect(tokenize("--")).toEqual([]);
  });

  it("preserves duplicate tokens — the in-memory scorer counts occurrences, mirroring bm25's per-term sum", () => {
    expect(tokenize("alpha alpha")).toEqual(["alpha", "alpha"]);
  });

  it("is idempotent on its own output", () => {
    const once = tokenize("The user's café — dark-mode, v2!");
    expect(once.flatMap(tokenize)).toEqual(once);
  });

  // -- the two deliberate NON-features ---------------------------------------

  it("does NOT stem: 'prefer' and 'prefers' are different tokens", () => {
    // FTS5's unicode61 has no stemmer, and neither does the in-memory store.
    // Adding one here would make BOTH reference backends diverge from a
    // Postgres backend using an unstemmed configuration, which is the failure
    // mode ADR-0009 Decision 13 exists to prevent.
    expect(tokenize("prefer")).not.toEqual(tokenize("prefers"));
    expect(tokenize("drink")).not.toEqual(tokenize("drinks"));
  });

  it("has NO stopword list: 'the', 'is', 'a' survive", () => {
    // Consequence worth knowing before writing a probe query: a question
    // containing only stopwords retrieves everything containing them.
    expect(tokenize("the is a of")).toEqual(["the", "is", "a", "of"]);
  });

  it("does NOT match substrings — that is the caller's job, and no caller does it", () => {
    // The bug this module closes: `haystack.includes("am")` was true for
    // "name". As tokens, they are unrelated.
    expect(tokenize("name")).not.toContain("am");
    expect(tokenize("Concatenate")).not.toContain("cat");
  });
});

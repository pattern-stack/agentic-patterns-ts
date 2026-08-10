/**
 * The ONE match-token rule, shared by every reference MemoryStore backend.
 *
 * [ADR-0009](../../../../docs/adr/0009-memory-routing-and-background-composition.md)
 * Decision 13 and Doug's settled constraint D-3: **the shipped backends must
 * not diverge on search semantics.** Before this module they did, and in
 * OPPOSITE directions:
 *
 *   • `InMemoryMemoryStore` scored with `haystack.includes(token)` — a
 *     SUBSTRING test. `"am"` hit `"n<b>am</b>e"`, `"prefer"` hit `"Prefers"`,
 *     `"cat"` hit `"Con<b>cat</b>enate"`. It split the query on whitespace
 *     only, so the query token `name?` (punctuation attached) matched nothing.
 *   • `SqliteMemoryStore` hands the query to FTS5, whose default `unicode61`
 *     tokenizer matches WHOLE tokens, treats every non-alphanumeric as a
 *     separator, and folds Latin diacritics — so `"am"` and `"prefer"` returned
 *     zero, `"name?"` matched `name`, and `"cafe"` hit `"café"`.
 *
 * In-memory adopts token semantics rather than the reverse: FTS5 is what the
 * shipped companion runs on, and the future Postgres `tsvector` backend is
 * token-based too, so aligning in-memory aligns 3-of-3 rather than 1-of-3
 * (ADR-0009 Decision 13; the rejected alternative "change SqliteMemoryStore to
 * substring matching" is recorded there).
 *
 * The rule is deliberately a plain split with NO stemming, NO stopword list and
 * NO synonym expansion, because that is what `unicode61` does: `"prefer"` does
 * NOT match `"prefers"` on either backend, and `"the"` matches every record
 * containing it. A stemmer here would be a third semantic that neither FTS5 nor
 * `plainto_tsquery` shares.
 *
 * Both backends call this on the QUERY — that side is genuinely shared. The
 * HAYSTACKS are not: in-memory tokenizes its haystack with this function, while
 * SQLite's haystack is tokenized by FTS5's `unicode61` itself. The two agree
 * for Latin-1-class content — ASCII, Latin-1, Latin Extended-A, NFD-normalized
 * Latin — and the conformance kit's Tier 2 (`conformance.ts`) pins exactly that
 * class, which is the only thing that can keep them honest; this module cannot.
 * Outside it they are KNOWN to diverge: `unicode61` (`remove_diacritics 1`)
 * does not fold Vietnamese diacritics (`"tieng"` matches `"Tiếng"` in-memory,
 * zero rows on FTS5), Greek tonos, or Cyrillic breve, and treats Hebrew/Arabic
 * combining marks as SEPARATORS where this function strips them. Non-Latin
 * corpora should be developed against the backend they ship on.
 */

/**
 * Lowercase → NFD → drop combining marks → split on every non-letter,
 * non-number → drop empties.
 *
 * Modelled on FTS5's default `unicode61` tokenizer (`remove_diacritics 1`), and
 * pinned against it by the Tier 2 conformance corpus rather than by assertion
 * here.
 *
 *   tokenize("Prefers dark-mode in the editor.")
 *     → ["prefers", "dark", "mode", "in", "the", "editor"]
 *   tokenize("Met the team at the café")
 *     → ["met", "the", "team", "at", "the", "cafe"]
 *   tokenize("The user's name is Doug.")
 *     → ["the", "user", "s", "name", "is", "doug"]
 *   tokenize("   ")  → []
 *
 * A blank-but-present query tokenizes to `[]`, which every backend resolves as
 * "matches nothing" — a query, not an absence (`MemoryStore.search` docblock).
 *
 * Duplicate tokens are PRESERVED: the in-memory scorer counts one point per
 * query token occurrence, which mirrors FTS5's per-term bm25 sum. Callers that
 * want the haystack as a membership set build their own `Set`.
 */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 0);
}

/**
 * Phase 8 — Fuzzy matching & "did you mean": spelling correction at the vocabulary
 * boundary. Run: node src/phase8/fuzzy-spelling.ts
 *
 * A user types "resturant" and your search box returns zero results. The ranking
 * function is blameless — BM25 never got a chance, because "resturant" isn't a term
 * in the index. The query died at the VOCABULARY BOUNDARY. Typo tolerance is the fix,
 * and it lives on the query side, BEFORE retrieval:
 *
 *   EDIT DISTANCE (Levenshtein) measures how many single-character edits — insert,
 *      delete, substitute (each cost 1) — turn one string into another. "shoez"→"shoes"
 *      is one substitution: distance 1. It's a classic dynamic-programming table where
 *      cell [i][j] = cheapest way to transform a[0..i) into b[0..j).
 *
 *   CANDIDATE GENERATION: for a misspelled token, scan the real vocabulary for words
 *      within a small distance (≤2). Rank them by distance first, then by how common
 *      the word is — a frequent, close word is the likeliest intent.
 *
 *   CORRECT → ANALYZE → SEARCH: we correct RAW words against RAW vocabulary (no
 *      stemming yet — you fix "runing"→"running", not "runn"), THEN hand the corrected
 *      string to the SAME analyzer and retrieval pipeline every other phase used.
 *
 * SCALING: brute-forcing edit distance across the whole vocabulary is O(vocab · len²)
 * per token — fine for a demo, hopeless at millions of terms. Production prefilters
 * candidates with n-gram (trigram) indexes, BK-trees, SymSpell (a precomputed deletes
 * dictionary), or Levenshtein automata, so you only compute distance on a handful of
 * plausible words instead of the entire lexicon.
 *
 * MONEY QUOTE: typo tolerance is query-side expansion done at retrieval time — correct
 * and expand the query to terms that actually EXIST in the index, then search. A search
 * box that returns nothing for "resturant" is failing at the vocabulary boundary, not
 * the ranking.
 */

import { CORPUS, analyze } from "../lib/corpus.ts";
import { log } from "../lib/log.ts";

/**
 * Classic Levenshtein edit distance via dynamic programming. dp[i][j] holds the
 * minimum number of insert/delete/substitute edits (each cost 1) to turn the first
 * i characters of `a` into the first j characters of `b`.
 */
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  // dp is (m+1) × (n+1). Row/col 0 are the base cases: turning a string into ""
  // costs one deletion per character; turning "" into a string costs one insertion.
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1; // 0 if the chars already match
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,        // delete a[i-1]
        dp[i][j - 1] + 1,        // insert b[j-1]
        dp[i - 1][j - 1] + cost, // substitute (or free match)
      );
    }
  }
  return dp[m][n];
}

/** Distinct RAW lowercased tokens from the corpus, with a frequency count each.
 *  We split on the SAME non-alphanumeric boundary the analyzer uses, but we do NOT
 *  stem — spelling correction targets the words a user actually types. */
function buildVocabulary(): Map<string, number> {
  const freq = new Map<string, number>();
  for (const doc of CORPUS) {
    for (const tok of doc.text.toLowerCase().split(/[^a-z0-9]+/)) {
      if (!tok) continue;
      freq.set(tok, (freq.get(tok) ?? 0) + 1);
    }
  }
  return freq;
}

const VOCAB = buildVocabulary();

/** Every vocabulary word within `maxDist` edits of `token`, best first:
 *  distance ascending (closer = better), then frequency descending (commoner wins ties). */
function fuzzyCandidates(token: string, maxDist = 2): { word: string; dist: number; freq: number }[] {
  const out: { word: string; dist: number; freq: number }[] = [];
  for (const [word, freq] of VOCAB) {
    const dist = levenshtein(token, word);
    if (dist <= maxDist) out.push({ word, dist, freq });
  }
  return out.sort((a, b) => a.dist - b.dist || b.freq - a.freq || a.word.localeCompare(b.word));
}

/** Correct a raw query token-by-token: known words pass through untouched; unknown
 *  words are replaced by their best fuzzy candidate (if one exists within maxDist). */
function correctQuery(raw: string): { corrected: string; subs: { from: string; to: string }[] } {
  const subs: { from: string; to: string }[] = [];
  const out = raw
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map((tok) => {
      if (VOCAB.has(tok)) return tok;              // real word — leave it alone
      const best = fuzzyCandidates(tok)[0];
      if (!best) return tok;                        // nothing close — give up gracefully
      subs.push({ from: tok, to: best.word });
      return best.word;
    });
  return { corrected: out.join(" "), subs };
}

function main() {
  log(`Vocabulary: ${VOCAB.size} distinct raw tokens from ${CORPUS.length} docs`);
  log("");

  log("═══ levenshtein(): single-edit distances ═══");
  for (const [a, b] of [["shoez", "shoes"], ["runing", "running"], ["waterproff", "waterproof"], ["bots", "boots"]] as const) {
    log(`   levenshtein("${a}", "${b}") = ${levenshtein(a, b)}`);
  }
  log("");

  const typo = "runing shoez";
  log(`═══ Candidate lists for typo query "${typo}" (maxDist=2) ═══`);
  for (const tok of typo.split(" ")) {
    const cands = fuzzyCandidates(tok).slice(0, 4).map((c) => `${c.word}(d${c.dist},f${c.freq})`);
    log(`   "${tok}" → ${cands.join("  ") || "(no candidates)"}`);
  }
  log("");

  log(`═══ correctQuery("${typo}") ═══`);
  const { corrected, subs } = correctQuery(typo);
  for (const s of subs) log(`   "${s.from}" → "${s.to}"`);
  if (subs.length) log(`   Did you mean: ${corrected}`);
  log(`   corrected query: "${corrected}"`);
  log("");

  log("═══ correct → analyze → search: the corrected query enters the SAME pipeline ═══");
  log(`   raw:       "${typo}"`);
  log(`   corrected: "${corrected}"`);
  log(`   analyzed:  [${analyze(corrected).join(", ")}]   ← stemmed terms handed to BM25`);
  log("");

  log("The typo query never reached the ranker — 'runing' and 'shoez' aren't in the");
  log("index, so retrieval would return nothing. We repaired the query FIRST, mapping");
  log("each unknown word to a real vocabulary term by edit distance, then let the normal");
  log("analyze → retrieve → rank pipeline take over. Typo tolerance is query-side");
  log("expansion at the vocabulary boundary, not a ranking tweak.");
  process.exit(0);
}

main();

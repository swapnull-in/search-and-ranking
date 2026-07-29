/**
 * Phase 4 — RETRIEVE-THEN-RANK: the two-phase funnel. Run: npm run phase4
 *
 * Real search never scores every document with its best model — that's too slow
 * at billions of docs. It splits the work into phases with opposite priorities:
 *
 *   PHASE 1 — RETRIEVE (recall, cheap): a fast lexical pass (BM25 over the
 *     inverted index) pulls a few hundred CANDIDATES from billions. Its only job
 *     is "don't miss anything good"; it's allowed to be sloppy about order.
 *
 *   PHASE 2 — RANK (precision, expensive): a richer model re-scores ONLY those
 *     few hundred candidates using signals the cheap pass ignores — popularity,
 *     recency, exact-phrase match, personalization, even an ML model. Expensive
 *     per doc, but you only pay it on the shortlist.
 *
 * One phase can't do both: a model rich enough to rank perfectly is too slow to
 * run over everything; a model fast enough to run over everything ranks crudely.
 * Big search stacks add a 3rd stage (candidate-gen → rank → re-rank) for the same
 * reason — each stage is pricier and sees fewer items.
 *
 * We retrieve by BM25, then re-rank with popularity + recency + exact-match.
 */

import { CORPUS, analyze, type Doc } from "../lib/corpus.ts";
import { log } from "../lib/log.ts";

// Business signals the cheap lexical pass knows nothing about.
const POPULARITY: Record<number, number> = { 1: 0.3, 2: 0.9, 3: 0.4, 4: 0.2, 5: 0.5, 6: 0.95, 7: 0.1, 8: 0.6 };
const DAYS_OLD: Record<number, number> = { 1: 200, 2: 5, 3: 90, 4: 400, 5: 30, 6: 2, 7: 150, 8: 60 };

function bm25Retrieve(query: string, docs: Doc[]): Array<{ id: number; score: number }> {
  const postings = new Map<string, Map<number, number>>();
  const len = new Map<number, number>();
  let total = 0;
  for (const d of docs) {
    const terms = analyze(d.text); len.set(d.id, terms.length); total += terms.length;
    for (const t of terms) { const m = postings.get(t) ?? new Map(); m.set(d.id, (m.get(d.id) ?? 0) + 1); postings.set(t, m); }
  }
  const avg = total / docs.length, k1 = 1.5, b = 0.75, N = docs.length;
  const scores = new Map<number, number>();
  for (const t of analyze(query)) {
    const df = postings.get(t)?.size ?? 0; if (!df) continue;
    const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
    for (const [id, tf] of postings.get(t)!) {
      const norm = tf * (k1 + 1) / (tf + k1 * (1 - b + b * (len.get(id)! / avg)));
      scores.set(id, (scores.get(id) ?? 0) + idf * norm);
    }
  }
  return [...scores.entries()].map(([id, score]) => ({ id, score })).sort((a, b) => b.score - a.score);
}

function main() {
  const query = "running shoes";

  // ─── Phase 1: retrieve candidates (cheap, recall-oriented) ─────────────────
  const candidates = bm25Retrieve(query, CORPUS).slice(0, 5); // top-N shortlist
  log(`═══ Phase 1 — RETRIEVE top ${candidates.length} candidates by BM25 (cheap) ═══`);
  candidates.forEach((c, i) => log(`   ${i + 1}. doc ${c.id} (bm25 ${c.score.toFixed(3)}): ${CORPUS.find((d) => d.id === c.id)!.text.slice(0, 40)}`));

  // ─── Phase 2: re-rank the shortlist with rich signals (expensive) ──────────
  const reranked = candidates.map((c) => {
    const exact = CORPUS.find((d) => d.id === c.id)!.text.toLowerCase().includes(query) ? 1 : 0;
    const recency = 1 / (1 + DAYS_OLD[c.id] / 30); // newer → higher
    const final = 0.4 * c.score + 0.35 * POPULARITY[c.id] + 0.15 * recency + 0.10 * exact;
    return { ...c, final, pop: POPULARITY[c.id], recency, exact };
  }).sort((a, b) => b.final - a.final);

  log("");
  log("═══ Phase 2 — RE-RANK the shortlist (bm25 + popularity + recency + exact) ═══");
  reranked.forEach((c, i) =>
    log(`   ${i + 1}. doc ${c.id} (final ${c.final.toFixed(3)} | pop ${c.pop} recency ${c.recency.toFixed(2)} exact ${c.exact}): ${CORPUS.find((d) => d.id === c.id)!.text.slice(0, 32)}`));

  log("");
  const before = candidates.map((c) => c.id).join(","), after = reranked.map((c) => c.id).join(",");
  log(`   order changed: [${before}] → [${after}]`);
  log("Popular, fresh docs (2 & 6) climbed over a higher-BM25 but stale/niche doc.");
  log("The rich model only ran on 5 candidates — never on the whole corpus. That's");
  log("the funnel: cheap recall first, expensive precision on the shortlist only.");
  process.exit(0);
}

main();

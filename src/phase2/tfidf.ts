/**
 * Phase 2 — TF-IDF: ranking matches by relevance. Run: npm run phase2
 *
 * Phase 1's boolean query says WHICH docs match. It doesn't say which match
 * BEST — and a results page is useless without an order. TF-IDF is the classic
 * relevance score, built from two signals:
 *
 *   TF (term frequency): a term appearing more often in a doc → more relevant.
 *      "running" 3× beats "running" 1× (for that term).
 *
 *   IDF (inverse document frequency): a term in FEW docs is more discriminating.
 *      "the" is in every doc → near-zero weight; "waterproof" in one doc → high
 *      weight. IDF = log(N / docs-containing-term).
 *
 *   score(doc) = Σ  TF(term, doc) × IDF(term)   over the query terms.
 *
 * So a rare query word that appears several times in a doc drives the ranking —
 * exactly the intuition you want. (BM25 in Phase 3 fixes TF-IDF's two flaws.)
 */

import { CORPUS, analyze, type Doc } from "../lib/corpus.ts";
import { log } from "../lib/log.ts";

class TfIdfIndex {
  private postings = new Map<string, Map<number, number>>(); // term → (docId → term frequency)
  private N = 0;

  build(docs: Doc[]) {
    this.N = docs.length;
    for (const doc of docs) {
      for (const term of analyze(doc.text)) {
        const m = this.postings.get(term) ?? new Map();
        m.set(doc.id, (m.get(doc.id) ?? 0) + 1);
        this.postings.set(term, m);
      }
    }
  }

  private idf(term: string): number {
    const df = this.postings.get(term)?.size ?? 0;
    return df === 0 ? 0 : Math.log(this.N / df);
  }

  search(query: string) {
    const terms = analyze(query);
    const scores = new Map<number, number>();
    for (const term of terms) {
      const idf = this.idf(term);
      for (const [docId, tf] of this.postings.get(term) ?? []) {
        scores.set(docId, (scores.get(docId) ?? 0) + tf * idf);
      }
    }
    return [...scores.entries()].sort((a, b) => b[1] - a[1]);
  }
}

function main() {
  const index = new TfIdfIndex();
  index.build(CORPUS);

  const query = "red running shoes";
  log(`═══ TF-IDF ranking for "${query}" ═══`);
  log(`   analyzed: [${analyze(query).join(", ")}]`);
  log("");
  for (const [docId, score] of index.search(query)) {
    log(`   ${score.toFixed(3)}  doc ${docId}: ${CORPUS.find((d) => d.id === docId)!.text}`);
  }

  log("");
  log("Doc 1 ('Red running shoes for men') tops it — it hits all three query terms,");
  log("and 'red' is rare in the corpus so it carries weight. Doc 4 ('Running socks')");
  log("still appears (it has 'running') but ranks low: only one, common term matched.");
  log("");
  log("TF-IDF has two known flaws BM25 fixes next: (1) TF grows without limit — a");
  log("doc stuffing a word 100× shouldn't score 100×; (2) it doesn't normalize for");
  log("document length, so long docs win unfairly just by having more words.");
  process.exit(0);
}

main();

/**
 * Phase 3 — BM25: the ranking function search engines actually use. Run: npm run phase3
 *
 * BM25 keeps TF-IDF's two signals but fixes its two flaws, with two knobs:
 *
 *   TF SATURATION (k1): term frequency has DIMINISHING returns. The 1st occurrence
 *      of "running" matters a lot; the 20th barely more than the 10th. TF-IDF
 *      grows linearly forever (keyword-stuffable); BM25 curves it toward a ceiling.
 *
 *   LENGTH NORMALIZATION (b): a term in a SHORT doc is a stronger signal than the
 *      same term buried in a long one. BM25 divides by how long the doc is
 *      relative to the average, so a 500-word page doesn't out-rank a tight title
 *      just by having more words.
 *
 *   score = Σ IDF(t) · ( tf·(k1+1) ) / ( tf + k1·(1 − b + b·docLen/avgLen) )
 *
 * We add a keyword-STUFFED doc and a long padded doc to the corpus and watch
 * TF-IDF get fooled by both while BM25 shrugs them off.
 */

import { CORPUS, analyze, type Doc } from "../lib/corpus.ts";
import { log } from "../lib/log.ts";

const DOCS: Doc[] = [
  ...CORPUS,
  { id: 100, text: "shoes shoes shoes shoes shoes shoes shoes shoes shoes shoes cheap deal" }, // keyword stuffed
  { id: 101, text: "red running shoes " + "extra filler words about socks laces trails ".repeat(12) }, // long/padded
];

class Ranker {
  private postings = new Map<string, Map<number, number>>();
  private docLen = new Map<number, number>();
  private N = 0;
  private avgLen = 0;

  build(docs: Doc[]) {
    this.N = docs.length;
    let total = 0;
    for (const doc of docs) {
      const terms = analyze(doc.text);
      this.docLen.set(doc.id, terms.length);
      total += terms.length;
      for (const term of terms) {
        const m = this.postings.get(term) ?? new Map();
        m.set(doc.id, (m.get(doc.id) ?? 0) + 1);
        this.postings.set(term, m);
      }
    }
    this.avgLen = total / this.N;
  }

  private idf(term: string) {
    const df = this.postings.get(term)?.size ?? 0;
    return df === 0 ? 0 : Math.log(1 + (this.N - df + 0.5) / (df + 0.5));
  }

  tfidf(query: string) {
    const scores = new Map<number, number>();
    for (const t of analyze(query)) {
      const idf = Math.log(this.N / (this.postings.get(t)?.size || this.N));
      for (const [id, tf] of this.postings.get(t) ?? []) scores.set(id, (scores.get(id) ?? 0) + tf * idf);
    }
    return this.top(scores);
  }

  bm25(query: string, k1 = 1.5, b = 0.75) {
    const scores = new Map<number, number>();
    for (const t of analyze(query)) {
      const idf = this.idf(t);
      for (const [id, tf] of this.postings.get(t) ?? []) {
        const norm = tf * (k1 + 1) / (tf + k1 * (1 - b + b * (this.docLen.get(id)! / this.avgLen)));
        scores.set(id, (scores.get(id) ?? 0) + idf * norm);
      }
    }
    return this.top(scores);
  }

  private top(scores: Map<number, number>) {
    return [...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  }
}

function label(id: number) {
  const d = DOCS.find((x) => x.id === id)!;
  const tag = id === 100 ? " ⚠ keyword-stuffed" : id === 101 ? " ⚠ long/padded" : "";
  return `doc ${id}${tag}: ${d.text.slice(0, 44)}${d.text.length > 44 ? "…" : ""}`;
}

function main() {
  const r = new Ranker();
  r.build(DOCS);
  const query = "running shoes";

  log(`═══ TF-IDF for "${query}" — gets fooled ═══`);
  for (const [id, s] of r.tfidf(query)) log(`   ${s.toFixed(3)}  ${label(id)}`);

  log("");
  log(`═══ BM25 for "${query}" — saturates TF & normalizes length ═══`);
  for (const [id, s] of r.bm25(query)) log(`   ${s.toFixed(3)}  ${label(id)}`);

  log("");
  log("Watch the two ⚠ docs: TF-IDF lets the keyword-stuffed doc (shoes×10) and the");
  log("padded doc climb. BM25 saturates the repeated term and penalizes length, so");
  log("the genuinely relevant short docs win. That's why every engine ships BM25.");
  process.exit(0);
}

main();

/**
 * Phase 1 — ANALYSIS + THE INVERTED INDEX. Run: npm run phase1
 *
 * Search's core trick: do the expensive work at INDEX time so queries are cheap.
 * The structure that makes that possible is the INVERTED INDEX — a map from each
 * TERM to the list of documents containing it (the "posting list"). A forward
 * index is doc→words; inverting it to word→docs is what lets you answer "which
 * docs contain 'shoes'?" instantly instead of scanning every document.
 *
 * But garbage in, garbage ranked. Before indexing, every doc (and every query)
 * goes through ANALYSIS — the same pipeline both sides:
 *   lowercase → tokenize → drop stopwords → stem (shoes→shoe, running→run)
 * so that "Running Shoes" and "run shoe" match. If the two sides analyze
 * differently, nothing matches. That's the #1 real-world search bug.
 *
 * A boolean AND query then just INTERSECTS the posting lists of its terms.
 */

import { CORPUS, analyze } from "../lib/corpus.ts";
import { log } from "../lib/log.ts";

// term → sorted list of docIds containing it (the posting list)
const index = new Map<string, number[]>();

function build() {
  for (const doc of CORPUS) {
    for (const term of new Set(analyze(doc.text))) {
      const postings = index.get(term) ?? [];
      postings.push(doc.id);
      index.set(term, postings);
    }
  }
}

/** Intersect posting lists — the essence of a boolean AND query. */
function andQuery(terms: string[]): number[] {
  const lists = terms.map((t) => new Set(index.get(t) ?? []));
  if (lists.length === 0) return [];
  return [...lists[0]].filter((id) => lists.every((s) => s.has(id))).sort((a, b) => a - b);
}

function main() {
  build();

  log("═══ The inverted index (term → docs), a few entries ═══");
  for (const term of ["run", "shoe", "red", "trail"]) {
    log(`   "${term}"  →  docs [${(index.get(term) ?? []).join(", ")}]`);
  }
  log(`   (index has ${index.size} distinct terms across ${CORPUS.length} docs)`);

  log("");
  log('═══ Query: "red running shoes" → analyze, then AND the posting lists ═══');
  const q = analyze("red running shoes");
  log(`   analyzed query terms: [${q.join(", ")}]`);
  for (const t of q) log(`      "${t}" → [${(index.get(t) ?? []).join(", ")}]`);
  const result = andQuery(q);
  log(`   AND (intersection) → docs [${result.join(", ")}]`);
  for (const id of result) log(`      doc ${id}: ${CORPUS.find((d) => d.id === id)!.text}`);

  log("");
  log("Notice doc 6 ('Kids running shoes, red and blue') matched even though it");
  log("says 'shoes'/'running' — analysis stemmed both sides to the same terms.");
  log("The index found candidates fast; it did NOT rank them. Ranking is Phase 2–3:");
  log("boolean AND says WHICH docs match, not WHICH match BEST.");
  process.exit(0);
}

main();

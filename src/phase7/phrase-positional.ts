/**
 * Phase 7 — Phrase & positional queries: WHERE the words are, not just WHICH. Run: npm run phase7
 *
 * A plain inverted index stores term -> which docs. That answers "which docs
 * contain 'run' AND 'shoe'?" but it has thrown away the one thing a phrase needs:
 * WHERE in the doc each term sat. So it happily matches doc 3
 * "…trail RUNNING approach SHOES" for the phrase "running shoes" even though the
 * words are three tokens apart and mean something completely different.
 *
 * The fix is a POSITIONAL inverted index. At index time we store, for every term,
 * not just the doc id but the LIST OF POSITIONS (token indices) where it occurs:
 *
 *      term -> Map(docId -> number[] of positions into analyze(doc.text))
 *
 * With positions in hand:
 *   BOOLEAN AND  — intersect posting lists. "both words appear, anywhere."
 *   PHRASE       — among docs that have all terms, require term[i] to sit at p+i
 *                  for some anchor p. "the words are adjacent and in order."
 *   PROXIMITY    — require all terms inside a window of `slop` positions of each
 *                  other, order-free. "the words are near each other."
 *
 * We run the phrase "running shoes" (which analyzes to ["run","shoe"]) and watch
 * boolean AND over-match while the phrase query stays honest.
 */

import { CORPUS, analyze, type Doc } from "../lib/corpus.ts";
import { log } from "../lib/log.ts";

/** term -> (docId -> sorted positions of that term within analyze(doc.text)). */
class PositionalIndex {
  private postings = new Map<string, Map<number, number[]>>();

  build(docs: Doc[]) {
    for (const doc of docs) {
      const terms = analyze(doc.text);
      terms.forEach((term, pos) => {
        const perDoc = this.postings.get(term) ?? new Map<number, number[]>();
        const list = perDoc.get(doc.id) ?? [];
        list.push(pos);
        perDoc.set(doc.id, list);
        this.postings.set(term, perDoc);
      });
    }
  }

  /** docId -> positions for a single term (empty map if unseen). */
  entries(term: string): Map<number, number[]> {
    return this.postings.get(term) ?? new Map();
  }

  /** Docs containing ALL terms anywhere: intersection of the posting lists. */
  booleanAnd(terms: string[]): number[] {
    if (terms.length === 0) return [];
    const sets = terms.map((t) => new Set(this.entries(t).keys()));
    const [first, ...rest] = sets;
    return [...first].filter((id) => rest.every((s) => s.has(id))).sort((a, b) => a - b);
  }

  /** Docs where terms occur at CONSECUTIVE, in-order positions (a true phrase). */
  phraseQuery(terms: string[]): number[] {
    const matches: number[] = [];
    for (const id of this.booleanAnd(terms)) {
      // Anchor on the first term: for each start p, is term[i] present at p+i?
      const first = this.entries(terms[0]).get(id)!;
      const found = first.some((p) =>
        terms.every((t, i) => this.entries(t).get(id)!.includes(p + i)),
      );
      if (found) matches.push(id);
    }
    return matches;
  }

  /** Docs where ALL terms fit inside some window of `slop` positions, order-free. */
  proximityQuery(terms: string[], slop: number): number[] {
    const matches: number[] = [];
    for (const id of this.booleanAnd(terms)) {
      // For each occurrence of the first term, greedily pick each other term's
      // nearest position and check the whole spread stays within the window.
      const anchors = this.entries(terms[0]).get(id)!;
      const ok = anchors.some((anchor) => {
        const chosen = terms.map((t) => {
          const ps = this.entries(t).get(id)!;
          return ps.reduce((best, p) => (Math.abs(p - anchor) < Math.abs(best - anchor) ? p : best));
        });
        return Math.max(...chosen) - Math.min(...chosen) <= slop;
      });
      if (ok) matches.push(id);
    }
    return matches;
  }
}

function label(id: number) {
  const d = CORPUS.find((x) => x.id === id)!;
  return `doc ${id}: ${d.text}`;
}

function main() {
  const idx = new PositionalIndex();
  idx.build(CORPUS);

  const phrase = "running shoes";
  const terms = analyze(phrase); // ["run","shoe"]
  log(`Phrase "${phrase}" analyzes to [${terms.map((t) => `"${t}"`).join(", ")}]`);

  log("");
  log("═══ Positional index entries (docId -> token positions) ═══");
  for (const t of terms) {
    log(`   "${t}":`);
    for (const [id, positions] of [...idx.entries(t)].sort((a, b) => a[0] - b[0]))
      log(`        doc ${id} @ [${positions.join(", ")}]`);
  }

  log("");
  log(`═══ booleanAnd([${terms.map((t) => `"${t}"`).join(", ")}]) — both words ANYWHERE ═══`);
  for (const id of idx.booleanAnd(terms)) log(`   ${label(id)}`);

  log("");
  log(`═══ phraseQuery([${terms.map((t) => `"${t}"`).join(", ")}]) — words ADJACENT, in order ═══`);
  for (const id of idx.phraseQuery(terms)) log(`   ${label(id)}`);

  log("");
  log("Doc 3 is in booleanAnd but NOT in phraseQuery. Here's the proof — its positions:");
  const runPos = idx.entries("run").get(3)!;
  const shoePos = idx.entries("shoe").get(3)!;
  log(`   doc 3 "run" @ [${runPos.join(", ")}], "shoe" @ [${shoePos.join(", ")}]`);
  log(`   For a phrase we'd need shoe at run+1 = ${runPos[0] + 1}, but shoe is at ${shoePos[0]}. No adjacency.`);

  log("");
  log("═══ proximityQuery — same terms, but allow a slop window ═══");
  for (const slop of [1, 2]) {
    const hits = idx.proximityQuery(terms, slop);
    log(`   slop=${slop}: [${hits.join(", ")}]${hits.includes(3) ? "  ← doc 3 back in" : ""}`);
  }

  log("");
  log("A boolean index answers \"which docs contain these words\"; only a POSITIONAL");
  log("index can answer \"which docs contain this PHRASE\" — it's why the query");
  log("\"new york\" must not match a doc that says \"york, new\". Positions are the");
  log("extra data you store at index time to make phrase & proximity queries possible.");
  process.exit(0);
}

main();

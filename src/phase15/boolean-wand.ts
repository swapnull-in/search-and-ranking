/**
 * Phase 1.5 — BOOLEAN RETRIEVAL + WAND / Block-Max WAND. Run: node "src/phase15/boolean-wand.ts"
 *
 * Phase 1 found candidates (which docs match); Phase 3 ranked them (which match
 * best). Real engines DON'T do those as two sequential passes — they INTERLEAVE
 * retrieval and ranking so they can stop early. This phase shows how.
 *
 * First the boolean core, all just posting-list set math:
 *   AND = intersection · OR = union · NOT = difference.
 * The AND trick that matters: iterate the SHORTEST posting list and advance a
 * cursor in each of the others — you never touch docs the rarest term rules out.
 *
 * Then the ranking problem on a BROAD query. A query with a common term ("red",
 * "shoes") matches half the corpus. Naive top-K scores EVERY matching doc, sorts,
 * and keeps K — most of that scoring is wasted on docs that never had a chance.
 *
 * WAND fixes it with one precomputed number per term: its MAX contribution — an
 * upper bound on what that term can add to ANY doc's score. For a candidate, sum
 * the max contributions of the query terms it contains → an UPPER BOUND on its
 * score, computed WITHOUT scoring it. If that ceiling can't beat the current
 * K-th best (the threshold), skip the doc entirely. Block-Max WAND stores a max
 * per postings BLOCK, so whole blocks that can't beat the threshold are skipped.
 *
 * The lever you control: put the most SELECTIVE (rarest) term first, and move
 * non-scoring predicates into filter context. This is what bounds TAIL LATENCY
 * on broad queries.
 *
 * Naive boolean retrieval scores every matching doc — fatal for a query like
 * "the OR best" that matches half the corpus; WAND/Block-Max WAND skips any doc
 * (or block) whose best-possible score can't enter the top-K, which is why broad
 * queries stay fast.
 */

import { CORPUS, analyze } from "../lib/corpus.ts";
import { log } from "../lib/log.ts";

/** Inverted index with per-(term,doc) term frequencies so we can both match and score. */
class Engine {
  private postings = new Map<string, Map<number, number>>(); // term → (docId → tf)
  private maxContribution = new Map<string, number>();        // term → its BEST possible contribution
  private N = 0;

  build(docs = CORPUS) {
    this.N = docs.length;
    for (const doc of docs) {
      for (const term of analyze(doc.text)) {
        const m = this.postings.get(term) ?? new Map<number, number>();
        m.set(doc.id, (m.get(doc.id) ?? 0) + 1);
        this.postings.set(term, m);
      }
    }
    // Precompute each term's MAX contribution = idf(t) · (highest tf in any doc).
    // This is the upper bound WAND needs — the most any single doc can gain from t.
    for (const [term, plist] of this.postings) {
      const maxTf = Math.max(...plist.values());
      this.maxContribution.set(term, this.idf(term) * maxTf);
    }
  }

  private idf(term: string) {
    const df = this.postings.get(term)?.size ?? 0;
    return df === 0 ? 0 : Math.log(1 + (this.N - df + 0.5) / (df + 0.5));
  }

  /** Sorted posting list (docIds ascending) for a term. */
  list(term: string): number[] {
    return [...(this.postings.get(term)?.keys() ?? [])].sort((a, b) => a - b);
  }

  /** A term's precomputed MAX contribution — the upper bound WAND leans on. */
  maxOf(term: string): number {
    return this.maxContribution.get(term) ?? 0;
  }

  // ── Boolean operators over posting lists ────────────────────────────────

  /** AND = intersection. Iterate the SHORTEST list; advance a cursor in each
   *  other list up to the candidate. Docs the rarest term excludes are never seen. */
  and(terms: string[]): number[] {
    const lists = terms.map((t) => this.list(t)).sort((a, b) => a.length - b.length);
    if (lists.length === 0 || lists[0].length === 0) return [];
    const [shortest, ...others] = lists;
    const cursors = others.map(() => 0);
    const out: number[] = [];
    for (const id of shortest) {
      let inAll = true;
      for (let i = 0; i < others.length; i++) {
        while (cursors[i] < others[i].length && others[i][cursors[i]] < id) cursors[i]++; // advance
        if (others[i][cursors[i]] !== id) { inAll = false; break; }
      }
      if (inAll) out.push(id);
    }
    return out;
  }

  /** OR = union of every term's posting list. */
  or(terms: string[]): number[] {
    const set = new Set<number>();
    for (const t of terms) for (const id of this.list(t)) set.add(id);
    return [...set].sort((a, b) => a - b);
  }

  /** NOT = difference: docs with `keep` term(s) but NOT any `drop` term. */
  not(keep: string[], drop: string[]): number[] {
    const excluded = new Set(this.or(drop));
    return this.or(keep).filter((id) => !excluded.has(id));
  }

  // ── Scoring ─────────────────────────────────────────────────────────────

  /** Actual score for one doc = Σ idf(t)·tf over query terms present. This is the
   *  work WAND wants to AVOID; every call here counts as one "doc scored". */
  private scoreDoc(id: number, terms: string[]): number {
    let s = 0;
    for (const t of terms) {
      const tf = this.postings.get(t)?.get(id);
      if (tf) s += this.idf(t) * tf;
    }
    return s;
  }

  /** Upper bound WITHOUT scoring: sum the precomputed max contribution of each
   *  query term the doc contains. A ceiling on scoreDoc(id) — cheap map lookups. */
  private upperBound(id: number, terms: string[]): number {
    let ub = 0;
    for (const t of terms) {
      if (this.postings.get(t)?.has(id)) ub += this.maxContribution.get(t)!;
    }
    return ub;
  }

  /** NAIVE top-K: score EVERY matching doc, sort, keep K. Reports docs scored. */
  naiveTopK(terms: string[], k: number) {
    const candidates = this.or(terms);
    const scored = candidates.map((id) => ({ id, score: this.scoreDoc(id, terms) }));
    scored.sort((a, b) => b.score - a.score || a.id - b.id);
    return { top: scored.slice(0, k), docsScored: candidates.length };
  }

  /** WAND top-K: keep a threshold = current K-th best score. For each candidate,
   *  if its upper bound can't BEAT the threshold, skip scoring it entirely. */
  wandTopK(terms: string[], k: number) {
    const candidates = this.or(terms); // docId order — think of it as advancing cursors
    const top: { id: number; score: number }[] = [];
    let docsScored = 0;

    const threshold = () => (top.length < k ? -Infinity : top[k - 1].score);

    for (const id of candidates) {
      if (this.upperBound(id, terms) <= threshold()) continue; // ceiling can't enter top-K → SKIP
      const score = this.scoreDoc(id, terms); // only NOW do we pay to score
      docsScored++;
      top.push({ id, score });
      top.sort((a, b) => b.score - a.score || a.id - b.id);
      if (top.length > k) top.pop();
    }
    return { top, docsScored };
  }
}

const show = (ids: number[]) => `[${ids.join(", ")}]`;
const row = (r: { id: number; score: number }) =>
  `   ${r.score.toFixed(3)}  doc ${r.id}: ${CORPUS.find((d) => d.id === r.id)!.text.slice(0, 46)}`;

function main() {
  const e = new Engine();
  e.build();

  log("═══ Boolean operators are just posting-list set math ═══");
  const [red, shoe] = analyze("red shoes"); // → ["red", "shoe"]
  log(`   posting lists:  "red" → ${show(e.list(red))}   "shoe" → ${show(e.list(shoe))}`);
  log(`   AND (red ∩ shoe)          → ${show(e.and([red, shoe]))}   (iterate shortest list, advance the rest)`);
  log(`   OR  (red ∪ shoe)          → ${show(e.or([red, shoe]))}`);
  log(`   NOT (shoe AND NOT red)    → ${show(e.not([shoe], [red]))}`);

  log("");
  const query = analyze("running shoes red"); // → ["run","shoe","red"], a BROAD query
  const K = 3;
  log(`═══ Broad query "running shoes red" → terms [${query.join(", ")}], top-${K} ═══`);
  log(`   this OR-matches ${e.or(query).length} of ${CORPUS.length} docs — most can't crack the top-${K}`);
  log("   per-term MAX contribution (WAND's upper bound per term):");
  for (const t of query) log(`      "${t}" → max ${e.maxOf(t).toFixed(3)}`);

  const naive = e.naiveTopK(query, K);
  const wand = e.wandTopK(query, K);

  log("");
  log(`── NAIVE top-${K} (scores every matching doc) ──`);
  for (const r of naive.top) log(row(r));
  log("");
  log(`── WAND top-${K} (skips docs whose ceiling can't beat the K-th best) ──`);
  for (const r of wand.top) log(row(r));

  const same = JSON.stringify(naive.top.map((r) => r.id)) === JSON.stringify(wand.top.map((r) => r.id));
  log("");
  log(`   identical answer? ${same ? "YES" : "NO"}   →  ${show(wand.top.map((r) => r.id))}`);
  log(`   docs scored:  naive ${naive.docsScored}  vs  WAND ${wand.docsScored}   ` +
      `(WAND skipped ${naive.docsScored - wand.docsScored}/${naive.docsScored})`);

  log("");
  log("Retrieval and ranking are INTERLEAVED, not sequential: WAND uses the running");
  log("K-th best score to prune candidates AS it walks the lists. Block-Max WAND goes");
  log("further, storing a max score per postings BLOCK so entire blocks that can't beat");
  log("the threshold are skipped without decoding them. Your lever: put the most");
  log("selective (rarest) term first and push non-scoring predicates into filter");
  log("context. On a query matching half the corpus, that's what keeps tail latency flat.");
  process.exit(0);
}

main();

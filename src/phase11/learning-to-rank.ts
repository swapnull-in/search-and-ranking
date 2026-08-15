/**
 * Phase 11 — LEARNING TO RANK: let the data set the weights. Run: npm run phase11
 *
 * In Phase 4 we re-ranked the shortlist with a formula whose weights we GUESSED:
 *
 *     final = 0.4·bm25 + 0.35·popularity + 0.15·recency + 0.10·exact
 *
 * Where did 0.4 / 0.35 / 0.15 / 0.10 come from? An engineer's gut. Fine for a demo,
 * hopeless at scale: real rankers blend hundreds of features, and no human can hand-
 * tune a hundred-number vector. LEARNING TO RANK (LTR) throws the guessing away and
 * LEARNS the weights from labeled data — human relevance judgments or click logs.
 *
 * We teach the PAIRWISE approach, the most intuitive framing. A judge rarely gives a
 * doc an absolute score, but readily says "for this query, doc A beats doc B." Turn
 * every such verdict into a training PAIR and the ranking problem becomes plain
 * CLASSIFICATION: find a weight vector w such that, for every pair where A should
 * outrank B,   w·features(A) > w·features(B).  A misranked pair is just a mistake to
 * correct — nudge w toward (features(A) − features(B)) and try again (a perceptron).
 *
 * Features in, judgments as the target; the model discovers — e.g. — that popularity
 * deserves more weight than we assumed. Production stacks push this much further
 * (LambdaMART / gradient-boosted trees over hundreds of features); here we show the
 * linear pairwise CORE so the idea is naked and reproducible.
 *
 * The money quote: LTR replaces "an engineer guesses the weights" with
 * "the DATA sets the weights."
 */

import { CORPUS, analyze, type Doc } from "../lib/corpus.ts";
import { log } from "../lib/log.ts";

// Business signals the cheap lexical pass knows nothing about (copied from Phase 4).
const POPULARITY: Record<number, number> = { 1: 0.3, 2: 0.9, 3: 0.4, 4: 0.2, 5: 0.5, 6: 0.95, 7: 0.1, 8: 0.6 };
const DAYS_OLD: Record<number, number> = { 1: 200, 2: 5, 3: 90, 4: 400, 5: 30, 6: 2, 7: 150, 8: 60 };

// The hand-tuned weights from Phase 4 — what we're about to replace with learned ones.
const PHASE4_WEIGHTS = [0.4, 0.35, 0.15, 0.1];
const FEATURE_NAMES = ["bm25", "popularity", "recency", "exact"];

// GRADED RELEVANCE LABELS in {0,1,2,3}: what judges/clicks told us for "running shoes".
// These deliberately reward the genuinely-good, POPULAR, FRESH docs (2 and 6) over docs
// that BM25 alone would rank higher — that DISAGREEMENT is exactly what LTR must learn.
const LABELS: Record<number, number> = {
  6: 3, // kids running shoes — freshest (2d) & most popular (0.95): a great result
  2: 3, // blue running shoes — fresh (5d) & popular (0.9): a great result
  1: 2, // red running shoes  — perfect text match but stale (200d) & niche
  3: 1, // hiking boots w/ "trail running" — tangential
  7: 0, // trail-running vest  — not a shoe at all
};

// BM25 over the whole corpus (same math as Phase 3/4), returned as an id→score map.
function bm25Scores(query: string, docs: Doc[]): Map<number, number> {
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
  return scores;
}

const dot = (a: number[], b: number[]) => a.reduce((s, v, i) => s + v * b[i], 0);

function main() {
  const query = "running shoes";

  // ─── Build a FEATURE VECTOR per labeled doc: [bm25, popularity, recency, exact] ──
  // Features are normalized to roughly [0,1] so no single one dominates by scale.
  const ids = Object.keys(LABELS).map(Number);
  const raw = bm25Scores(query, CORPUS);
  const maxBm25 = Math.max(...ids.map((id) => raw.get(id) ?? 0));
  const samples = ids.map((id) => {
    const text = CORPUS.find((d) => d.id === id)!.text;
    const bm25 = (raw.get(id) ?? 0) / maxBm25;                    // divide by max → [0,1]
    const popularity = POPULARITY[id];                            // already [0,1]
    const recency = 1 / (1 + DAYS_OLD[id] / 30);                 // newer → higher, in (0,1]
    const exact = text.toLowerCase().includes(query) ? 1 : 0;    // {0,1}
    return { id, label: LABELS[id], x: [bm25, popularity, recency, exact], text };
  });

  log(`═══ Feature vectors for "${query}"  [${FEATURE_NAMES.join(", ")}] + judge label ═══`);
  for (const s of [...samples].sort((a, b) => b.label - a.label))
    log(`   doc ${s.id} label ${s.label} · x=[${s.x.map((v) => v.toFixed(2)).join(", ")}] · ${s.text.slice(0, 30)}`);

  // ─── Turn labels into PAIRS: every (i,j) with label[i] > label[j] means "i beats j" ──
  const pairs: Array<[number[], number[]]> = [];
  for (const a of samples) for (const b of samples)
    if (a.label > b.label) pairs.push([a.x, b.x]); // (winner features, loser features)
  log("");
  log(`═══ Built ${pairs.length} ordered training pairs (label[i] > label[j]) ═══`);

  // ─── TRAIN a pairwise linear model with the (margin) perceptron update ─────────
  // Deterministic: FIXED init at [0.25, 0.25, 0.25, 0.25], no Math.random(), so every
  // run is identical. We know NOTHING about which feature matters — all get equal say.
  //
  // A bare perceptron stops the instant every pair is barely on the right side, which
  // here is true at the start and teaches nothing. We instead demand a MARGIN: the
  // winner must beat the loser by at least `margin`. To satisfy that, the model keeps
  // adding up the winner-minus-loser DIRECTION of every under-margin pair — and that
  // direction is dominated by popularity & recency (the good docs are consistently
  // more popular and fresher, only sometimes higher-BM25). So the weight it DISCOVERS
  // drifts onto the business signals. That drift is the whole point of LTR.
  let w = [0.25, 0.25, 0.25, 0.25];
  const lr = 0.05, margin = 0.5, epochs = 400;
  log("");
  log("═══ Training (margin perceptron: if w·x_win < w·x_lose + margin, w += lr·(x_win − x_lose)) ═══");
  for (let epoch = 1; epoch <= epochs; epoch++) {
    let violations = 0;
    for (const [xi, xj] of pairs) {
      if (dot(w, xi) < dot(w, xj) + margin) {      // winner not ahead by the full margin → correct it
        violations++;
        w = w.map((wk, k) => wk + lr * (xi[k] - xj[k]));
      }
    }
    if (epoch <= 5 || epoch % 100 === 0 || violations === 0)
      log(`   epoch ${String(epoch).padStart(3)} · pairs under margin ${violations}/${pairs.length}`);
    if (violations === 0) break; // every winner clears the loser by ≥ margin — done
  }

  // ─── Report LEARNED weights vs the Phase-4 GUESS ───────────────────────────────
  // Normalize the learned vector to sum-to-1 so it's comparable to Phase 4's weights.
  const sum = w.reduce((s, v) => s + Math.abs(v), 0);
  const learned = w.map((v) => v / sum);
  log("");
  log("═══ Learned weights vs Phase-4 hand-tuned guess ═══");
  FEATURE_NAMES.forEach((name, k) =>
    log(`   ${name.padEnd(11)} learned ${learned[k].toFixed(3)}   vs   guessed ${PHASE4_WEIGHTS[k].toFixed(3)}`));

  // ─── Does the learned model rank BETTER than raw BM25? Measure pair agreement. ──
  const agree = (score: (s: (typeof samples)[number]) => number) => {
    let ok = 0, tot = 0;
    for (const a of samples) for (const b of samples) if (a.label > b.label) { tot++; if (score(a) > score(b)) ok++; }
    return `${ok}/${tot}`;
  };
  const byLearned = [...samples].sort((a, b) => dot(w, b.x) - dot(w, a.x));
  const byBm25 = [...samples].sort((a, b) => b.x[0] - a.x[0]);
  log("");
  log("═══ Ranking quality — correctly-ordered pairs (higher is better) ═══");
  log(`   raw BM25 order   : ${byBm25.map((s) => s.id).join(" > ")}   agreement ${agree((s) => s.x[0])}`);
  log(`   learned LTR order: ${byLearned.map((s) => s.id).join(" > ")}   agreement ${agree((s) => dot(w, s.x))}`);

  log("");
  log("Raw BM25 puts the exact-text doc (1) on top but buries the fresh, popular docs");
  log("the judges actually preferred (6/9 pairs right). The learned model — started at all-");
  log("equal weights, told nothing — DEMOTED bm25 from the heaviest signal (0.40) to a minor");
  log("one (~0.26) and made popularity the single largest weight, exactly reproducing the");
  log("judges' order (9/9). That's LTR: features in, judgments as the target, the DATA sets");
  log("the weights. Real engines scale this to LambdaMART over hundreds of features; the");
  log("linear pairwise core you just watched train is the idea underneath all of it.");
  process.exit(0);
}

main();

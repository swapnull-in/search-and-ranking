/**
 * Phase 12 — Offline evaluation: how to compare two rankers WITHOUT shipping. Run: npm run phase12
 *
 * You cannot improve what you cannot measure. Before you A/B test a ranking change
 * on real users, you score it OFFLINE against a set of GRADED relevance judgments:
 * for a query, a human (or click model) labels each candidate doc with a gain in
 * {0,1,2,3} — 0=irrelevant, 3=perfect. Then a metric turns one ranking into one
 * number so two rankers become comparable.
 *
 * The metrics, from blunt to sharp:
 *
 *   PRECISION@k / RECALL@k — SET quality, order-blind. Of the top k, what fraction
 *      is relevant (precision)? Of all relevant docs, what fraction did we surface
 *      in the top k (recall)? Treats gain>0 as "relevant". Ignores WHERE in the top
 *      k a good doc sits — so two orderings of the same top-k set score identically.
 *
 *   RR / MRR — reciprocal rank = 1/(rank of the FIRST relevant doc). "How high is
 *      the first good result?" MRR is the mean RR over many queries. The metric for
 *      known-item / navigational search, where there's one right answer.
 *
 *   AP / MAP — average precision averages precision@k at every rank that holds a
 *      relevant doc: rewards packing relevant docs early across the WHOLE list, with
 *      BINARY relevance. MAP is the mean AP over queries.
 *
 *   DCG / NDCG — the only one that is BOTH graded AND position-aware:
 *      DCG@k  = Σ (2^gain − 1) / log2(rank + 1)     (rank is 1-based)
 *      IDCG@k = DCG of the IDEAL ordering (sort docs by gain, descending)
 *      NDCG@k = DCG@k / IDCG@k   ∈ [0,1]   (1.0 = you matched the ideal ordering)
 *      The 2^gain − 1 makes a grade-3 doc worth far more than three grade-1 docs;
 *      the log2 discount makes a great doc at rank 1 worth more than at rank 5.
 *
 * KEY LESSON, shown below with two rankings of the SAME candidate set:
 *   Ranking A (good) puts the highest-gain docs at the very top.
 *   Ranking B (bad) holds the same docs but floats a low-gain doc above a high-gain
 *   one. Their top-k SET is identical, so Precision@k is IDENTICAL — yet NDCG@k
 *   clearly separates them, because NDCG is position- AND grade-aware. That gap is
 *   exactly what a user feels: the best result being buried under a worse one.
 *
 * These are OFFLINE metrics — cheap, deterministic, computed from stored judgments.
 * ONLINE you'd confirm the win with A/B tests and interleaving on live traffic
 * (a later phase covers online eval); offline metrics tell you what's WORTH shipping.
 */

import { log } from "../lib/log.ts";

/** A graded relevance judgment: how good is this doc for the query, on a 0..3 scale. */
type Gain = 0 | 1 | 2 | 3;
type Judgments = Map<string, Gain>;

/** Look up a doc's graded gain; anything unjudged counts as 0 (irrelevant). */
function gainOf(judgments: Judgments, docId: string): number {
  return judgments.get(docId) ?? 0;
}

/** Precision@k — of the top k returned, what fraction is relevant (gain > 0)?
 *  Pure SET quality: shuffle the top k and this number does not move. */
function precisionAtK(ranking: string[], judgments: Judgments, k: number): number {
  const topK = ranking.slice(0, k);
  if (topK.length === 0) return 0;
  const relevant = topK.filter((id) => gainOf(judgments, id) > 0).length;
  return relevant / topK.length;
}

/** Recall@k — of ALL relevant docs that exist, what fraction landed in the top k? */
function recallAtK(ranking: string[], judgments: Judgments, k: number): number {
  const totalRelevant = [...judgments.values()].filter((g) => g > 0).length;
  if (totalRelevant === 0) return 0;
  const found = ranking.slice(0, k).filter((id) => gainOf(judgments, id) > 0).length;
  return found / totalRelevant;
}

/** Reciprocal rank — 1 / (position of the FIRST relevant doc). 0 if none is relevant.
 *  "How high is the first good result?" MRR = mean of this over a set of queries. */
function reciprocalRank(ranking: string[], judgments: Judgments): number {
  for (let i = 0; i < ranking.length; i++) {
    if (gainOf(judgments, ranking[i]) > 0) return 1 / (i + 1);
  }
  return 0;
}

/** Average precision — average of precision@k at each rank holding a relevant doc.
 *  Binary relevance; rewards packing relevant docs early. MAP = mean AP over queries. */
function averagePrecision(ranking: string[], judgments: Judgments): number {
  const totalRelevant = [...judgments.values()].filter((g) => g > 0).length;
  if (totalRelevant === 0) return 0;
  let hits = 0;
  let sumPrecision = 0;
  for (let i = 0; i < ranking.length; i++) {
    if (gainOf(judgments, ranking[i]) > 0) {
      hits++;
      sumPrecision += hits / (i + 1); // precision at this rank
    }
  }
  return sumPrecision / totalRelevant;
}

/** DCG@k — Σ (2^gain − 1) / log2(rank + 1) over the top k. Graded + position-aware. */
function dcgAtK(ranking: string[], judgments: Judgments, k: number): number {
  let dcg = 0;
  const topK = ranking.slice(0, k);
  for (let i = 0; i < topK.length; i++) {
    const gain = gainOf(judgments, topK[i]);
    dcg += (Math.pow(2, gain) - 1) / Math.log2(i + 2); // rank is i+1, so log2(rank+1)=log2(i+2)
  }
  return dcg;
}

/** IDCG@k — the best DCG@k any ordering of the judged docs could achieve
 *  (sort every judged doc by gain, descending, then score the top k). */
function idcgAtK(judgments: Judgments, k: number): number {
  const idealOrder = [...judgments.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => id);
  return dcgAtK(idealOrder, judgments, k);
}

/** NDCG@k = DCG@k / IDCG@k ∈ [0,1]. 1.0 means you reproduced the ideal ordering. */
function ndcgAtK(ranking: string[], judgments: Judgments, k: number): number {
  const idcg = idcgAtK(judgments, k);
  if (idcg === 0) return 0;
  return dcgAtK(ranking, judgments, k) / idcg;
}

function main() {
  // One query, one candidate set, graded 0..3. Two docs are excellent (gain 3),
  // one is good (2), one is okay (1), one is irrelevant (0).
  const judgments: Judgments = new Map([
    ["d1", 3], // perfect
    ["d2", 3], // perfect
    ["d3", 2], // good
    ["d4", 1], // okay
    ["d5", 0], // irrelevant
  ]);

  // Ranking A (good): highest-gain docs at the very top.
  const rankingA = ["d1", "d2", "d3", "d4", "d5"];

  // Ranking B (bad): SAME five docs, same top-k SET, but the okay doc (d4, gain 1)
  // is floated above the two perfect docs (d1, d2, gain 3).
  const rankingB = ["d4", "d1", "d2", "d3", "d5"];

  const k = 3;
  const idealOrder = [...judgments.entries()].sort((a, b) => b[1] - a[1]).map(([id, g]) => `${id}(${g})`);

  log("═══ Offline evaluation — two rankers, one query, graded judgments ═══");
  log(`   judged gains: ${[...judgments.entries()].map(([id, g]) => `${id}=${g}`).join("  ")}`);
  log(`   ideal order (by gain): ${idealOrder.join(" > ")}   ← what IDCG scores`);
  log("");
  log(`   Ranking A (good): ${rankingA.map((id) => `${id}(${gainOf(judgments, id)})`).join(" > ")}`);
  log(`   Ranking B (bad):  ${rankingB.map((id) => `${id}(${gainOf(judgments, id)})`).join(" > ")}`);
  log("");

  const rows = [
    { name: "Precision@3", a: precisionAtK(rankingA, judgments, k), b: precisionAtK(rankingB, judgments, k) },
    { name: "Recall@3", a: recallAtK(rankingA, judgments, k), b: recallAtK(rankingB, judgments, k) },
    { name: "RR (1/first)", a: reciprocalRank(rankingA, judgments), b: reciprocalRank(rankingB, judgments) },
    { name: "AveragePrec.", a: averagePrecision(rankingA, judgments), b: averagePrecision(rankingB, judgments) },
    { name: "DCG@3", a: dcgAtK(rankingA, judgments, k), b: dcgAtK(rankingB, judgments, k) },
    { name: "NDCG@3", a: ndcgAtK(rankingA, judgments, k), b: ndcgAtK(rankingB, judgments, k) },
  ];

  log(`   IDCG@3 (ideal ceiling) = ${idcgAtK(judgments, k).toFixed(3)}`);
  log("");
  log("   metric          Ranking A   Ranking B   verdict");
  log("   ─────────────   ─────────   ─────────   ─────────────────────────");
  for (const r of rows) {
    const same = Math.abs(r.a - r.b) < 1e-9;
    const verdict = same ? "IDENTICAL — order-blind" : r.a > r.b ? "A wins — separates them" : "B higher";
    log(`   ${r.name.padEnd(13)}   ${r.a.toFixed(3).padStart(9)}   ${r.b.toFixed(3).padStart(9)}   ${verdict}`);
  }

  log("");
  log("Watch Precision@3 and Recall@3: IDENTICAL for A and B — the top-3 SET is the");
  log("same, and those metrics can't see order. But NDCG@3 drops sharply for B,");
  log("because it floated a gain-1 doc above two gain-3 docs — position- and grade-");
  log("aware, exactly the pain a user feels when the best result is buried.");
  log("");
  log("═══ Which metric when ═══");
  log("   Precision/Recall — SET quality, ignores order. Good for 'did we retrieve it at all?'");
  log("   MRR              — 'how high is the FIRST good result?' Known-item / navigational search.");
  log("   MAP              — binary relevance across the whole list; rewards packing hits early.");
  log("   NDCG             — graded relevance + position. The DEFAULT for web / product search.");
  log("");
  log("These are OFFLINE metrics: cheap, deterministic, computed from stored judgments to");
  log("decide what's WORTH shipping. ONLINE you confirm the win with A/B tests and");
  log("interleaving on live traffic (a later phase covers online eval).");
  log("");
  log("Takeaway: you cannot improve what you cannot measure. NDCG is the industry default");
  log("because it rewards putting the MOST relevant results at the very top — what users");
  log("actually feel. Two rankers with the same recall can have very different NDCG.");
  process.exit(0);
}

main();

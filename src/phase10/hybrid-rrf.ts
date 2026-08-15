/**
 * Phase 10 — HYBRID SEARCH + RECIPROCAL RANK FUSION (RRF). Run: npm run phase10
 *
 * Lexical and semantic retrieval fail in opposite ways. BM25 is literal: it only
 * finds docs that share the query's actual TERMS, so it misses a synonym or a
 * related concept it never saw. A vector retriever is fuzzy: it matches MEANING,
 * so it catches the synonym — but it also drags in things that are merely
 * "vibe-similar" and blows the exact-keyword match that BM25 nails. Each catches
 * what the other drops. Hybrid search runs BOTH and fuses their result lists.
 *
 * The catch: you can't just add the scores. BM25 lives on an unbounded IDF scale;
 * cosine lives in [-1, 1]. Adding them lets whichever scale happens to be larger
 * silently dominate, and "normalizing" them against each other is a fragile,
 * corpus-dependent hack. RECIPROCAL RANK FUSION sidesteps all of it by throwing
 * the raw scores away and fusing only the RANKS:
 *
 *   RRF(d) = Σ over each ranker r of  1 / (k + rank_r(d)),   k = 60
 *
 *   rank is 1-based; a doc missing from a ranker's list contributes 0. Being #1
 *   is worth 1/61; #2 is 1/62; the curve is flat, so no single ranker can bully
 *   the fusion — a doc that both rankers place *decently* beats a doc that one
 *   ranker loves and the other never returns.
 *
 * We run BM25 and a toy semantic retriever over the shared corpus on a query that
 * splits them, then watch RRF surface a doc that was #1 on NEITHER list alone.
 */

import { CORPUS, analyze, type Doc } from "../lib/corpus.ts";
import { log } from "../lib/log.ts";

// ─── Ranker 1: compact BM25 (same pattern as phase 4), returns docIds best-first ──
function bm25(query: string, docs: Doc[]): number[] {
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
  return [...scores.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}

// ─── Ranker 2: toy semantic retriever — cosine over concept embeddings ────────
// Each concept is a bag of stemmed terms that "mean" the same thing. A doc's
// vector lights up an axis for every one of its terms that lands in that concept,
// so two docs about the same idea end up pointing the same way even with zero
// shared words — the thing pure BM25 can never do.
const CONCEPTS = {
  footwear: ["shoe", "sneaker", "boot", "trainer", "oxford", "canvas", "high", "top"],
  running: ["run", "marathon", "trail", "ultra", "approach", "jog"],
  formal: ["dress", "formal", "leather", "classic", "oxford"],
  kids: ["kid", "playground", "durable"], color: ["red", "blue"],
  accessory: ["sock", "vest", "hydration", "bladder", "moistur", "wick"],
  outdoor: ["waterproof", "rugged", "hik", "trail"], people: ["men", "women", "unisex"],
};

const AXES = Object.keys(CONCEPTS) as (keyof typeof CONCEPTS)[];

/** Embed text into a vector over the concept axes, then L2-normalize. */
function embed(text: string): number[] {
  const v = AXES.map(() => 0);
  for (const term of analyze(text)) {
    AXES.forEach((axis, i) => { if (CONCEPTS[axis].includes(term)) v[i] += 1; });
  }
  const mag = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1; // avoid /0
  return v.map((x) => x / mag);
}

function semantic(query: string, docs: Doc[]): number[] {
  const q = embed(query);
  const scores = docs.map((d) => {
    const dv = embed(d.text);
    const cosine = dv.reduce((s, x, i) => s + x * q[i], 0); // unit vectors → dot = cosine
    return { id: d.id, cosine };
  });
  return scores
    .filter((s) => s.cosine > 0)
    .sort((a, b) => b.cosine - a.cosine)
    .map((s) => s.id);
}

// ─── The fusion: RRF over N ranked lists, ranks only, no scores ───────────────
function rrf(rankings: number[][], k = 60): Map<number, number> {
  const fused = new Map<number, number>();
  for (const ranking of rankings) {
    ranking.forEach((id, i) => {
      const rank = i + 1; // 1-based
      fused.set(id, (fused.get(id) ?? 0) + 1 / (k + rank));
    });
  }
  return fused;
}

// Return a doc's 1-based rank in a list, or null if it never appeared.
function rankOf(id: number, ranking: number[]): number | null {
  const i = ranking.indexOf(id);
  return i === -1 ? null : i + 1;
}

function label(id: number, ranking: number[]): string {
  const r = rankOf(id, ranking);
  const text = CORPUS.find((d) => d.id === id)!.text.slice(0, 40);
  return `doc ${id}${r ? "" : " (—)"}: ${text}`;
}

function main() {
  const query = "red running boots";
  const K = 60;

  const lexList = bm25(query, CORPUS);
  const semList = semantic(query, CORPUS);

  log(`═══ Query: "${query}" ═══`);
  log("");

  // ─── Each retriever alone, side by side ──────────────────────────────────
  log("── Ranker 1 — BM25 (lexical: needs the literal terms) ──");
  lexList.forEach((id, i) => log(`   ${i + 1}. ${label(id, lexList)}`));
  log("   BM25 crowns doc 3 — it's the only doc with the literal word 'boots'.");
  log("");

  log("── Ranker 2 — SEMANTIC (cosine over concept embeddings) ──");
  semList.forEach((id, i) => log(`   ${i + 1}. ${label(id, semList)}`));
  log("   Semantic crowns doc 2 — closest in footwear+running+color 'meaning', shares no 'boots'.");
  log("");

  // ─── Fuse with RRF — ranks only, incompatible score scales never touched ──
  const fused = rrf([lexList, semList], K);
  const ordered = [...fused.entries()].sort((a, b) => b[1] - a[1]);

  log(`── FUSED — Reciprocal Rank Fusion (k=${K}) ──`);
  ordered.forEach(([id, score], i) => {
    const lr = rankOf(id, lexList), sr = rankOf(id, semList);
    const parts = [
      lr ? `1/(${K}+${lr})` : "0",
      sr ? `1/(${K}+${sr})` : "0",
    ];
    log(`   ${i + 1}. doc ${id}  RRF ${score.toFixed(5)} = ${parts[0]} + ${parts[1]}   [bm25 #${lr ?? "—"}, sem #${sr ?? "—"}]`);
  });
  log("");

  // ─── Prove the fusion surfaced a consensus doc that led NEITHER list ──────
  const winnerId = ordered[0][0];
  const wonLexAlone = lexList[0] === winnerId;
  const wonSemAlone = semList[0] === winnerId;
  const wr = { lex: rankOf(winnerId, lexList), sem: rankOf(winnerId, semList) };

  log(`── Why doc ${winnerId} wins the fusion ──`);
  log(`   ${label(winnerId, lexList)}`);
  log(`   BM25 ranked it #${wr.lex ?? "—"}, semantic ranked it #${wr.sem ?? "—"} — top of NEITHER list.`);
  const c1 = wr.lex ? 1 / (K + wr.lex) : 0;
  const c2 = wr.sem ? 1 / (K + wr.sem) : 0;
  log(`   contribution  bm25: ${wr.lex ? `1/(${K}+${wr.lex})` : "0"} = ${c1.toFixed(5)}`);
  log(`   contribution  sem : ${wr.sem ? `1/(${K}+${wr.sem})` : "0"} = ${c2.toFixed(5)}`);
  log(`   RRF total   : ${(c1 + c2).toFixed(5)}`);
  // Compare against each list's #1, which RRF pushed BELOW the consensus doc.
  const lexTop = lexList[0], semTop = semList[0];
  const lexTopRrf = fused.get(lexTop)!, semTopRrf = fused.get(semTop)!;
  log(`   vs bm25 #1 doc ${lexTop}: RRF ${lexTopRrf.toFixed(5)}  (bm25 #1 but sem #${rankOf(lexTop, semList) ?? "—"})`);
  log(`   vs sem  #1 doc ${semTop}: RRF ${semTopRrf.toFixed(5)}  (sem #1 but bm25 #${rankOf(semTop, lexList) ?? "—"})`);
  log(`   Each list's champion is strong in ONE ranker and weak in the other, so its two`);
  log(`   fractions don't add up. Doc ${winnerId} is #${wr.lex}+#${wr.sem} — a consensus both rankers`);
  log(`   respect — and steady-across-both beats spiky-in-one. RRF surfaced it from nowhere.`);
  log("");

  if (!wonLexAlone && !wonSemAlone) {
    log("TAKEAWAY: RRF fuses lexical + semantic using only ranks, so incompatible score");
    log("scales (unbounded BM25 vs. cosine in [-1,1]) stop mattering — no normalization,");
    log("no tuning. Hybrid + RRF is the current default recipe (Elasticsearch/OpenSearch)");
    log("because it reliably beats either retriever alone.");
  } else {
    log("TAKEAWAY: RRF fuses lexical + semantic using ranks alone — no score normalization.");
  }
  process.exit(0);
}

main();

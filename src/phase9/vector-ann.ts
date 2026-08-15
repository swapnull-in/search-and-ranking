/**
 * Phase 9 — Vector / semantic search + ANN: matching MEANING, not characters. Run: npm run phase9
 *
 * BM25 (Phase 3) is brilliant at lexical matching, but it only knows the words it
 * was given. Search "sneakers for kids" and a doc that says "kids running shoes"
 * scores ZERO for "sneakers" — the engine has no idea the two words are cousins.
 * Lexical search matches CHARACTERS; it can't see that "sneakers", "shoes" and
 * "trainers" all point at the same idea.
 *
 * SEMANTIC SEARCH fixes this by embedding each doc AND the query into a vector in
 * "concept space", then ranking by how close those vectors point — cosine
 * similarity. Words that mean similar things land near each other, so "sneakers"
 * retrieves "shoes" even with zero shared characters.
 *
 *   embed(text)   → a vector over concept axes (footwear, running, kids, …)
 *   cosine(a,b)   → dot product of L2-normalized vectors ∈ [0,1]; 1 = same direction
 *
 * Real systems learn these vectors from a neural net trained on billions of
 * sentences. We have no ML here, so we fake the embedding with a hand-authored
 * CONCEPTS map — deterministic, inspectable, and enough to show the mechanism.
 *
 * Then ANN: cosine-scoring every doc is O(N·d) per query. Fine for 8 docs, fatal
 * for a billion. HNSW graphs and IVF clustering trade a sliver of recall for
 * orders-of-magnitude speed. We build a toy IVF to watch that tradeoff happen.
 */

import { CORPUS, analyze, type Doc } from "../lib/corpus.ts";
import { log } from "../lib/log.ts";

// Concept axes → the stemmed terms (as analyze() produces them) that signal each.
// A hand-authored stand-in for what a trained embedding model learns on its own.
const CONCEPTS = {
  footwear:  ["shoe", "sneaker", "boot", "trainer", "oxford", "canvas", "high", "top"],
  running:   ["run", "marathon", "trail", "ultra", "approach", "jog"],
  formal:    ["dress", "formal", "leather", "classic", "oxford"],
  kids:      ["kid", "playground", "durable"],
  color:     ["red", "blue"],
  accessory: ["sock", "vest", "hydration", "bladder", "moistur", "wick"],
  outdoor:   ["waterproof", "rugged", "hik", "trail"],
  people:    ["men", "women", "unisex"],
};

const AXES = Object.keys(CONCEPTS) as (keyof typeof CONCEPTS)[]; // fixed axis order

/** embed: turn text into a vector over the concept axes. For each analyzed term,
 *  add 1 to every concept whose term list contains it, then L2-normalize so length
 *  drops out and only DIRECTION (meaning) remains. */
function embed(text: string): number[] {
  const v = AXES.map(() => 0);
  for (const term of analyze(text)) {
    AXES.forEach((axis, i) => {
      if (CONCEPTS[axis].includes(term)) v[i] += 1;
    });
  }
  const mag = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return mag === 0 ? v : v.map((x) => x / mag);
}

/** cosine similarity of two L2-normalized vectors = their dot product. */
function cosine(a: number[], b: number[]): number {
  return a.reduce((s, x, i) => s + x * b[i], 0);
}

/** Which concept axes fire for a vector, strongest first — for explaining a match. */
function topConcepts(v: number[], n = 2): string {
  const hits = AXES.map((axis, i) => [axis, v[i]] as const)
    .filter(([, w]) => w > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([axis]) => axis);
  return hits.length ? hits.join("+") : "—";
}

/** Pure lexical baseline: count of shared analyzed terms. This is what a keyword
 *  engine "sees" — and why "sneakers" never finds a plain "shoes" doc. */
function lexicalOverlap(query: string, text: string): number {
  const q = new Set(analyze(query));
  return analyze(text).filter((t) => q.has(t)).length;
}

// Precompute an embedding per doc (offline in a real system — done once at index time).
const VECTORS = new Map<number, number[]>(CORPUS.map((d) => [d.id, embed(d.text)]));

/** Brute-force semantic search: cosine of the query against EVERY doc. O(N·d). */
function semanticSearch(query: string): { id: number; score: number }[] {
  const qv = embed(query);
  return CORPUS
    .map((d) => ({ id: d.id, score: cosine(qv, VECTORS.get(d.id)!) }))
    .sort((a, b) => b.score - a.score);
}

// ── Toy IVF (inverted file) index ─────────────────────────────────────────────
// Cluster every doc by its single DOMINANT concept. At query time, only score docs
// whose cluster matches the query's dominant concept(s) — skip the rest entirely.
function dominantAxis(v: number[]): keyof typeof CONCEPTS | null {
  let best = -1, bestAxis: keyof typeof CONCEPTS | null = null;
  AXES.forEach((axis, i) => {
    if (v[i] > best) { best = v[i]; bestAxis = axis; }
  });
  return best > 0 ? bestAxis : null;
}

const IVF = new Map<string, number[]>(); // cluster (dominant concept) → doc ids
for (const d of CORPUS) {
  const c = dominantAxis(VECTORS.get(d.id)!);
  if (c) IVF.set(c, [...(IVF.get(c) ?? []), d.id]);
}

/** IVF search: probe only the query's top clusters. Returns results AND how many
 *  docs it had to score — the whole point of ANN is that this number stays small. */
function ivfSearch(query: string, nprobe = 2): { results: { id: number; score: number }[]; scored: number } {
  const qv = embed(query);
  // pick the query's top-nprobe firing concept axes as the clusters to probe
  const probes = AXES.map((axis, i) => [axis, qv[i]] as const)
    .filter(([, w]) => w > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, nprobe)
    .map(([axis]) => axis);
  const candidates = new Set<number>();
  for (const c of probes) for (const id of IVF.get(c) ?? []) candidates.add(id);
  const results = [...candidates]
    .map((id) => ({ id, score: cosine(qv, VECTORS.get(id)!) }))
    .sort((a, b) => b.score - a.score);
  return { results, scored: candidates.size };
}

function label(id: number): string {
  const d = CORPUS.find((x) => x.id === id) as Doc;
  return `doc ${id}: ${d.text.slice(0, 46)}${d.text.length > 46 ? "…" : ""}`;
}

function main() {
  const query = "sneakers for kids";
  log(`Query: "${query}"`);
  log(`analyze(query) → [${analyze(query).join(", ")}]  →  concepts: ${topConcepts(embed(query))}`);
  log("");

  log('═══ Pure LEXICAL overlap (what BM25 "sees") — the meaning gap ═══');
  for (const d of [...CORPUS].sort((a, b) => lexicalOverlap(query, b.text) - lexicalOverlap(query, a.text))) {
    log(`   overlap ${lexicalOverlap(query, d.text)}  ${label(d.id)}`);
  }
  log('   ↑ "sneaker"↔"shoe" scores 0: different characters, so lexical is blind to it.');
  log("");

  log("═══ SEMANTIC (cosine over concept vectors) — matches meaning ═══");
  for (const { id, score } of semanticSearch(query)) {
    log(`   cos ${score.toFixed(3)}  [${topConcepts(VECTORS.get(id)!)}]  ${label(id)}`);
  }
  log("   ↑ doc 6 (kids running shoes) and doc 8 (canvas sneakers…) rise to the top,");
  log('     even though they share few/no words with "sneakers for kids".');
  log("");

  log("═══ ANN via toy IVF — same top results, far fewer docs scored ═══");
  log("Clusters (each doc filed under its dominant concept):");
  for (const [c, ids] of IVF) log(`   ${c.padEnd(10)} → docs [${ids.join(", ")}]`);
  const ivf = ivfSearch(query);
  log("");
  log(`IVF probes only the query's top clusters, scoring ${ivf.scored}/${CORPUS.length} docs:`);
  for (const { id, score } of ivf.results) {
    log(`   cos ${score.toFixed(3)}  [${topConcepts(VECTORS.get(id)!)}]  ${label(id)}`);
  }
  const bruteTop = semanticSearch(query)[0].id;
  const ivfTop = ivf.results[0]?.id;
  log(`   brute-force top = doc ${bruteTop};  IVF top = doc ${ivfTop}  →  ${bruteTop === ivfTop ? "SAME winner" : "DIFFERENT (a recall miss)"}`);
  log("");
  log("RECALL/SPEED TRADEOFF: IVF ignored every doc outside the probed clusters, so it");
  log("scored a fraction of the corpus and got (nearly) the same answer. Raise nprobe →");
  log("more clusters searched → higher recall but slower; lower nprobe → faster but you");
  log("risk missing a good doc parked in an unprobed cluster. HNSW makes the same bet");
  log("with a navigable graph instead of clusters.");
  log("");

  log("Takeaway: embeddings match MEANING, not characters — 'sneakers' finds 'shoes'.");
  log("ANN (IVF/HNSW) buys massive speed by giving up a sliver of recall, which is the");
  log("only way vector search survives at billions of docs. Modern search runs BOTH");
  log("lexical (BM25) AND semantic (vectors); the next phase FUSES their scores.");
  process.exit(0);
}

main();

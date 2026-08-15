/**
 * Phase 14 — FORWARD INDEX / DOC-VALUES: facets, filters & the score-free set. Run: node src/phase14/facets-filters.ts
 *
 * The inverted index answers ONE question well: "which docs contain this term?"
 * It is useless for the other half of e-commerce search — "give me THIS doc's
 * price", "count docs per brand", "sort by price". For that you need the mirror
 * structure: the FORWARD INDEX, stored column-by-column as DOC-VALUES — a
 * columnar per-document store, docId → field value, one dense array per field.
 *
 *   inverted index (term → [docIds])   answers  MATCHING   → drives the score
 *   doc-values     (field → [values])  answers  RETRIEVAL  → drives sort/filter/facet
 *
 * Three jobs ride on doc-values, and none of them touch relevance:
 *
 *   FILTER context — structured predicates (price < 100, brand == "Nike",
 *      in_stock) applied as a fast SET/bitset INTERSECTION. Filters are binary
 *      (a doc is in or out), so they carry NO score and, being stable, are
 *      CACHEABLE: the same filter reused across queries hits the same cached set.
 *
 *   FACETS — for the current result set, aggregate COUNTS over a doc-values
 *      field (Brand: Nike (3), Adidas (2)) or bucket a numeric field into a
 *      price histogram. Facets read the columnar store, never the analyzed text.
 *
 *   SORT — read a numeric doc-values column and order by it. (Shown lightly.)
 *
 * The pitfall this phase drills: you facet/sort/filter on DOC-VALUES — a keyword
 * or numeric field — NOT on an analyzed `text` field. Analyzed text is stemmed,
 * tokenized, stopword-stripped: "Running Shoes" became [run, shoe]. Counting
 * that gives you nonsense buckets. Keyword fields are stored verbatim precisely
 * so aggregations are exact.
 *
 * Filters are cached, score-free set intersections and facets are aggregations
 * over the columnar forward index (doc-values) — which is why "aggregate on
 * keyword, not analyzed text" and why the filter/score split is the biggest
 * e-commerce performance lever: cache the expensive-stable part (the filter set)
 * separately from the cheap-varying part (the per-query score).
 */

import { analyze } from "../lib/corpus.ts";
import { log } from "../lib/log.ts";

// A product has an analyzed TEXT field plus STRUCTURED fields (brand/category/
// price/in_stock). Text feeds the inverted index; the structured fields feed
// doc-values. Note "Running Shoes" (text) vs brand "Nike" (verbatim keyword).
interface Product {
  id: number;
  text: string;        // analyzed → inverted index (matching only)
  brand: string;       // keyword doc-value (verbatim → facet/filter)
  category: string;    // keyword doc-value
  price: number;       // numeric doc-value (filter/sort/histogram)
  in_stock: boolean;   // boolean doc-value (filter)
}

const PRODUCTS: Product[] = [
  { id: 1, text: "Nike running shoes lightweight breathable",   brand: "Nike",    category: "shoes",   price: 120, in_stock: true },
  { id: 2, text: "Adidas running shoes cushioned marathon",     brand: "Adidas",  category: "shoes",   price: 90,  in_stock: true },
  { id: 3, text: "Nike trail running shoes rugged grip",         brand: "Nike",    category: "shoes",   price: 140, in_stock: false },
  { id: 4, text: "Puma running shoes budget everyday trainer",   brand: "Puma",    category: "shoes",   price: 60,  in_stock: true },
  { id: 5, text: "Adidas running socks moisture wicking",        brand: "Adidas",  category: "socks",   price: 15,  in_stock: true },
  { id: 6, text: "Nike running vest hydration ultra",            brand: "Nike",    category: "apparel", price: 80,  in_stock: true },
  { id: 7, text: "Puma casual sneakers red canvas high top",     brand: "Puma",    category: "shoes",   price: 50,  in_stock: false },
  { id: 8, text: "Reebok running shoes stability support",       brand: "Reebok",  category: "shoes",   price: 95,  in_stock: true },
  { id: 9, text: "Adidas trail running shoes waterproof",        brand: "Adidas",  category: "shoes",   price: 110, in_stock: true },
];

// ── INVERTED INDEX over analyzed text (matching) ────────────────────────────
// term → docId → term-frequency, exactly like Phase 3. This decides WHICH docs
// match and, via BM25-lite, HOW WELL. Structured fields never enter here.
const postings = new Map<string, Map<number, number>>();
const docLen = new Map<number, number>();
let avgLen = 0;

// ── DOC-VALUES: the columnar forward index (retrieval) ──────────────────────
// One dense map per field, docId → value. This is what filters intersect and
// facets aggregate. Nothing here is analyzed — brand "Nike" is stored verbatim.
const dvBrand = new Map<number, string>();
const dvCategory = new Map<number, string>();
const dvPrice = new Map<number, number>();
const dvInStock = new Map<number, boolean>();

function build() {
  let total = 0;
  for (const p of PRODUCTS) {
    // inverted index side
    const terms = analyze(p.text);
    docLen.set(p.id, terms.length);
    total += terms.length;
    for (const term of terms) {
      const m = postings.get(term) ?? new Map<number, number>();
      m.set(p.id, (m.get(p.id) ?? 0) + 1);
      postings.set(term, m);
    }
    // doc-values side (columnar, verbatim)
    dvBrand.set(p.id, p.brand);
    dvCategory.set(p.id, p.category);
    dvPrice.set(p.id, p.price);
    dvInStock.set(p.id, p.in_stock);
  }
  avgLen = total / PRODUCTS.length;
}

function idf(term: string): number {
  const df = postings.get(term)?.size ?? 0;
  return df === 0 ? 0 : Math.log(1 + (PRODUCTS.length - df + 0.5) / (df + 0.5));
}

/** retrieve(): boolean OR-match over the inverted index, BM25-lite scored.
 *  Returns the scored CANDIDATE SET — the docs matching the text query. */
function retrieve(query: string, k1 = 1.5, b = 0.75): Map<number, number> {
  const scores = new Map<number, number>();
  for (const t of analyze(query)) {
    const weight = idf(t);
    for (const [id, tf] of postings.get(t) ?? []) {
      const norm = (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (docLen.get(id)! / avgLen)));
      scores.set(id, (scores.get(id) ?? 0) + weight * norm);
    }
  }
  return scores;
}

// ── FILTER CONTEXT ──────────────────────────────────────────────────────────
// A predicate maps a docId to in/out using ONLY doc-values. It returns a Set —
// score-free and cacheable. Filtering is intersection, never re-scoring.
type Filter = { label: string; pass: (id: number) => boolean };

const brandIs = (brand: string): Filter => ({
  label: `brand == "${brand}"`,
  pass: (id) => dvBrand.get(id) === brand,
});
const priceUnder = (max: number): Filter => ({
  label: `price < ${max}`,
  pass: (id) => dvPrice.get(id)! < max,
});
const inStock: Filter = { label: "in_stock", pass: (id) => dvInStock.get(id) === true };

/** Build the cacheable filter SET over a candidate universe. This set depends
 *  only on the doc-values + predicate, so it can be cached and reused across
 *  DIFFERENT text queries — the whole point of a separate filter context. */
function filterSet(candidates: Iterable<number>, filters: Filter[]): Set<number> {
  const out = new Set<number>();
  for (const id of candidates) if (filters.every((f) => f.pass(id))) out.add(id);
  return out;
}

/** Intersect scored candidates with a filter set: scores untouched, docs dropped. */
function applyFilters(scores: Map<number, number>, filters: Filter[]): Map<number, number> {
  const keep = filterSet(scores.keys(), filters);
  const out = new Map<number, number>();
  for (const [id, s] of scores) if (keep.has(id)) out.set(id, s);
  return out;
}

// ── FACETS: aggregations over doc-values ────────────────────────────────────
/** Term facet: count docs per keyword value in the current result set. Reads a
 *  keyword doc-value column — NOT the analyzed text — so counts are exact. */
function facetTerms(ids: Iterable<number>, column: Map<number, string>): [string, number][] {
  const counts = new Map<string, number>();
  for (const id of ids) {
    const v = column.get(id)!;
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/** Range/histogram facet: bucket a numeric doc-value column into price bands. */
function facetPriceRanges(ids: Iterable<number>): [string, number][] {
  const bands: [string, (p: number) => boolean][] = [
    ["$0–49",    (p) => p < 50],
    ["$50–99",   (p) => p >= 50 && p < 100],
    ["$100–149", (p) => p >= 100 && p < 150],
    ["$150+",    (p) => p >= 150],
  ];
  const counts = new Map<string, number>();
  for (const id of ids) {
    const price = dvPrice.get(id)!;
    for (const [name, test] of bands) if (test(price)) counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return bands.map(([name]) => [name, counts.get(name) ?? 0] as [string, number]).filter(([, c]) => c > 0);
}

function ranked(scores: Map<number, number>): [number, number][] {
  return [...scores.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
}

function label(id: number): string {
  const p = PRODUCTS.find((x) => x.id === id)!;
  return `doc ${id} [${p.brand}/${p.category}/$${p.price}/${p.in_stock ? "in" : "out"}]: ${p.text}`;
}

function main() {
  build();
  const query = "running shoes";

  log(`═══ retrieve("${query}") — matching on the INVERTED INDEX (scored candidates) ═══`);
  const candidates = retrieve(query);
  for (const [id, s] of ranked(candidates)) log(`   ${s.toFixed(3)}  ${label(id)}`);
  log(`   (${candidates.size} docs matched the analyzed text — this set has SCORES)`);

  log("");
  log("═══ FACETS over DOC-VALUES for that candidate set (aggregate on keyword, not text) ═══");
  log("   Brand facet (from dvBrand column):");
  for (const [brand, n] of facetTerms(candidates.keys(), dvBrand)) log(`      ${brand} (${n})`);
  log("   Price histogram (from dvPrice column):");
  for (const [band, n] of facetPriceRanges(candidates.keys())) log(`      ${band} (${n})`);

  log("");
  log('═══ FILTER context: add brand == "Nike" AND in_stock — a score-free SET intersection ═══');
  const filters = [brandIs("Nike"), inStock];
  const filtered = applyFilters(candidates, filters);
  const cachedSet = filterSet(candidates.keys(), filters); // this Set is what an engine caches
  log(`   cacheable filter set (docIds, no scores): {${[...cachedSet].sort((a, b) => a - b).join(", ")}}`);
  for (const [id, s] of ranked(filtered)) log(`   ${s.toFixed(3)}  ${label(id)}`);
  log(`   (${filtered.size} survive — facet counts NARROW, but look at the scores…)`);

  log("");
  log("═══ PROOF: filtering does NOT change relevance — surviving scores are IDENTICAL ═══");
  for (const [id] of ranked(filtered)) {
    const before = candidates.get(id)!;
    const after = filtered.get(id)!;
    log(`   doc ${id}: unfiltered ${before.toFixed(3)}  →  filtered ${after.toFixed(3)}  ${before === after ? "✓ same" : "✗ CHANGED"}`);
  }

  log("");
  log("═══ Re-faceted Brand counts on the FILTERED set (Nike-only, narrowed) ═══");
  for (const [brand, n] of facetTerms(filtered.keys(), dvBrand)) log(`      ${brand} (${n})`);

  log("");
  log("═══ PITFALL: faceting on the ANALYZED text field gives garbage buckets ═══");
  const tokenCounts = new Map<string, number>();
  for (const id of candidates.keys()) for (const t of analyze(PRODUCTS.find((p) => p.id === id)!.text)) tokenCounts.set(t, (tokenCounts.get(t) ?? 0) + 1);
  log(`   "brand" facet if you (wrongly) counted analyzed tokens: ${[...tokenCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([t, n]) => `${t}(${n})`).join(", ")} …`);
  log("   → stemmed, tokenized nonsense (run, shoe) — NOT brands. That is why brand");
  log("     is a verbatim keyword doc-value, never the analyzed text field.");

  log("");
  log("Takeaway: the inverted index MATCHES and SCORES; the columnar forward index");
  log("(doc-values) FILTERS, FACETS and SORTS. Filters are binary, score-free and");
  log("cacheable — the same filter set is reused across queries — while the score is");
  log("the cheap per-query varying part. Splitting the expensive-stable filter from");
  log("the cheap-varying score, and aggregating on keyword doc-values instead of");
  log("analyzed text, is the single biggest e-commerce search performance lever.");
  log("(Watch cardinality: a doc-value column per unique value — high-cardinality");
  log(" fields like SKU or user-id make facets memory-heavy; facet only what you show.)");
  process.exit(0);
}

main();

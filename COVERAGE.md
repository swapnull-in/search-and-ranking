# Coverage — vs a Staff-level search syllabus

How this project maps to the standard Staff-Engineer search curriculum (inverted
index → ranking → features → scaling → semantic/hybrid). Each ✅ is a runnable
phase **and** an interactive web panel.

Legend: ✅ covered · ⚠️ partial · ⬜ planned · 🚫 out of scope (not a "run the
algorithm" topic — engine-product comparisons and interview-delivery framing).

## 1 · Fundamentals — the inverted index

| Topic | Status | Where |
|---|---|---|
| Tokenize / normalize / stem / stop-words (analysis chain) | ✅ | phase1 + Analyzer |
| Index/query analyzer must agree (#1 "no results" bug) | ✅ | phase1 "break it" toggle |
| Forward index vs inverted index (doc-values) | ✅ | phase14 |
| Postings lists | ✅ | phase1 |
| Term dictionary (FST), skip lists, delta/PForDelta compression | ⚠️ | noted, not simulated |
| Boolean retrieval — AND | ✅ | phase1 |
| Boolean OR / NOT + WAND / Block-Max WAND | ✅ | phase15 |
| Positional index + phrase + slop | ✅ | phase7 |

## 2 · Ranking & relevance

| Topic | Status | Where |
|---|---|---|
| TF-IDF (and why it fails) | ✅ | phase2 |
| BM25 (k1 TF-saturation, b length-norm) | ✅ | phase3 |
| BM25F / multi-field boosting | ⚠️ | conceptual only |
| Vector space model / cosine | ✅ | phase9 |
| Learning-to-rank (pointwise/pairwise/listwise) | ✅ | phase11 (pairwise) |
| Ranking signals (popularity, recency, exact) | ✅ | phase4 |
| Click / position bias & debiasing | ⚠️ | mentioned, not interactive |
| Metrics — Precision/Recall, MRR, MAP, NDCG | ✅ | phase12 |
| Retrieve-then-rank (two-stage funnel) | ✅ | phase4 |

## 3 · Technologies (Elasticsearch/Lucene, OpenSearch, Solr, Vespa)

🚫 Out of scope by design — the repo is engine-agnostic and teaches the mechanisms
these products implement, not the products. See the phases for each mechanism.

## 4 · Search features

| Topic | Status | Where |
|---|---|---|
| Full-text + relevance tuning (field boosts) | ⚠️ | BM25 relevance in phase3; boosting conceptual |
| Autocomplete / typeahead (trie / FST / prefix table) | ✅ | phase6 |
| Fuzzy search (Levenshtein; BK-tree / SymSpell noted) | ✅ | phase8 |
| Faceted search & filters (doc-values, filter bitsets) | ✅ | phase14 |
| Synonyms (query-time vs index-time) | ⬜ | planned |
| Highlighting | ⚠️ | UI highlights matches; not taught as a feature |

## 5 · Scaling & architecture

| Topic | Status | Where |
|---|---|---|
| Sharding + scatter-gather + tail latency + hedging | ✅ | phase5 |
| Immutable segments · refresh / flush / merge · search lag | ✅ | phase13 |
| Zero-downtime reindex with aliases (blue-green) + routing | ✅ | phase16 |
| Indexing pipeline (CDC / outbox / log, rebuildability) | ⬜ | planned (mostly architecture) |
| Index-path / query-path separation (CQRS) | ⬜ | planned |
| Hot-warm-cold + ILM (time-series tiering) | ⬜ | planned |
| Capacity planning (disk / heap / RAM / vectors) | ⬜ | planned (interactive calculator) |

## 6 · Modern search — semantic & hybrid

| Topic | Status | Where |
|---|---|---|
| Semantic / vector search + ANN (HNSW/IVF concept) | ✅ | phase9 (toy IVF) |
| Hybrid search + Reciprocal Rank Fusion | ✅ | phase10 |
| Vector DB vs search engine trade-off | ⚠️ | conceptual |

## 7 · Worked example — product-search system design

⬜ Planned — a capstone panel that assembles the pieces (index path via a log,
two-stage retrieve-then-rank, alias indirection, filter/score split, separate
autocomplete path) into one architecture.

---

**Summary:** the relevance & ranking core (§1–2, §4.2–4.3, §6) is complete and
interactive. The systems & scale track (§5) is in progress; engine-product
comparisons and interview-delivery framing (§3, cheat-sheet) are intentionally left
as prose in study notes rather than code.

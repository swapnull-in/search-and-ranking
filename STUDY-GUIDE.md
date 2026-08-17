# Study Guide — this repo ↔ Module 07 (Search & Ranking)

This repo is the *runnable half* of `Core Course/07-search.md`: every phase implements one mechanism the module explains. The loop for each phase: **run it** (`npm run phaseN`) → **read the code** (each file opens with a mini-lecture header) → **poke the matching panel** in the web lab (`npm run web`) and quiz yourself in the **Drill** tab → **read the module section** for the staff-level framing (decisive defaults, revisit-triggers, anti-patterns). The code proves the mechanism works; the module tells you what to *say about it* in the room.

## Phase → module mapping

| Phase | What it builds | Module section (§ name) | The staff insight |
|---|---|---|---|
| 1 | Analysis chain + inverted index, boolean AND | §1.1–1.2 Tokenization… / Forward vs Inverted Index | "The number-one cause of 'bad search' is an analyzer mismatch between writers and readers" — first action: `_analyze` both sides. |
| 2 | TF-IDF ranking (tf × idf) | §2.1 TF-IDF | "TF-IDF is the concept you must be able to derive… but you'd never ship it" — knowing *why* it fails motivates BM25. |
| 3 | BM25 — TF saturation (k1) + length norm (b) | §2.2 BM25 | "Resist tuning k1/b before you've fixed analysis and field boosting" — field weights are the highest-leverage knob. |
| 4 | Retrieve-then-rank funnel (cheap recall → rich re-rank) | §2.7 The Retrieve-then-Rank Pipeline | "Make retrieval cheap and recall-y, make ranking expensive and small" — stage 1's job is recall; no re-ranker recovers a lost doc. |
| 5 | Sharding, scatter-gather, hedged requests, tail math | §5.3 Sharding & Replication | "Shard count is an *irreversible* day-1 decision… size for ~12 months" — latency is the max of all shard latencies. |
| 6 | Typeahead — top-K per prefix precomputed at build time | §4.2 Autocomplete / Typeahead | "Autocomplete is a *latency-first* product: you trade flexibility for speed by precomputing" — debounce + cache or you DDoS yourself. |
| 7 | Positional index, phrase + slop queries | §1.5 Positional Indexes and Phrase Search | "Shingle the top-frequency bigrams at index time" — push cost to write time when read volume dominates, like materializing a join. |
| 8 | Levenshtein edit distance + "did you mean" | §4.3 Fuzzy Search | "Never run fuzziness > 2 or unbounded prefixes… it defeats the FST pruning" — cheap match first, fuzzy as fallback. |
| 9 | Embeddings, cosine ranking, ANN (HNSW/IVF idea) | §6 Modern Search — Semantic & Hybrid | "Don't reach for embeddings until BM25 + synonyms + analyzers have plateaued" — that YAGNI discipline is itself the Staff signal. |
| 10 | Hybrid lexical + semantic fusion via RRF | §6 Modern Search — Semantic & Hybrid | "Say 'RRF because it needs no score calibration' and you've signaled you've actually shipped hybrid" — fuse ranks, never raw scores. |
| 11 | Pairwise learning-to-rank (learned re-rank weights) | §2.4 Learning-to-Rank | "LTR is a re-ranker, never a retriever" — the hard part is training data: position bias and offline/online feature parity. |
| 12 | Precision/Recall, MRR, MAP, NDCG on judged sets | §2.6 Metrics — Precision/Recall, NDCG, MAP, MRR | "Instrument the two stages separately — a re-ranker can't fix a doc that retrieval never surfaced." |
| 13 | Immutable segments, translog, refresh/merge, tombstones | §5.6 Updates, Immutable Segments, Search Lag | "High-churn data is fundamentally hostile to an immutable-segment engine" — never put a live counter on a search doc. |
| 14 | Forward index / doc-values: filters + facet counts | §4.4 Faceted Search & Filters | "Pushing structured predicates into filter context makes them *cached bitsets* shared across queries" — only the BM25 part recomputes. |
| 15 | Boolean AND/OR/NOT + Block-Max WAND early exit | §1.4 Query Execution — Boolean Retrieval | "Block-Max WAND is why production engines stay fast" — retrieval and ranking are *interleaved*, which bounds tail latency on broad queries. |
| 16 | Blue-green reindex behind an alias + shard routing | §5.5 Zero-Downtime Reindexing with Aliases | "*Always* point applications at an alias from day one — it's free insurance" — the atomic swap is blue-green for search, flip-back included. |

## Go deeper

- **Deep Dives/06-elasticsearch.md** — the production side of phases 13/16: cluster anatomy, refresh/flush/merge, ILM, and the ops scars this repo only simulates.
- **Deep Dives/11-vector-databases.md** — phases 9/10 at real scale: HNSW vs IVF-PQ internals, the recall/latency/memory triangle, and when a vector DB beats ES.
- **Deep Dives/29-typeahead-autocomplete.md** — the full system-design treatment of phase 6: prefix sharding, edge caching, and personalized suggestion ranking.
- **Core Course/16-data-processing.md** — the biggest gap this repo doesn't build: the CDC/outbox indexing pipeline (§5.1) that makes "delete the cluster and rebuild" true.
- **Core Course/06-databases.md** — why search is a derived read model and never the source of truth; the litmus test behind the module's #1 anti-pattern.
- **DDIA, Chapter 3 (Storage and Retrieval)** — LSM-trees and SSTables are the same immutable-segment + merge pattern as phase 13, seen from the database side.

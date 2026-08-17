/** Drill data — mined from Core Course/07-search.md. Loaded by index.html's Drill panel. */
window.DRILL = {
  module: "Module 07 — Search & Ranking",
  source: "Core Course/07-search.md",
  cheats: [
    "<b>Inverted index</b> = term → postings (docIDs + freqs + positions). Term dictionary is an <b>FST</b>; long postings use <b>skip pointers</b>; docIDs are delta + PForDelta compressed.",
    "The <b>analysis chain</b> (char filter → tokenize → lowercase → stop → stem) must be <em>identical</em> at index and query time — the #1 cause of \"no results\"; debug with <code>_analyze</code>.",
    "<b>Inverted</b> index drives retrieval/scoring; <b>forward index / doc values</b> drive sort, facets, aggregations. Aggregate on <code>keyword</code>, never on analyzed <code>text</code>.",
    "TF-IDF's flaws — unbounded TF, no length norm — are exactly what <b>BM25</b> fixes: <code>k1</code> saturates TF, <code>b</code> normalizes length (defaults 1.2 / 0.75). Tune field boosts before constants.",
    "<b>Two stages</b>: retrieval = high recall over the whole index (BM25/kNN); re-rank = high precision on the top ~100–1000 (LTR/cross-encoder). Never rank the whole corpus — stage 1's job is recall.",
    "<b>Metrics per task</b>: MRR for autocomplete/known-item, NDCG for graded ranking, Recall@k for the retrieval stage. Offline NDCG is the fast loop; online A/B + zero-result rate is ground truth.",
    "Lucene <b>segments are immutable</b>: refresh (~1s) makes docs searchable, flush fsyncs, merge purges tombstones. Update = delete + reindex, so high-churn fields are hostile to the engine.",
    "<b>ES is a derived, rebuildable read model — never the primary DB.</b> Feed it via CDC/outbox from the source of truth. Litmus test: can you delete the cluster and rebuild from source?",
    "<b>Shard count is fixed at creation</b> — target ~30 GB/shard sized for 12 months. Over-sharding widens the scatter-gather tail (latency = max of all shard latencies). Custom routing for multi-tenant.",
    "<b>Alias from day one</b>: build v2, backfill (replay the log), validate, atomically swap, keep flip-back. Blue-green deployment for search indexes — the cheapest insurance in the module.",
    "<b>Filters</b> run in filter context as <em>cached bitsets</em> and never affect score; <b>facets</b> are aggregations over doc values. The filter/score split is the main e-commerce performance lever.",
    "<b>Autocomplete</b> is latency-first: precomputed in-RAM FST/trie, sharded by prefix, client debounce + edge cache, run as a <em>separate service</em>. Metric = MRR.",
    "<b>Fuzzy</b> = Levenshtein automaton intersected with the term FST. Cap edit distance at 2 with <code>prefix_length</code>; run fuzzy as a <em>fallback</em> when results are thin, not on every query.",
    "<b>Hybrid</b> = BM25 + vector kNN fused by <b>RRF</b> (rank-based, k≈60, no score calibration). Don't add vectors until BM25 + synonyms plateau — HNSW is RAM-resident and vectors dominate capacity."
  ],
  cards: [
    {
      topic: "query path",
      q: "Walk me through what happens from typing a query to getting ranked results.",
      a: "The query is analyzed with the same chain as the field, optionally rewritten (spell-correct, synonyms), then parsed into a boolean tree; postings are merged — AND intersects the shortest list with advance(), OR uses Block-Max WAND to skip docs that can't make top-K. Matches are BM25-scored in stage 1 (high recall, whole index), scatter-gathered across shards, and the top few hundred go to a stage-2 re-ranker (LTR/cross-encoder, high precision) plus business rules, facets over doc values, and highlighting. Always emphasize the two stages and scatter-gather — that's the structural signal."
    },
    {
      topic: "BM25",
      q: "Why use BM25 over TF-IDF? When would you tune k1/b?",
      a: "TF-IDF has unbounded term frequency and no length normalization; BM25 fixes both — k1 saturates TF, b normalizes by doc length. Defaults (1.2/0.75) are fine for most corpora; tune b→0 for short fields like titles and raise k1 for long technical docs, but only after fixing analyzers and field boosting, and always offline against a judged set measured by NDCG — never by eyeballing one query."
    },
    {
      topic: "ES as DB",
      q: "Can I use Elasticsearch as my primary database?",
      a: "No — flag it as a top architectural anti-pattern the moment a design implies it. No multi-doc transactions, no real joins, near-real-time (1s refresh) so search is eventually consistent, and immutable segments make updates expensive. Treat ES as a derived, rebuildable read model fed from the system of record via CDC/outbox. Litmus test, said aloud: can you delete the cluster and rebuild from source? If not, durability is coupled to the wrong system."
    },
    {
      topic: "typeahead",
      q: "Design autocomplete for 100M queries with <50ms latency.",
      a: "Latency-first means precompute: a trie/FST (or ES completion suggester) held in RAM with a popularity weight per completion mined from query logs. Shard by the first 1–3 chars, edge-cache top-N for hot prefixes, debounce keystrokes client-side; rank by popularity + recency and measure MRR. Keep it a separate service so keystrokes never hit the heavy pipeline — build a custom trie only when the suggester can't do personalized or mid-word matching."
    },
    {
      topic: "reindex",
      q: "How do you reindex 2 billion documents with zero downtime?",
      a: "Apps query an alias, never the physical index — set that up from day one. Create v2 with the new mapping/shards, dual-write or (cleaner) replay the Kafka log so live changes land in v2, backfill history, validate counts and sample NDCG, then atomically swap the alias — no query sees a gap, and if relevance regresses you flip back. This is blue-green for search and the only way to change immutable mappings or shard counts."
    },
    {
      topic: "hybrid",
      q: "Keyword vs semantic search — which do you pick?",
      a: "Both — hybrid — but not on day one. BM25 nails exact terms, codes, and rare jargon and never confidently returns a plausible-but-wrong doc; embeddings close the vocabulary-mismatch gap (car/automobile, paraphrase). Fuse with Reciprocal Rank Fusion (rank-based, k≈60, no score calibration). Don't reach for vectors until BM25 + synonyms + analyzers plateau, because embeddings add an embedding pipeline, RAM-heavy ANN, model lifecycle, and silent semantic drift."
    },
    {
      topic: "freshness",
      q: "A user updates a product and doesn't see it in search immediately. Bug?",
      a: "Not a bug — it's the refresh interval (default 1s) plus segment immutability. The write is durable in the translog instantly and GET by _id is real-time, but search only sees the doc after the next refresh seals a new segment; the update itself is a delete-tombstone plus reindex. Use ?refresh=wait_for for read-your-writes (throughput cost), raise the interval for bulk loads, and never put high-churn fields like live inventory on a search doc — keep them in a KV store and override at serve time."
    },
    {
      topic: "sharding",
      q: "How do you choose shard count, and why is over-sharding bad?",
      a: "Primary shard count is fixed at creation, so size for ~12 months of growth: target ~30 GB per shard (10–50 GB band). Over-sharding hurts because every query scatter-gathers to one copy of every shard — more coordination overhead and a wider tail, since query latency is the max of all shard latencies, plus fixed per-shard memory cost. For multi-tenant, use custom routing so a tenant's queries hit one shard — watching for whale-tenant hotspots."
    },
    {
      topic: "facets",
      q: "How do facets and filters work, and why are they fast?",
      a: "Filters run in filter context as a cached bitset and don't affect score, so they're reused across queries — the BM25 part recomputes while the structured part is a cached intersection. Facets are aggregations over doc values (the columnar forward index) on the filtered set, which is why you facet on a keyword field, not analyzed text. This filter/score split is the main e-commerce performance lever: cache the expensive-stable part separately from the cheap-varying part."
    },
    {
      topic: "metrics",
      q: "What metrics evaluate search quality, and how do you avoid optimizing the wrong thing?",
      a: "Match the metric to the task and the stage: Recall@k for retrieval (don't lose the good doc), NDCG for graded ranking, MRR for autocomplete/known-item. Instrument the two stages separately — a re-ranker can't fix what retrieval never surfaced. Offline NDCG is the fast loop; online A/B + interleaving plus zero-result rate are ground truth. Debias click labels (inverse propensity weighting) because raw CTR is position-biased — top results win for being on top."
    },
    {
      topic: "delivery",
      q: "You have 35 minutes to design search for a new product. How do you spend them?",
      a: "Front-load the framing: clarify requirements and state a YAGNI baseline with triggers — multi-field BM25 + facets covers most of it; no vectors or LTR until a measured gap forces them. Earmark the two hard parts — index-to-source consistency / zero-downtime reindex, and any high-churn field like inventory — and spend the time there. Draw the two paths (CDC-fed index path, replica-served query path), the two ranking stages, and the alias; keep tokenization and TF-IDF to one sentence each. The grade is calibrated depth and decisions, not the diagram."
    },
    {
      topic: "YAGNI",
      q: "When would you NOT use a search engine at all?",
      a: "When nothing in the requirements forces one: small corpus (sub-million rows), no relevance-ranking requirement, just keyword lookup — a database full-text index (Postgres tsvector/GIN, MySQL FULLTEXT) is the right call: no second system, no consistency lag, strong durability. Reaching for Elasticsearch there is the same over-engineering as adding Kafka to a CRUD app. Name the triggers that would justify an engine — relevance ranking, faceting at scale, typo tolerance, autocomplete — so the decision is explicit and revisitable."
    }
  ]
};

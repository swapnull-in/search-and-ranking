# Learn Search & Ranking in TypeScript

A hands-on, runnable project for understanding search engines at a Staff/EM
level — from the inverted index and BM25 to sharded scatter-gather and typeahead.

Every phase is a small script you can run and read. No build step: modern Node
runs the TypeScript directly. No external services.

> Built to match a Staff-level study path. The through-line: search **inverts the
> work** — do the expensive part at INDEX time so query time is cheap. Every
> search question is four decisions: **analysis** (tokens/stemming),
> **retrieve-then-rank**, **freshness**, and **topology** (shard, scatter-gather).

## Setup

```bash
npm install   # dev types only
```

## The lessons

| Command | What you learn |
|---|---|
| `npm run phase1` | **Inverted index** — analysis (tokenize/stopwords/stem) + boolean AND query |
| `npm run phase2` | **TF-IDF** — ranking matches by term frequency × rarity |
| `npm run phase3` | **BM25** — TF saturation + length normalization (beats keyword-stuffing) |
| `npm run phase4` | **Retrieve-then-rank** — the cheap-recall → expensive-precision funnel |
| `npm run phase5` | **Scatter-gather** — sharding, aggregation, and tail latency |
| `npm run phase6` | **Typeahead** — top-K per prefix precomputed at build time |

## Interactive web demo

Prefer poking things over reading logs? `web/index.html` is a single, self-contained
page that ports the **same** analyzer, BM25, re-ranker, and prefix table into the
browser — every panel is one of the phases above, made interactive:

- **Analyzer** — type text, watch tokens get lowercased, stopword-dropped, stemmed
- **Inverted index** — live boolean AND with posting lists and highlighted terms; flip **"break it"** to analyze the query differently from the index and watch matches collapse to zero — the #1 real-world search bug, live
- **TF-IDF / BM25** — side-by-side, with `k1`/`b` sliders; watch the keyword-stuffed doc top TF-IDF but fall off BM25's first page. **Click any result** to expand the per-term `idf × tf` / `idf × norm` math
- **Retrieve → rank** — drag the popularity/recency/exact-match weights and watch the order change
- **Scatter-gather** — animate a 5-shard query, then hedge the slow shard away; plus the p99 tail-latency math
- **Typeahead** — real precomputed prefix table, suggestions narrow as you type

Tabs are keyboard-navigable (arrow keys) and deep-linkable (`#3-bm25`) so you can share a link straight to one concept.

```bash
npm run web        # serves it at http://localhost:8080 (no deps)
# — or just open web/index.html directly in a browser; it's fully standalone.
```

## What each phase proves (the money quotes)

- **Phase 3** — a keyword-stuffed doc (`shoes ×10`) **tops TF-IDF** but BM25
  drops it off the first page entirely; the genuinely relevant short docs win.
- **Phase 4** — BM25 retrieval order `[1,2,3,6,7]` becomes `[6,2,1,3,7]` after
  re-ranking with popularity/recency — and the rich model only touched 5 docs.
- **Phase 5** — a 5-shard query bound by one slow shard takes **301ms**;
  hedging it to a replica cuts it to **84ms**. And the tail math: with 100 shards
  each slow 1% of the time, **63%** of queries hit a slow shard.
- **Phase 6** — suggestions narrow as you type, each an O(1) point lookup on a
  precomputed prefix table — no ranking at query time.

## The mental model

```
        INDEX TIME (expensive, offline)          QUERY TIME (cheap, online)
  ┌─────────────────────────────────────┐   ┌──────────────────────────────────┐
  │ analyze → inverted index             │   │ analyze query → retrieve (BM25)  │
  │ precompute typeahead prefixes        │   │  → re-rank shortlist → results   │
  │ build & shard segments               │   │ scatter to shards → gather top-k │
  └─────────────────────────────────────┘   └──────────────────────────────────┘
```

## Project layout

```
src/
  lib/log.ts  ·  lib/corpus.ts   (shared analyzer + sample docs)
  phase1/  inverted index + boolean query
  phase2/  TF-IDF ranking
  phase3/  BM25
  phase4/  retrieve-then-rank funnel
  phase5/  sharding + scatter-gather + tail latency
  phase6/  typeahead (top-K per prefix)
```

## License

MIT — use it, fork it, learn from it.

/**
 * Phase 5 — SCATTER-GATHER & TAIL LATENCY. Run: npm run phase5
 *
 * One machine can't hold a billion-doc index, so you SHARD BY DOCUMENT: each
 * shard holds a slice of the docs and its own inverted index. A query is
 * SCATTERED to every shard, each returns its local top-k, and an aggregator
 * GATHERS and merges them into the global top-k.
 *
 * Sharding by doc (not by term) wins because every shard can score independently
 * in parallel — no cross-shard chatter mid-query. But it has a tax:
 *
 *   TAIL LATENCY. The query is only as fast as the SLOWEST shard, because the
 *   aggregator must wait for all of them. And the more shards you have, the more
 *   likely at least one is having a bad moment: if a single shard is slow 1% of
 *   the time, with 100 shards ~63% of queries hit at least one slow shard. That's
 *   why p99 gets WORSE as you scale out — the opposite of intuition.
 *
 * Mitigations: HEDGED REQUESTS (re-send the laggard to a replica, take the first
 * to answer) and EARLY TERMINATION (return once "enough" shards have replied).
 * We measure a slow shard, then hedge it away.
 */

import { log } from "../lib/log.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Hit { id: number; score: number }

/** One shard: "computes" its local top-k after some latency. */
async function shardQuery(shardId: number, latencyMs: number): Promise<Hit[]> {
  await sleep(latencyMs);
  return [{ id: shardId * 10 + 1, score: 1 - shardId * 0.05 }, { id: shardId * 10 + 2, score: 0.5 }];
}

function merge(all: Hit[][], k: number): Hit[] {
  return all.flat().sort((a, b) => b.score - a.score).slice(0, k);
}

async function main() {
  // 5 shards; shard 3 is having a bad moment (300ms vs ~20ms).
  const latencies = [20, 25, 18, 300, 22];

  // ─── Naive scatter-gather: wait for ALL shards ─────────────────────────────
  log("═══ Scatter-gather across 5 shards (shard 3 is slow: 300ms) ═══");
  let t = Date.now();
  const results = await Promise.all(latencies.map((lat, i) => shardQuery(i, lat)));
  const globalTopK = merge(results, 3);
  log(`   all shards answered in ${Date.now() - t}ms → bound by the SLOWEST shard (300ms)`);
  log(`   global top-3: ${globalTopK.map((h) => `#${h.id}(${h.score.toFixed(2)})`).join(", ")}`);

  // ─── Hedged request: re-send the laggard to a replica after 50ms ───────────
  log("");
  log("═══ Same query, but HEDGE the slow shard to a replica after 50ms ═══");
  t = Date.now();
  const hedged = await Promise.all(latencies.map((lat, i) => {
    if (lat <= 50) return shardQuery(i, lat);
    // Race the slow shard against a hedged replica that responds fast.
    const replicaLatency = 30;
    return Promise.race([shardQuery(i, lat), sleep(50).then(() => shardQuery(i, replicaLatency))]);
  }));
  merge(hedged, 3);
  log(`   answered in ${Date.now() - t}ms → the hedge (50ms + 30ms replica) beat the 300ms shard`);

  // ─── Why p99 degrades with shard count ─────────────────────────────────────
  log("");
  log("═══ Tail-latency math: P(a query hits ≥1 slow shard), if each shard is slow 1% ═══");
  for (const S of [1, 10, 50, 100]) {
    const p = 1 - Math.pow(0.99, S);
    log(`   ${String(S).padStart(3)} shards → ${(p * 100).toFixed(1)}% of queries touch a slow shard`);
  }
  log("");
  log("More shards = better throughput but WORSE tail. Hedging and early termination");
  log("are how you claw p99 back. This is the defining operational fact of scatter-gather.");
  process.exit(0);
}

main();

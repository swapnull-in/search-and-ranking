/**
 * Phase 6 — TYPEAHEAD / AUTOCOMPLETE. Run: npm run phase6
 *
 * The suggestions under a search box must appear in <50ms while you type — far
 * too little time to run a search per keystroke. The trick: it's not a query-time
 * problem, it's a BUILD-TIME one. You precompute, for EVERY prefix, the top-K
 * completions ranked by popularity. At query time you do a single POINT LOOKUP
 * on the prefix — no ranking, no scan.
 *
 *   build time (expensive, offline): for each popular query, for each of its
 *     prefixes, record the query. Keep the top-K most popular per prefix.
 *   query time (cheap, online): suggestions = table[prefix]. Done.
 *
 * Trade space + build cost for query latency — exactly search's core move,
 * pushed to the extreme. Real systems layer more on top: the CLIENT is tier-zero
 * (debounce keystrokes, cache prefixes locally) and a TRENDING overlay mixes in
 * fresh-but-not-yet-popular queries (gated by k-distinct-users to prevent gaming).
 */

import { log } from "../lib/log.ts";

// Popular queries with their search volumes (what you'd mine from logs).
const QUERY_LOG: Array<[string, number]> = [
  ["red running shoes", 9000], ["red dress", 7000], ["red lipstick", 6500],
  ["running shoes men", 8000], ["running shorts", 3000], ["running watch", 2500],
  ["reebok shoes", 1800], ["red roses", 4000], ["rain jacket", 2200],
  ["running socks", 900], ["red backpack", 1500], ["red wine", 5000],
];

const K = 4;

/** Build time: prefix → top-K completions by popularity. */
function buildIndex(): Map<string, string[]> {
  const buckets = new Map<string, Array<[string, number]>>();
  for (const [query, freq] of QUERY_LOG) {
    for (let i = 1; i <= query.length; i++) {
      const prefix = query.slice(0, i);
      const arr = buckets.get(prefix) ?? [];
      arr.push([query, freq]);
      buckets.set(prefix, arr);
    }
  }
  // Keep only the top-K per prefix (this is the expensive offline step).
  const table = new Map<string, string[]>();
  for (const [prefix, arr] of buckets) {
    table.set(prefix, arr.sort((a, b) => b[1] - a[1]).slice(0, K).map(([q]) => q));
  }
  return table;
}

function main() {
  const table = buildIndex();
  log(`═══ Built prefix table: ${table.size} prefixes precomputed (offline) ═══`);
  log("");

  log("═══ Query time: each keystroke is one point lookup (no ranking) ═══");
  for (const prefix of ["r", "re", "red", "red ", "runn", "running s"]) {
    const suggestions = table.get(prefix) ?? [];
    log(`   "${prefix}"`.padEnd(16) + `→ ${suggestions.join("  ·  ") || "(no suggestions)"}`);
  }

  log("");
  log("Watch the list narrow as the prefix grows — and each lookup is O(1), just a");
  log("hash hit on the precomputed table. Nothing was ranked at query time.");
  log("");
  log("Production layers on top: the CLIENT debounces keystrokes and caches prefixes");
  log("(tier zero, zero server calls for repeats); a TRENDING lane injects fresh");
  log("queries the nightly build hasn't seen yet; and a k-distinct-users gate keeps");
  log("one person spamming a query from poisoning everyone's suggestions.");
  process.exit(0);
}

main();

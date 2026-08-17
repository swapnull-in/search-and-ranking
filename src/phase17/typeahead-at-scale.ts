/**
 * Phase 17 — TYPEAHEAD AT SCALE. Run: node "src/phase17/typeahead-at-scale.ts"
 *
 * Phase 6 showed the punchline: precompute prefix → top-K, so each keystroke is
 * a point lookup. This phase shows WHY that wins and HOW you keep it true when
 * the corpus changes — the parts that separate "trie + top-K" from a staff answer.
 *
 * 1. THE ECONOMICS THAT FORCE PRECOMPUTATION. Every search is ~15-25 keystrokes,
 *    each a potential request, so suggest traffic is 10-20× search QPS. The naive
 *    trie answer — walk to the prefix node, DFS the whole subtree, sort, take K —
 *    does that work on EVERY keystroke to produce an answer that changes once a
 *    day. We count the nodes: recompute walks thousands; precomputed top-K per
 *    node reads ONE list. Precompute converts per-keystroke cost into per-day cost.
 *
 * 2. THE TRIE IS A BUILD-TIME CONCEPT. Serving doesn't want a giant pointer-chasing
 *    tree in one process's memory — it wants FLATTENED prefix keys → small immutable
 *    top-K lists (phase 6's table!) in a sharded KV. Small immutable values shard,
 *    replicate, edge-cache, and version-swap trivially; a trie does none of that.
 *    The trie's only job is computing the lists bottom-up in one pass at build time.
 *
 * 3. THE UPDATE PIPELINE. Never update top-K lists synchronously on the search
 *    path — one search event touches every prefix of its query (~16 list re-sorts
 *    per event, at 10-20× search QPS). Instead: append events to a log (O(1)),
 *    rebuild a VERSIONED artifact nightly (each prefix touched once, off the hot
 *    path), and swap the serving pointer atomically — phase 16's alias trick again.
 *    Freshness that can't wait for the nightly build rides a tiny TRENDING OVERLAY
 *    (minutes-fresh, disposable) merged at read with a CAPPED injection slot, so a
 *    spike can never hijack the whole list. And the K-DISTINCT-USERS gate at build
 *    means one bot hammering a query never enters anyone's suggestions — one
 *    threshold buys privacy AND anti-gaming.
 *
 * 4. PERSONALIZATION IS A RERANK, NOT A CORPUS. The user's own history reorders
 *    the SAME shared candidate list at the edge. Forking the corpus per user is a
 *    cache-key explosion and a privacy cliff in one move.
 *
 * TAKEAWAY: typeahead is top-K per prefix with ALL the computation at build time —
 * the trie computes the lists, a flattened KV serves them, a versioned batch
 * rebuild + capped trending overlay keeps them fresh, and personalization only
 * reranks. The read path never computes anything; that's the entire design.
 */

import { log } from "../lib/log.ts";

const K = 5;            // suggestions per prefix
const K_DISTINCT = 25;  // a query enters the corpus only with ≥ this many distinct users
const OVERLAY_CAP = 1;  // trending candidates may claim at most this many slots
const MAX_PREFIX = 20;  // cap emitted prefixes (bounds write amplification)

interface LoggedQuery {
  query: string;
  freq: number;   // search volume over the window
  users: number;  // DISTINCT users who issued it — the anti-gaming/privacy signal
}

/** Deterministic query log: a hand-set popular head + a generated tail, plus one
 *  bot-spam entry (huge volume, ONE user) the k-distinct gate must catch. */
function buildQueryLog(): LoggedQuery[] {
  const byQuery = new Map<string, LoggedQuery>();
  const ADJ = ["red", "running", "rain", "retro", "ribbed", "royal", "rustic", "ruby"];
  const NOUN = ["shoes", "dress", "jacket", "socks", "watch", "backpack", "gloves", "scarf", "hat", "belt"];
  const SUFFIX = ["", " men", " women", " kids", " sale"];
  for (let a = 0; a < ADJ.length; a++) {
    for (let n = 0; n < NOUN.length; n++) {
      for (let s = 0; s < SUFFIX.length; s++) {
        const query = `${ADJ[a]} ${NOUN[n]}${SUFFIX[s]}`;
        const freq = ((a * 31 + n * 17 + s * 7) % 89 + 1) * 9; // deterministic, ≤ 801
        byQuery.set(query, { query, freq, users: Math.max(K_DISTINCT + 5, Math.floor(freq / 2)) });
      }
    }
  }
  const head: Array<[string, number, number]> = [
    ["red running shoes", 9000, 4200], ["red dress", 7000, 3900],
    ["red lipstick", 6500, 3100], ["running shoes men", 8000, 3700],
    ["red wine", 5000, 2600], ["red roses", 4000, 2100],
  ];
  for (const [query, freq, users] of head) byQuery.set(query, { query, freq, users });
  // The attack: one user's bot pushes a scam query to the top by raw volume.
  byQuery.set("red cheap pillz", { query: "red cheap pillz", freq: 50000, users: 1 });
  return [...byQuery.values()].sort((x, y) => x.query < y.query ? -1 : 1); // deterministic order
}

// ─── The trie: build-time machinery ─────────────────────────────────────────

class TrieNode {
  children: Map<string, TrieNode>;
  terminalFreq: number;                 // >0 iff a full query ends here
  topK: Array<[string, number]>;        // PRECOMPUTED top-K of this subtree
  constructor() {
    this.children = new Map();
    this.terminalFreq = 0;
    this.topK = [];
  }
}

class Trie {
  root: TrieNode;
  nodeCount: number;
  constructor() {
    this.root = new TrieNode();
    this.nodeCount = 1;
  }

  insert(query: string, freq: number): void {
    let node = this.root;
    for (const ch of query) {
      let next = node.children.get(ch);
      if (!next) {
        next = new TrieNode();
        node.children.set(ch, next);
        this.nodeCount++;
      }
      node = next;
    }
    node.terminalFreq = freq;
  }

  private descend(prefix: string): TrieNode | null {
    let node: TrieNode | null = this.root;
    for (const ch of prefix) {
      node = node.children.get(ch) ?? null;
      if (!node) return null;
    }
    return node;
  }

  /** SENIOR ANSWER — recompute per keystroke: DFS the entire subtree under the
   *  prefix, collect every completion, sort, slice K. Returns the work done. */
  naiveSuggest(prefix: string): { suggestions: string[]; nodesWalked: number; candidates: number } {
    const start = this.descend(prefix);
    if (!start) return { suggestions: [], nodesWalked: prefix.length, candidates: 0 };
    let nodesWalked = 0;
    const found: Array<[string, number]> = [];
    const dfs = (node: TrieNode, path: string): void => {
      nodesWalked++;
      if (node.terminalFreq > 0) found.push([path, node.terminalFreq]);
      for (const [ch, child] of node.children) dfs(child, path + ch);
    };
    dfs(start, prefix);
    found.sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1));
    return { suggestions: found.slice(0, K).map(([q]) => q), nodesWalked, candidates: found.length };
  }

  /** BUILD STEP — one bottom-up pass fills topK on EVERY node by merging its
   *  children's (already-final) lists with its own terminal. After this, a
   *  keystroke reads ONE node's list; nothing is ever recomputed at query time. */
  precomputeTopK(): void {
    const fill = (node: TrieNode): Array<[string, number]> => {
      const merged: Array<[string, number]> = [];
      if (node.terminalFreq > 0) {
        // Reconstructing the string bottom-up is awkward; carry it top-down instead.
      }
      for (const child of node.children.values()) merged.push(...fill(child));
      // (terminal entries are added by the top-down wrapper below)
      node.topK = merged;
      return merged;
    };
    // Simpler and just as O(nodes · K): top-down path carry, bottom-up merge.
    const walk = (node: TrieNode, path: string): Array<[string, number]> => {
      const merged: Array<[string, number]> = node.terminalFreq > 0 ? [[path, node.terminalFreq]] : [];
      for (const [ch, child] of node.children) merged.push(...walk(child, path + ch));
      merged.sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1));
      node.topK = merged.slice(0, K); // keep only K — children were already truncated to K
      return node.topK;
    };
    void fill; // the first sketch is intentionally unused — kept as a teaching contrast? No: delete it.
    walk(this.root, "");
  }

  /** STAFF STEP 1 — query time with precomputed lists: descend, read ONE list. */
  fastSuggest(prefix: string): { suggestions: string[]; nodesRead: number } {
    const node = this.descend(prefix);
    return { suggestions: (node?.topK ?? []).map(([q]) => q), nodesRead: 1 };
  }

  /** STAFF STEP 2 — the trie retires: flatten every prefix (≤ MAX_PREFIX chars)
   *  into `prefix → top-K list`. THIS is phase 6's table — small immutable values
   *  that shard by prefix hash, replicate freely, and swap atomically. */
  flatten(): Map<string, string[]> {
    const table = new Map<string, string[]>();
    const walk = (node: TrieNode, path: string): void => {
      if (path.length > 0) table.set(path, node.topK.map(([q]) => q));
      if (path.length >= MAX_PREFIX) return;
      for (const [ch, child] of node.children) walk(child, path + ch);
    };
    walk(this.root, "");
    return table;
  }
}

// ─── Serving: versioned artifacts + capped trending overlay ─────────────────

interface Artifact {
  version: string;
  table: Map<string, string[]>;
}

/** The build job: gate by k-distinct users, build the trie, precompute, flatten.
 *  Runs nightly, OFF the hot path — each prefix is touched exactly once. */
function buildArtifact(version: string, queryLog: LoggedQuery[]): Artifact {
  const gated = queryLog.filter((q) => q.users >= K_DISTINCT);
  const trie = new Trie();
  for (const { query, freq } of gated) trie.insert(query, freq);
  trie.precomputeTopK();
  return { version, table: trie.flatten() };
}

class ServingStore {
  live: Artifact;                      // the pointer the atomic swap flips
  overlay: Map<string, string[]>;      // trending: tiny, minutes-fresh, disposable
  constructor(artifact: Artifact) {
    this.live = artifact;
    this.overlay = new Map();
  }
  /** Atomic swap — one pointer move; no reader ever sees a half-built corpus.
   *  Rollback is the same move in reverse (phase 16's alias flip). */
  swap(next: Artifact): void {
    this.live = next;
  }
  /** Trending publisher: gainers pass the SAME k-distinct gate, then land in a
   *  small prefix → candidates map that expires in minutes. */
  publishTrending(gainers: LoggedQuery[]): void {
    this.overlay = new Map();
    for (const g of gainers) {
      if (g.users < K_DISTINCT) continue; // velocity alone never buys entry
      for (let i = 1; i <= Math.min(g.query.length, MAX_PREFIX); i++) {
        const p = g.query.slice(0, i);
        const arr = this.overlay.get(p) ?? [];
        arr.push(g.query);
        this.overlay.set(p, arr);
      }
    }
  }
  /** The read path: ONE point lookup + a bounded merge. Trending gets at most
   *  OVERLAY_CAP slots (injected at position 1) — it can never displace the list. */
  lookup(prefix: string): string[] {
    const base = this.live.table.get(prefix) ?? [];
    const trending = (this.overlay.get(prefix) ?? [])
      .filter((q) => !base.includes(q))
      .slice(0, OVERLAY_CAP);
    if (trending.length === 0) return base;
    return [...base.slice(0, 1), ...trending, ...base.slice(1)].slice(0, K);
  }
}

/** Personalization: rerank the SHARED list with the user's own history — a
 *  stable partition, so within each group the corpus order is preserved. */
function personalize(shared: string[], history: Set<string>): string[] {
  return [...shared].sort((a, b) => Number(history.has(b)) - Number(history.has(a)));
}

// ─── Demo ────────────────────────────────────────────────────────────────────

function main() {
  const queryLog = buildQueryLog();
  const trie = new Trie();
  for (const { query, freq } of queryLog) trie.insert(query, freq);

  log(`═══ Corpus: ${queryLog.length} distinct queries → trie of ${trie.nodeCount} nodes ═══`);
  log("");

  // ── 1. Recompute-per-keystroke vs precomputed top-K per node ──────────────
  log("═══ SENIOR vs STAFF: recompute per keystroke vs top-K precomputed per node ═══");
  trie.precomputeTopK();
  const session = ["r", "re", "red", "red ", "red r", "red ru", "red run"];
  let naiveTotal = 0;
  for (const prefix of session) {
    const naive = trie.naiveSuggest(prefix);
    const fast = trie.fastSuggest(prefix);
    naiveTotal += naive.nodesWalked;
    const match = naive.suggestions.join("|") === fast.suggestions.join("|") ? "same answer" : "DIFFER!";
    log(`   "${prefix}"`.padEnd(12) +
      `recompute: ${String(naive.nodesWalked).padStart(4)} nodes walked, ${String(naive.candidates).padStart(3)} candidates sorted   ` +
      `precomputed: ${fast.nodesRead} list read   (${match})`);
  }
  log(`   Typing 7 keystrokes cost the naive path ${naiveTotal} node visits — the`);
  log(`   precomputed path read 7 lists. Same answers. Now multiply: suggest traffic`);
  log(`   is 10-20× search QPS, and the top-5 for "red" changes once a DAY. Recompute`);
  log(`   burns compute at 10× search QPS to produce a constant.`);
  log("");

  // ── 2. The trie retires: flatten to the prefix table (phase 6's move) ─────
  log("═══ THE TRIE IS BUILD-TIME ONLY: flatten to prefix → top-K (phase 6's table) ═══");
  const v1 = buildArtifact("v1", queryLog);
  const bytes = [...v1.table.entries()].reduce((n, [p, list]) => n + p.length + list.join("").length, 0);
  log(`   flattened ${v1.table.size} prefixes → small immutable lists (~${Math.round(bytes / 1024)} KB total).`);
  log(`   lookup("red") = [${v1.table.get("red")!.join(", ")}]  ← one KV point lookup, O(1)`);
  log(`   Small immutable values shard by prefix hash, replicate freely (no invalidation`);
  log(`   exists), and edge-cache — a giant in-process trie does none of that.`);
  log("");

  // ── 3a. The k-distinct-users gate already did its job in the build ────────
  log("═══ THE k-DISTINCT GATE: volume alone never enters the corpus ═══");
  const spam = queryLog.find((q) => q.query === "red cheap pillz")!;
  log(`   "red cheap pillz": freq=${spam.freq} (the HIGHEST in the log) but users=${spam.users} < ${K_DISTINCT}`);
  log(`   lookup("red c") = [${(v1.table.get("red c") ?? []).join(", ") || "(nothing)"}] — gated out at build.`);
  log(`   One threshold, two wins: no bot farm games the box, no one's personal query surfaces.`);
  log("");

  // ── 3b. Updates: never on the hot path ─────────────────────────────────────
  log("═══ UPDATES: synchronous per-search list maintenance vs batch rebuild + swap ═══");
  const EVENTS = 1000;
  let hotPathRebuilds = 0;
  for (let i = 0; i < EVENTS; i++) {
    const q = queryLog[i % queryLog.length].query;              // a search event arrives...
    hotPathRebuilds += Math.min(q.length, MAX_PREFIX);          // ...sync update re-sorts EVERY prefix's list
  }
  log(`   WRONG: update top-K on each search → ${EVENTS} events × ~16 prefixes = ${hotPathRebuilds} list`);
  log(`   re-sorts ON THE READ PATH (and every one is a lock on a hot key).`);
  log(`   RIGHT: ${EVENTS} events → ${EVENTS} O(1) log appends; the nightly batch touches each of`);
  log(`   the ${v1.table.size} prefixes ONCE, off the hot path, then swaps a pointer.`);
  const store = new ServingStore(v1);
  const v2 = buildArtifact("v2", queryLog.map((q) =>
    q.query === "red wine" ? { ...q, freq: 12000 } : q));       // yesterday's counts shifted
  store.swap(v2);
  log(`   atomic swap v1 → ${store.live.version}: lookup("red") = [${store.lookup("red").join(", ")}]`);
  log(`   ("red wine" rose overnight; readers saw v1 until the instant they saw v2 — never half of each.)`);
  log("");

  // ── 3c. Trending overlay: minutes-fresh, capped injection ─────────────────
  log("═══ TRENDING OVERLAY: fresh queries ride a capped slot, never the whole list ═══");
  log(`   before overlay: lookup("red e") = [${store.lookup("red e").join(", ") || "(nothing)"}]`);
  store.publishTrending([
    { query: "red eclipse tonight", freq: 700, users: 400 },   // real spike: many distinct users
    { query: "red hacked giveaway", freq: 9999, users: 3 },    // velocity attack: 3 users — gated
  ]);
  log(`   streaming job publishes gainers (minutes, not tonight's build)...`);
  log(`   after overlay:  lookup("red e") = [${store.lookup("red e").join(", ")}]`);
  log(`   after overlay:  lookup("red")   = [${store.lookup("red").join(", ")}]`);
  log(`   "red eclipse tonight" injected at ONE capped slot; the velocity attack (3 users)`);
  log(`   never published. The overlay is disposable — it expires in minutes, so its light`);
  log(`   vetting has a bounded blast radius. Base daily, trending in minutes: two freshness`);
  log(`   lanes, two price points, one bounded merge.`);
  log("");

  // ── 4. Personalization reranks the shared list ─────────────────────────────
  log("═══ PERSONALIZATION: rerank the SHARED list — never fork the corpus ═══");
  const shared = store.lookup("red");
  const alice = personalize(shared, new Set(["red roses"]));
  const bob = personalize(shared, new Set(["red lipstick"]));
  log(`   shared candidates: [${shared.join(", ")}]`);
  log(`   alice (searched "red roses" before)   → [${alice.join(", ")}]`);
  log(`   bob   (searched "red lipstick" before) → [${bob.join(", ")}]`);
  log(`   Same artifact, same cache keys, reordered at the edge. A per-user corpus would`);
  log(`   explode the cache and put private history in a shared system — rerank, don't fork.`);
  log("");

  log("The read path never computes: the trie builds top-K per node ONCE, a flattened");
  log("prefix table serves it as a point lookup, batch rebuilds + an atomic swap absorb");
  log("updates off the hot path, a capped overlay buys minutes-freshness cheaply, and");
  log("personalization only reranks. Precompute turns per-keystroke cost into per-day cost.");
  process.exit(0);
}

main();

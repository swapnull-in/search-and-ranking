/**
 * Phase 16 — ZERO-DOWNTIME REINDEXING WITH INDEX ALIASES. Run: npm run phase16
 *
 * Some things about a search index are POURED IN CONCRETE at creation time: the
 * mapping (field types), the analyzers (how text is tokenized/stemmed), and the
 * PRIMARY SHARD COUNT. You cannot change them in place — the on-disk data was
 * routed and tokenized under the old rules. To "change" them you must build a
 * NEW index with the new rules and copy every doc into it (a full REINDEX).
 *
 * So how do you swap indexes under a live app without a single failed query?
 * You never let the app touch a physical index. It queries an ALIAS — a mutable
 * name→index pointer. That indirection turns an impossible-in-place change into
 * a BLUE-GREEN DEPLOY:
 *
 *   1. Build products_v2 with the new mapping/shards (green), app still on v1 (blue).
 *   2. Backfill v1→v2, and REPLAY the change-log so v2 catches up to live writes.
 *   3. Validate counts match.
 *   4. Atomically repoint the alias v1→v2 — instant, no query sees a gap.
 *   5. If relevance regresses, flip the alias back to v1 — instant rollback.
 *
 * Routing makes the immutability concrete: a doc lives on shard hash(id) % N.
 * Change N and EVERY doc's home shard moves — that's why a shard-count change is
 * a full reindex, and why shard count is a day-1 decision.
 *
 * MONEY QUOTE: aliases turn an impossible-in-place change (immutable mappings/
 * shards) into a blue-green deploy — build v2, replay into it, swap the alias
 * atomically, and flip back instantly if relevance regresses.
 */

import { CORPUS, analyze } from "../lib/corpus.ts";
import { log } from "../lib/log.ts";

/** Tiny deterministic string hash: sum of char codes. No Math.random/Date.now —
 *  routing MUST be reproducible so the same id always lands on the same shard. */
function hash(id: string): number {
  let h = 0;
  for (const ch of id) h += ch.charCodeAt(0);
  return h;
}

interface StoredDoc { id: string; text: string }

/** A physical index: immutable mapping (analyzer + shard count) and docs bucketed
 *  by shard via hash(id) % numShards. Building a new one is the only way to change
 *  numShards or the analyzer. */
class Index {
  readonly name: string;
  readonly numShards: number;
  readonly analyzer: string;
  readonly shards: StoredDoc[][];
  constructor(name: string, numShards: number, analyzer: string) {
    this.name = name;
    this.numShards = numShards;
    this.analyzer = analyzer;
    this.shards = Array.from({ length: numShards }, () => []);
  }
  route(id: string): number {
    return hash(id) % this.numShards;
  }
  put(doc: StoredDoc): void {
    this.shards[this.route(doc.id)].push(doc);
  }
  count(): number {
    return this.shards.reduce((n, s) => n + s.length, 0);
  }
  /** Boolean-AND query over the analyzed terms, scattered across all shards. */
  query(text: string): string[] {
    const terms = analyze(text);
    const hits: string[] = [];
    for (const shard of this.shards) {
      for (const doc of shard) {
        const bag = new Set(analyze(doc.text));
        if (terms.every((t) => bag.has(t))) hits.push(doc.id);
      }
    }
    return hits.sort();
  }
}

/** The alias layer: the app ONLY ever knows names like "products", never v1/v2. */
const aliases = new Map<string, Index>();
const resolve = (alias: string): Index => aliases.get(alias)!;

function shardMap(idx: Index): string {
  return idx.shards
    .map((s, i) => `s${i}=[${s.map((d) => d.id).join(",")}]`)
    .join("  ");
}

function main() {
  // ─── Day 1: the app is wired to an ALIAS, never the physical index ─────────
  const v1 = new Index("products_v1", 2, "standard");
  for (const doc of CORPUS) v1.put({ id: `p${doc.id}`, text: doc.text });
  aliases.set("products", v1);

  log("═══ App queries the ALIAS \"products\" (points at products_v1, 2 shards) ═══");
  log(`   physical target: ${resolve("products").name}  |  ${shardMap(v1)}`);
  log(`   query "running shoes" → docs [${resolve("products").query("running shoes").join(", ")}]`);
  log("   The app NEVER names products_v1. That indirection is the whole trick.");

  // ─── Routing: why a shard-count change re-homes every doc ──────────────────
  log("");
  log("═══ ROUTING: shard = hash(id) % N. Change N and every doc moves ═══");
  for (const id of ["p1", "p2", "p3", "p6", "p7"]) {
    log(`   ${id}: hash=${String(hash(id)).padStart(4)}  → N=2 shard ${hash(id) % 2}   N=4 shard ${hash(id) % 4}`);
  }
  log("   Different N → different home shard for the SAME id → data must be rewritten.");

  // ─── Build v2 (green) with the NEW mapping: 2 → 4 shards ────────────────────
  log("");
  log("═══ Need 2→4 shards (immutable!). Build products_v2 with the NEW mapping ═══");
  const v2 = new Index("products_v2", 4, "standard");
  log(`   created ${v2.name} (numShards=4). App still served by v1 — zero disruption.`);

  // ─── Backfill + replay the change-log so v2 stays current in the window ─────
  log("");
  log("═══ BACKFILL v1→v2 (re-route by hash % 4) + REPLAY live writes into v2 ═══");
  for (const shard of v1.shards) for (const doc of shard) v2.put(doc);
  log(`   backfilled ${v2.count()} docs from v1 → v2 (${shardMap(v2)})`);

  // Live writes arriving DURING the migration window. The clean pattern is to
  // replay the change-log into v2 — but v1 is still the alias target, so those
  // writes must also land in v1 (the app's current index) until we swap.
  const liveWrites: StoredDoc[] = [
    { id: "p9", text: "Waterproof trail running gaiters, lightweight" },
    { id: "p10", text: "Red running cap, breathable mesh for men" },
  ];
  for (const doc of liveWrites) {
    resolve("products").put(doc); // hits v1 — the app's current world
    v2.put(doc);                  // replayed into v2 so it doesn't fall behind
    log(`   write ${doc.id} → landed in BOTH v1 (alias target) and v2 (replay), shard ${v1.route(doc.id)}/${v2.route(doc.id)}`);
  }

  // ─── Validate before flipping ──────────────────────────────────────────────
  log("");
  log("═══ VALIDATE: counts must match before we trust v2 ═══");
  log(`   v1=${v1.count()} docs   v2=${v2.count()} docs   → ${v1.count() === v2.count() ? "MATCH ✓" : "MISMATCH ✗"}`);

  // ─── The atomic swap: one pointer move, no query sees a gap ─────────────────
  log("");
  log("═══ ATOMIC SWAP: repoint alias products v1 → v2 in ONE action ═══");
  aliases.set("products", v2);
  log(`   alias "products" now → ${resolve("products").name}  |  ${shardMap(v2)}`);
  log(`   same query "running shoes" → docs [${resolve("products").query("running shoes").join(", ")}]`);
  log("   No connection drained, no request queued — the pointer flip is instant.");

  // ─── Rollback is free: flip the alias back to v1 ───────────────────────────
  log("");
  log("═══ ROLLBACK is trivial: relevance regressed? flip the alias back to v1 ═══");
  aliases.set("products", v1);
  log(`   alias "products" back → ${resolve("products").name} (blue-green reversibility)`);
  aliases.set("products", v2); // ...but we're happy with v2, so re-commit to it.
  log(`   re-committed to ${resolve("products").name}; now drop the old index.`);

  // Drop v1 only AFTER the alias no longer points at it.
  log(`   DROP products_v1 — safe, nothing references it anymore.`);

  log("");
  log("Point apps at an ALIAS from day one — it's free insurance you'll want later.");
  log("Backfill by REPLAYING the change-log into v2, not by hoping dual-writes align.");
  log("The alias swap is atomic AND reversible; immutable mappings stop being scary.");
  log("But primary shard count is still a DAY-1 decision: changing it means a full");
  log("reindex, because hash(id) % N re-homes every single document.");
  process.exit(0);
}

main();

/**
 * Phase 13 — IMMUTABLE SEGMENTS & FRESHNESS: "why isn't my write in search yet?"
 * Run: node "src/phase13/segments-freshness.ts"
 *
 * A Lucene-style index is not one mutable file you edit in place. It is a stack of
 * IMMUTABLE SEGMENTS — each a tiny frozen inverted index — plus a write path that
 * decides WHEN a new doc becomes visible to search. That timing is the whole game:
 *
 *   WRITE   → the doc lands in an in-memory BUFFER and a durable TRANSLOG
 *             (write-ahead log). It is safe on disk immediately, but NOT searchable.
 *   REFRESH → (default ~1s) the buffer is sealed into a new immutable SEGMENT.
 *             ONLY NOW does search() see the doc. This is why search is
 *             NEAR-real-time, not real-time.
 *   UPDATE  → segments never change in place, so you can't edit a doc. You mark the
 *             old copy DELETED in a .del bitset (a "tombstone") and index the new
 *             version into a new segment. Every update = one tombstone + one reindex.
 *   MERGE   → many small segments are combined into a big one, and tombstoned docs
 *             are physically PURGED. Reclaims space; costs CPU/IO.
 *
 * GET-by-id is real-time (it can read the buffer/translog); SEARCH is not. So the
 * eternal bug report — "I just wrote it and search can't find it!" — is almost never
 * a bug. It's the refresh interval plus segment immutability, working as designed.
 *
 * The corollary bites harder: a high-churn field (a live view counter, an inventory
 * quantity) is HOSTILE to immutable segments, because every tick is a delete-tombstone
 * + reindex that piles up dead docs and thrashes the merge scheduler. Keep the
 * counter in a real store; keep the search doc as still as you can.
 */

import { analyze } from "../lib/corpus.ts";
import { log } from "../lib/log.ts";

interface Doc { id: number; text: string }

/** An immutable segment: a frozen mini inverted index + its own tombstone bitset.
 *  Once sealed, its docs and postings never change — deletes only flip a .del bit. */
class Segment {
  readonly seq: number;
  readonly docs = new Map<number, Doc>();          // docId → doc (frozen at seal time)
  readonly postings = new Map<string, Set<number>>(); // term → docIds in THIS segment
  readonly deleted = new Set<number>();            // .del bitset: tombstoned docIds

  constructor(seq: number, docs: Doc[]) {
    this.seq = seq;
    for (const doc of docs) {
      this.docs.set(doc.id, doc);
      for (const term of analyze(doc.text)) {
        (this.postings.get(term) ?? this.postings.set(term, new Set()).get(term)!).add(doc.id);
      }
    }
  }

  liveCount() { return this.docs.size - this.deleted.size; }
}

class Engine {
  private buffer: Doc[] = [];          // written but not yet refreshed — durable, not searchable
  private translog: Doc[] = [];        // write-ahead log: replayed on crash (here: real-time GET source)
  private segments: Segment[] = [];    // the searchable index: a stack of immutable segments
  private nextSeq = 1;

  /** WRITE: land the doc in the buffer + translog. Durable now, searchable after refresh. */
  write(doc: Doc) {
    this.buffer.push(doc);
    this.translog.push(doc);
  }

  /** REFRESH (~1s in prod): seal the buffer into a new immutable segment.
   *  This is the exact moment newly-written docs become visible to search(). */
  refresh() {
    if (this.buffer.length === 0) return;
    this.segments.push(new Segment(this.nextSeq++, this.buffer));
    this.buffer = [];
  }

  /** DELETE: you can't erase a doc from a frozen segment — flip its .del bit instead.
   *  The doc still occupies space until a merge purges it. */
  delete(id: number): boolean {
    for (const seg of this.segments) {
      if (seg.docs.has(id) && !seg.deleted.has(id)) { seg.deleted.add(id); return true; }
    }
    // Not yet refreshed? Drop it from the buffer/translog directly.
    const before = this.buffer.length;
    this.buffer = this.buffer.filter((d) => d.id !== id);
    this.translog = this.translog.filter((d) => d.id !== id);
    return this.buffer.length !== before;
  }

  /** UPDATE = delete-tombstone the old copy + write the new version. Two ops, always.
   *  It takes a refresh() before the new text is searchable, just like any write. */
  update(id: number, doc: Doc) {
    this.delete(id);
    this.write(doc);
  }

  /** SEARCH: near-real-time. Only sees SEGMENTS (post-refresh), skips tombstoned docs.
   *  The buffer/translog are invisible here — that's the "search lag". */
  search(term: string): number[] {
    const q = analyze(term)[0];
    const hits: number[] = [];
    for (const seg of this.segments) {
      for (const id of seg.postings.get(q) ?? []) {
        if (!seg.deleted.has(id)) hits.push(id);
      }
    }
    return hits.sort((a, b) => a - b);
  }

  /** GET-by-id: real-time. Reads live segments first, then falls back to the
   *  buffer/translog — so a just-written doc is fetchable before it's searchable. */
  getById(id: number): Doc | null {
    for (const seg of this.segments) {
      if (seg.docs.has(id) && !seg.deleted.has(id)) return seg.docs.get(id)!;
    }
    for (let i = this.buffer.length - 1; i >= 0; i--) {
      if (this.buffer[i].id === id) return this.buffer[i];
    }
    return null;
  }

  /** MERGE: fold all segments into one, physically dropping tombstoned docs.
   *  Space reclaimed, tombstones gone — at the cost of rebuilding the index. */
  merge() {
    if (this.segments.length <= 1 && this.deletedCount() === 0) return;
    const live: Doc[] = [];
    for (const seg of this.segments) {
      for (const [id, doc] of seg.docs) if (!seg.deleted.has(id)) live.push(doc);
    }
    this.segments = live.length ? [new Segment(this.nextSeq++, live)] : [];
  }

  segmentCount() { return this.segments.length; }
  deletedCount() { return this.segments.reduce((n, s) => n + s.deleted.size, 0); }
  liveCount() { return this.segments.reduce((n, s) => n + s.liveCount(), 0); }

  /** One-line churn snapshot: segments / live docs / accumulated tombstones. */
  stats(label: string) {
    log(
      `   [stats ${label}] segments=${this.segmentCount()}` +
      `  live=${this.liveCount()}  tombstones=${this.deletedCount()}` +
      `  buffered=${this.buffer.length}`,
    );
  }
}

function main() {
  const engine = new Engine();

  // ─── 1) WRITE → durable but not searchable (the search-lag / NRT gap) ───────
  log('═══ 1) write doc 1 ("red running shoes") — then look for it before refresh ═══');
  engine.write({ id: 1, text: "Red running shoes for men, lightweight" });
  log(`   search("running") → [${engine.search("running").join(", ")}]  ← EMPTY: not refreshed yet`);
  log(`   getById(1)        → ${engine.getById(1) ? '"' + engine.getById(1)!.text + '"' : "null"}  ← real-time GET already sees it`);
  engine.stats("after write");

  // ─── 2) REFRESH → the doc becomes searchable ────────────────────────────────
  log("");
  log("═══ 2) refresh() — seal the buffer into an immutable segment (~1s in prod) ═══");
  engine.refresh();
  log(`   search("running") → [${engine.search("running").join(", ")}]  ← now visible`);
  engine.stats("after refresh");

  // ─── 3) Add more docs, then CHURN one doc via repeated updates + a delete ────
  log("");
  log("═══ 3) write docs 2 & 3, refresh, then update doc 1 three times + delete doc 3 ═══");
  engine.write({ id: 2, text: "Blue running shoes women, marathon trainers" });
  engine.write({ id: 3, text: "Trail running vest with hydration bladder" });
  engine.refresh();
  engine.stats("3 docs, refreshed");

  // Each update = tombstone the old copy + index the new one, then refresh to publish.
  for (let v = 2; v <= 4; v++) {
    engine.update(1, { id: 1, text: `Red running shoes v${v}, lightweight` });
    engine.refresh();
    log(`   update doc 1 → v${v}: every update is a delete-tombstone + a reindex into a NEW segment`);
    engine.stats(`after v${v}`);
  }

  engine.delete(3);
  log("   delete doc 3 → flips its .del bit; the doc still occupies segment space");
  engine.stats("after delete 3");
  log(`   search("running") → [${engine.search("running").join(", ")}]  ← only LIVE docs (old doc-1 copies + doc 3 skipped)`);

  // ─── 4) MERGE → segment count collapses, tombstones purged ───────────────────
  log("");
  log("═══ 4) merge() — combine segments into one and physically purge tombstones ═══");
  log(`   before merge: segments=${engine.segmentCount()}  tombstones=${engine.deletedCount()}`);
  engine.merge();
  log(`   after  merge: segments=${engine.segmentCount()}  tombstones=${engine.deletedCount()}  ← space reclaimed`);
  engine.stats("after merge");
  log(`   search("running") → [${engine.search("running").join(", ")}]  ← same live results, far less dead weight`);

  // ─── Takeaway ────────────────────────────────────────────────────────────────
  log("");
  log('"Why isn\'t my just-written doc in search?" is almost never a bug — it\'s the refresh');
  log("interval plus segment immutability. GET-by-id is real-time; SEARCH is near-real-time,");
  log("visible only after the next refresh seals the buffer into a segment. And notice the");
  log("churn: three updates to ONE doc left four dead tombstones and a stack of tiny segments");
  log("until merge swept them up. That is why a live counter or inventory quantity is hostile");
  log("to immutable segments — every tick is a delete + reindex that thrashes merges. Keep");
  log("high-churn values in a real store; keep the search doc as still as you can.");
  process.exit(0);
}

main();

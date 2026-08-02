import type { BulkHost } from './types'

/** How long `changed` events coalesce into one broadcast while a bulk write is in
 *  flight. A bulk import lands thousands of notes; emitting a `changed` per
 *  note fans every one out to every SSE subscriber of the space (other users'
 *  tabs), each re-arming their refetch debounces — a broadcast storm over chatty
 *  state nobody re-reads per note. Buffering the upsert/removed ids and flushing
 *  one merged `changed` this often keeps the tree/feed live without the per-note
 *  fan-out. The client already throttles graph/list refetches above this. */
const BULK_EMIT_COALESCE_MS = 300

/** The bulk-write bracket: a streaming import brackets its whole run
 *  with begin/end so background work cooperatively yields to interactive requests.
 *  While active it coalesces `changed` emits into one merged broadcast on a timer,
 *  pauses the engine's embedding, and marks the process-global scheduler busy.
 *  Re-entrant (a depth counter) so nested brackets behave.
 *  @see docs/core.md#cooperative */
export class BulkController {
  private depth = 0
  private buffer: { upserts: Set<string>; removed: Set<string> } | null = null
  private flushTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly host: BulkHost) {}

  /** Non-null buffer ⇔ in bulk mode — the mode flag the emit/poll/graph-refresh
   *  paths consult. */
  get isActive(): boolean {
    return this.buffer != null
  }

  /** Enter bulk-write mode. Re-entrant. Pauses the engine's embedding
   *  backfill (duck-typed — a vector-less engine has nothing to pause) and starts
   *  coalescing `changed`. */
  begin(): void {
    this.depth++
    // Mark busy on the PROCESS-GLOBAL scheduler, ONE enter per begin call
    // (balanced 1:1 by end's exit) so the count tracks depth exactly — a re-entrant
    // import never leaks or under-counts. suspendBackground only pauses THIS space's
    // loop; this is what makes the import's shared-core burn slow the embed backfill
    // in OTHER spaces too.
    this.host.scheduler?.enterInteractive()
    if (this.depth > 1) {
      return
    }
    this.buffer = { upserts: new Set(), removed: new Set() }
    this.host.suspendBackground()
  }

  /** Leave bulk-write mode: flush the coalesced `changed` (ids durable first), and
   *  resume background embeds (now drains the whole burst, yielding). Idempotent
   *  past depth 0. */
  async end(): Promise<void> {
    if (this.depth === 0) {
      return
    }
    this.depth--
    // Balance begin's enter, ONE per end that actually decremented — so the
    // scheduler's interactive count returns to 0 exactly when the last bracket
    // closes, even under a re-entrant import.
    this.host.scheduler?.exitInteractive()
    if (this.depth > 0) {
      return
    }
    // Flush the coalesced tail: identity durable, then the final `changed`. A belt
    // flushIdentity too (broadcast no-ops the dispatch on an empty buffer, but a
    // dirty id with no pending event must still land).
    await this.broadcast()
    await this.host.flushIdentity()
    // Re-entrancy guard: a concurrent import may have re-opened bulk while we awaited
    // above (its begin ran in the gap, re-arming the buffer + suspend). Leave
    // teardown to ITS end — resuming/polling now would stomp its suspend and run its
    // catch-up under an active bulk.
    if (this.depth > 0) {
      return
    }
    this.buffer = null
    this.host.resumeBackground()
    // One catch-up delta poll now the burst is over: advances the cursor past our
    // own write-through stream and reconciles anything that slipped (external edits
    // we deferred). It re-arms the graph refresh itself if the delta moved.
    this.host.poll()
    // The graph went stale many times over during the import but we suppressed
    // re-enrichment (a no-op under bulk). Kick the single catch-up pass now that
    // the burst is over.
    this.host.refreshGraph()
  }

  /** Coalesce a `changed` into the bulk buffer instead of fanning it out.
   *  A note upserted then removed within the window nets out; a note upserted twice
   *  collapses to one id. Returns true when absorbed (in bulk mode) — the caller
   *  then skips its own dispatch. */
  absorb(upserts: readonly string[], removed: readonly string[]): boolean {
    if (!this.buffer) {
      return false
    }
    for (const u of upserts) {
      this.buffer.removed.delete(u)
      this.buffer.upserts.add(u)
    }
    for (const r of removed) {
      this.buffer.upserts.delete(r)
      this.buffer.removed.add(r)
    }
    this.scheduleFlush()
    return true
  }

  /** Force cleanup (the store's stop() mid-import): drop the pending coalesce timer
   *  and buffer so a late flush can't dispatch to torn-down listeners, and release
   *  any interactive marks still held so the global scheduler count returns to 0. */
  teardown(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
    }
    this.flushTimer = null
    this.buffer = null
    for (let i = 0; i < this.depth; i++) {
      this.host.scheduler?.exitInteractive()
    }
    this.depth = 0
  }

  /** Make the buffered notes' ids durable in the meta-DB BEFORE the coalesced
   *  `changed` tells clients they exist. The broadcast is the first signal a
   *  client gets, and the host's resolveNote reads the meta-DB — without the flush
   *  first, a click on a just-imported note races to a 404 until the next settle. */
  private async broadcast(): Promise<void> {
    await this.host.flushIdentity()
    this.flush()
  }

  /** Broadcast the buffered bulk `changed` as one merged event. Folders are
   *  recomputed fresh over the accumulated upserts at flush time. */
  private flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    const buf = this.buffer

    if (!buf || (!buf.upserts.size && !buf.removed.size)) {
      return
    }
    const upserts = [...buf.upserts]
    const removed = [...buf.removed]
    buf.upserts.clear()
    buf.removed.clear()
    this.host.dispatchChanged(upserts, removed, this.host.foldersOf(upserts))
  }

  private scheduleFlush(): void {
    if (this.flushTimer) {
      return
    }
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      void this.broadcast()
    }, BULK_EMIT_COALESCE_MS)
    this.flushTimer.unref?.()
  }
}

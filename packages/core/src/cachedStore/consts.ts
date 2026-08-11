// Read-model mutation namespace and background-loop cadences.
// canon: docs/core.md#write-through · docs/core.md#cooperative

export const TRASH_MUTATION_PREFIX = '\0trash'
export const trashMutationPath = (noteId: string): string => `${TRASH_MUTATION_PREFIX}/${noteId}`

export const RECONCILE_DELAY_MS = 1_500

/** The cap on the periodic reconcile cadence when NO watcher is engaged:
 *  even if the operator raised SYNC_POLL_SECONDS (to make the WATCHED backstop
 *  rare), a host that can't watch must keep polling at least this often so an
 *  external edit on a network mount / inotify-exhausted box stays as responsive
 *  as it was before this feature. With a watcher engaged, SYNC_POLL_SECONDS is
 *  used verbatim as the rare backstop (the watcher is the fast path). */
export const RESPONSIVE_POLL_MS = 60_000

/** How long after the last snapshot change the background graph re-enrichment
 *  starts — while the engine is actively indexing, a delta lands every poll,
 *  and the expensive communities+layout pass must chase the snapshot from the
 *  background (debounced), never from the request path (SWR). */
export const GRAPH_REFRESH_DEBOUNCE_MS = 2_000

/** How often, at most, an embed-backfill progress frame goes out. The
 *  engine's embed loop can (re)embed several notes a second when the box is quiet,
 *  and each fans a `status` frame to every SSE subscriber of the space — the same
 *  storm shape the bulk-coalesce bounds for `changed`. A trailing throttle at this
 *  cadence keeps the "1240/2681" counter visibly moving without flooding the wire;
 *  the frame reads the LATEST counters, so coalescing loses nothing but intermediate
 *  values, and the drain's final frame (pending 0) still lands. */
export const INDEX_PROGRESS_THROTTLE_MS = 500

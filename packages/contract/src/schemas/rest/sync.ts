import { z } from 'zod'
import { STORE_EVENT } from '../../consts/events'
import { INDEXING_STATE, SCAN_PHASE, VECTOR_MODE } from '../../consts/sync'
import { enumValues } from '../../libs/enumValues'
import { IsoTimestampSchema } from '../primitives'

/** Read-model lifecycle: `cold` = boot scan not started; `notes` = inventory
 *  loaded, graph edges still sweeping; `ready` = snapshot complete; `error` =
 *  boot scan failed (message in scan.error). A live store with no cache layer
 *  (e2e fake) reports `ready` from the start. */
export const ScanPhaseSchema = z.enum(enumValues(SCAN_PHASE))

/** files → engine indexing state: 'idle'/'busy' when the engine reports
 *  progress, 'unknown' when it can't and the read-model falls back to a heuristic. */
export const IndexingStateSchema = z.enum(enumValues(INDEXING_STATE))

export const SyncStatusSchema = z.object({
  /** Our scan: engine → read-model snapshot. */
  scan: z.object({
    phase: ScanPhaseSchema,
    startedAt: IsoTimestampSchema,
    readyAt: IsoTimestampSchema,
    error: z.string().nullable(),
  }),
  /** External-change feed. `intervalMs` = polling interval (0 = off), or
   *  — with a watcher live — the rare correctness backstop. */
  delta: z.object({
    cursor: z.string().nullable(),
    lastPollAt: IsoTimestampSchema,
    lastChangeAt: IsoTimestampSchema,
    intervalMs: z.number(),
    /** External-change watcher live: true = near-instant reconcile via the
     *  watcher + `intervalMs` backstop, false/absent = polling-only. Optional so a bare
     *  engine's static status can omit it. */
    watch: z.boolean().optional(),
  }),
  /** files → engine indexing. Counters optional so an engine that can't report
   *  progress degrades honestly: `indexing` falls back to a heuristic (delta
   *  upserts = busy). `indexed` = notes in the index; `total` = target
   *  population when knowable; `lastIndexedAt` = last (re)index.
   *  canon: docs/architecture.md#p5 */
  engine: z.object({
    indexing: IndexingStateSchema,
    indexed: z.number().optional(),
    total: z.number().optional(),
    lastIndexedAt: IsoTimestampSchema.optional(),
    /** Semantic (vector) index state for THIS space. Present only when
     *  the engine has a vector channel; a non-vector engine (in-memory fake)
     *  omits it. `mode` is the HONEST live channel: `vector` when the hybrid path
     *  serves this space, `fts` when it degraded (vec0/model unavailable) or the
     *  deployment ships FTS-only. `pending` = notes awaiting (re)embed
     *  (`content_hash != embedded_hash`); `total` = eligible population —
     *  done = total - pending, badge clears at pending 0. Counters are cheap in-memory
     *  (boot backfill seeds them, upsert/embed keep them live) — never a per-request
     *  table scan; progress rides this same `status` SSE frame.
     *  canon: docs/architecture.md#p5 */
    vector: z
      .object({
        mode: z.enum(enumValues(VECTOR_MODE)),
        pending: z.number(),
        total: z.number(),
      })
      .optional(),
  }),
  /** Snapshot size, null when the store serves live and never counted. */
  counts: z.object({ notes: z.number(), links: z.number() }).nullable(),
})

export const StatusResponseSchema = SyncStatusSchema

/** One SSE message's `data:` payload. `status` fires on lifecycle/poll
 *  transitions. `changed` fires when read-model content moved (mutation through
 *  us or an external change picked up by the delta poll) and carries the
 *  affected note ids plus `folders` (server-truth current folders, distinct): a client
 *  unions those with the old folders from its own cache, so a move by ANOTHER
 *  client/agent refreshes both the folder the note left and the one it landed in
 *  — else an observer knows only the stale location and the note vanishes from
 *  its tree until reload. `graph` fires when background graph enrichment
 *  (communities + layout) caught up with the snapshot: /api/graph serves fresh
 *  topology with stale enrichment in the meantime, so this signals the settled
 *  map is ready to refetch (SWR). */
export const StoreEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal(STORE_EVENT.STATUS), status: SyncStatusSchema }),
  z.object({
    type: z.literal(STORE_EVENT.CHANGED),
    upserts: z.array(z.string()),
    removed: z.array(z.string()),
    /** Defaulted so older producers/tests stay valid; the read-model fills it
     *  centrally (see the type header for the union rationale). */
    folders: z.array(z.string()).default([]),
  }),
  z.object({ type: z.literal(STORE_EVENT.GRAPH) }),
])
export type SyncStatus = z.infer<typeof SyncStatusSchema>

export type StoreEvent = z.infer<typeof StoreEventSchema>

import type { Graph } from '../../../knowledgeStore'
import type { BackgroundGate } from '../../../libs/backgroundScheduler'

export type GraphCacheOptions = {
  /** A freshly shaped topology from the CURRENT snapshot (nodes+links+ghosts),
   *  hidden classes already excluded. Cheap — no communities/layout. */
  shape: () => Graph
  /** Announce a freshly landed enrichment (the read-model's 'graph' event). */
  emitGraph: () => void
  /** Debounce before the background re-enrichment starts chasing a changed
   *  snapshot (SWR). */
  debounceMs: number
  /** May a background refresh be scheduled right now? False while the store is
   *  stopped, not yet 'ready', or a bulk import is in flight (endBulk
   *  kicks the single catch-up pass once the burst is over). */
  canSchedule: () => boolean
  /** Process-global cooperative gate shared with every other CPU-heavy background
   *  worker. Absent in bare/fake hosts: layout keeps its local macrotask yields. */
  scheduler?: BackgroundGate
}

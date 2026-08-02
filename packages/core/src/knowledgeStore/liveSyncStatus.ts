import { SCAN_PHASE } from './consts'
import type { SyncStatus } from './knowledgeStore'

/** The static "I serve live, nothing to wait for" status a bare (uncached)
 *  engine reports from syncStatus(). Shared so every engine answers
 *  identically; the cached decorator replaces it with a real lifecycle. */
export const liveSyncStatus = (): SyncStatus => ({
  scan: { phase: SCAN_PHASE.ready, startedAt: null, readyAt: null, error: null },
  delta: { cursor: null, lastPollAt: null, lastChangeAt: null, intervalMs: 0 },
  engine: { indexing: 'unknown' },
  counts: null,
})

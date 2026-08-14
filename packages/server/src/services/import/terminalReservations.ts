// Closing the destination claims of imports that have ENDED (#302).
//
// Why an observer and not the handler: the handler returns its result before the
// jobs layer records the outcome, so a crash in that window would leave a
// reservation nobody ever closes. The durable terminal row is the only proof that
// the run is over, and this runs on it — for success, terminal failure, cancel and
// reaper exhaustion alike, because all four end at the same row.
//
// It is idempotent by construction: it reads the claims that still exist, and a
// close that already happened simply finds none.
//
// It deliberately reaches for NOTHING but the meta-DB. A claim is a claim on a
// path, so closing it needs no store, no space and no file — and a cleanup that
// resolved a store first could not close the claims of an archived or purged
// space at all, which is a destination nothing ever frees again.
// canon: docs/import.md#importing-a-markdown-tree-302

import type { MetaDb } from '../metaDb'

export type TerminalReservationDeps = {
  metaDb: Pick<MetaDb, 'importReservations' | 'jobs'>
  log?: (message: string, err: unknown) => void
}

const TERMINAL = new Set(['succeeded', 'failed', 'canceled'])

/** One maintenance pass. Runs after the reaper and before retention prune: it needs
 *  the terminal row the prune would remove. */
export const closeTerminalImportReservations = async (
  deps: TerminalReservationDeps,
): Promise<void> => {
  const { importReservations, jobs } = deps.metaDb

  for (const jobId of await importReservations.activeJobIds()) {
    try {
      const job = await jobs.get(jobId)

      // A row that is gone counts as terminal: retention or a purge removed it, and
      // its claims must not outlive it. A row still pending/running is a live
      // import — leaving its claims alone is the whole point of holding them.
      if (job && !TERMINAL.has(job.status)) {
        continue
      }
      await importReservations.closeForJob({ jobId, now: new Date().toISOString() })
    } catch (err) {
      // One stuck job must not stop the others; the next tick retries this one.
      deps.log?.(`import reservation cleanup failed for ${jobId}`, err)
    }
  }
}

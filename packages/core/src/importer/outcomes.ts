import type { ImportNote, ImportRecordFailure, ImportRecordOutcome } from './types'

export const importedNote = (note: ImportNote): ImportRecordOutcome => ({ kind: 'note', note })

export const failedImportRecord = (title: string, error: string): ImportRecordOutcome => ({
  kind: 'failure',
  failure: { title, error },
})

export const skippedImportRecord = (reason: string): ImportRecordOutcome => ({
  kind: 'skip',
  reason,
})

export const partitionImportOutcomes = (
  outcomes: readonly ImportRecordOutcome[],
): { notes: ImportNote[]; failures: ImportRecordFailure[]; skipped: number } => {
  const notes: ImportNote[] = []
  const failures: ImportRecordFailure[] = []
  let skipped = 0

  for (const outcome of outcomes) {
    if (outcome.kind === 'note') {
      notes.push(outcome.note)
    } else if (outcome.kind === 'failure') {
      failures.push(outcome.failure)
    } else {
      skipped++
    }
  }

  return { notes, failures, skipped }
}

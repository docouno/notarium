import { HTTP_STATUS } from '@notarium/contract/http'
import type { NoteError } from '../../types'

/** Classify an open-note failure into the reader's state. The transport already
 *  speaks machine-readable codes (#51/#54): a 404 is a genuine miss, a 503 is a
 *  reachable-engine-not-ready (retryable), everything else is generic. */
export const classifyNoteError = (e: unknown): NoteError => {
  const status = (e as { status?: number }).status

  if (status === HTTP_STATUS.NOT_FOUND) {
    return { kind: 'notFound' }
  }
  if (status === HTTP_STATUS.SERVICE_UNAVAILABLE) {
    return { kind: 'unavailable' }
  }

  return { kind: 'generic', message: (e as Error).message }
}

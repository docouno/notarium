// Domain types for the edit_note semantic op.

import type { WriteResult } from '../../knowledgeStore'
import type { EditOperation } from './consts'
export type EditNoteInput = {
  /** The note-id to edit (the transport resolves a ref to this first). */
  noteId: string
  operation: EditOperation
  /** The text to add (append/prepend), the new section body (replaceSection),
   *  or the replacement (findReplace). */
  content: string
  /** Heading to replace under — required by replaceSection. */
  section?: string
  /** Exact, unique snippet to replace — required by findReplace. */
  find?: string
  /** The version the caller read. When present it is ENFORCED: a stale
   *  token conflicts rather than clobbering a concurrent edit. */
  versionToken?: string
  /** Journal attribution — the gateway stamps the agent's principal. */
  principal?: string
}

/** An edit's result: the saved identity plus the transparency echo the
 *  gateway surfaces — where the note lives and the integrity of the body this edit
 *  WROTE (its byte length + sha-256), so an agent confirms a big rewrite landed
 *  intact without a read-back (the same echo create_note/remember_* give). The
 *  echo fields are absent on a no-op edit (nothing was written). */
export type EditResult = WriteResult & {
  bodyBytes?: number
  bodyHash?: string
}

import type {
  SaveResponse,
  TrashItem,
  TrashPurgeResponse,
  TrashResponse,
  TrashRestoreManyResponse,
} from '@notarium/contract'
import { QUERY_KEY } from '@notarium/contract/query'
import { saveResultView } from '../../libs/wire'
import { req, sp } from './client'

export const trashApi = {
  // ── trash (#79) — a view over the journal, space-scoped ─────────────────────
  /** A window over the space's trash (newest-deleted first), optionally filtered
   *  by title `q` (server-side, so it scopes the window + total). Items are
   *  already camelCase domain shapes (#54). */
  trashGet: (
    space: string,
    params: { offset?: number; limit?: number; q?: string } = {},
  ): Promise<{ items: TrashItem[]; total: number; restorableTotal: number }> => {
    const qs = new URLSearchParams()

    if (params.offset != null) {
      qs.set(QUERY_KEY.offset, String(params.offset))
    }
    if (params.limit != null) {
      qs.set(QUERY_KEY.limit, String(params.limit))
    }
    if (params.q) {
      qs.set(QUERY_KEY.q, params.q)
    }
    const s = qs.toString()
    return req<TrashResponse>(`${sp(space)}/trash${s ? `?${s}` : ''}`)
  },
  /** Resurrect a trashed note (same note-id, last folder). 409s on a path clash
   *  (`note_already_exists`) — no silent clobber. */
  trashRestore: (space: string, id: string) =>
    req<SaveResponse>(`${sp(space)}/trash/restore`, {
      method: 'POST',
      body: JSON.stringify({ id }),
    }).then(saveResultView),
  /** Best-effort batch undelete of trashed notes (#184): one space-scoped round-
   *  trip for a multi-select, returning restored notes plus per-id failures. */
  trashRestoreMany: (
    space: string,
    body: { ids?: string[]; all?: boolean; q?: string; onlyRestorable?: boolean },
  ) =>
    req<TrashRestoreManyResponse>(`${sp(space)}/trash/restore-many`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  /** Permanently erase trashed notes (journal rows + blobs). `{ ids }` = an explicit
   *  set / one note; `{ all: true, q? }` = the filtered "Select all N" path.
   *  Irreversible. */
  trashPurge: (space: string, body: { ids?: string[]; all?: boolean; q?: string }) =>
    req<TrashPurgeResponse>(`${sp(space)}/trash/purge`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
}

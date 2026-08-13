import type {
  TrashAvailabilityFilter,
  TrashItem,
  TrashPurgeResponse,
  TrashResponse,
} from '@notarium/contract'
import { QUERY_KEY } from '@notarium/contract/query'
import { saveResultView } from '../../libs/wire'
import { req, sp } from './client'
import { strictBulkRestore, strictRestore } from './restore'

export const trashApi = {
  // ── trash (#79) — a view over the journal, space-scoped ─────────────────────
  /** A window over the space's trash (newest-deleted first), optionally filtered
   *  by title `q` (server-side, so it scopes the window + total). Items are
   *  already camelCase domain shapes (#54). */
  trashGet: (
    space: string,
    params: {
      offset?: number
      limit?: number
      q?: string
      availability?: TrashAvailabilityFilter
    } = {},
  ): Promise<{
    items: TrashItem[]
    total: number
    restorableTotal: number
    partialTotal: number
    restoreAvailable: boolean
  }> => {
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
    if (params.availability) {
      qs.set(QUERY_KEY.availability, params.availability)
    }
    const s = qs.toString()
    return req<TrashResponse>(`${sp(space)}/trash${s ? `?${s}` : ''}`)
  },
  /** Resurrect a trashed note (same note-id, last folder). A path clash returns
   *  `physical-target-changed` — no silent clobber. */
  trashRestore: (space: string, id: string, revisionId: string) =>
    strictRestore(`${sp(space)}/trash/restore`, `trash:${space}:${id}:${revisionId}`, {
      id,
      revisionId,
    }).then(saveResultView),
  /** Resume a durable ordered roster. Every child uses strict single-note
   * restore; a repeated click/network retry replays the same parent command. */
  trashRestoreMany: (
    space: string,
    body: { ids?: string[]; all?: boolean; q?: string; onlyRestorable?: boolean },
  ) => {
    const normalized = body.ids?.length
      ? { ids: [...new Set(body.ids)] }
      : {
          all: true,
          ...(body.q?.trim() ? { q: body.q.trim() } : {}),
          ...(body.onlyRestorable ? { onlyRestorable: true } : {}),
        }

    return strictBulkRestore(
      `${sp(space)}/trash/restore-many`,
      `trash-bulk:${space}:${JSON.stringify(normalized)}`,
      normalized,
    )
  },
  /** Permanently erase trashed notes (journal rows + blobs). `{ ids }` = an explicit
   *  set / one note; `{ all: true, q? }` = the filtered "Select all N" path.
   *  Irreversible. */
  trashPurge: (
    space: string,
    body: {
      ids?: string[]
      all?: boolean
      q?: string
      availability?: TrashAvailabilityFilter
    },
  ) =>
    req<TrashPurgeResponse>(`${sp(space)}/trash/purge`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
}

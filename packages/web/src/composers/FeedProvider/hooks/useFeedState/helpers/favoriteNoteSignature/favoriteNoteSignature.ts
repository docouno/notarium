import type { FavoriteItem } from '@notarium/contract'
import { FAVORITE_ENTITY_KIND } from '@notarium/contract/enums'

/** A stable signature of the favorited NOTE ids (sorted, comma-joined) — the
 *  favorite-facet token that joins the Feed query key (#42), so starring a note
 *  elsewhere re-queries the window at once instead of going stale. */
export const favoriteNoteSignature = (items: readonly FavoriteItem[]): string =>
  items
    .filter((it) => it.kind === FAVORITE_ENTITY_KIND.note)
    .map((it) => it.id)
    .sort()
    .join(',')

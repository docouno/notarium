import { BUCKET_GRAN } from '@notarium/contract/enums'
import type { FeedGroup } from './types'

/**
 * Grid card size, named by feel and keyed by the grid's column count: fewer
 * columns = bigger cards (large = 1 column, medium = 3 = default, small = 5).
 * The token IS the column count as a string and is persisted to localStorage,
 * so these values are a stable wire and must not change — only names may.
 */
export const FEED_COLS = { large: '1', medium: '3', small: '5' } as const

export const FEED_COLS_VALUES = Object.values(FEED_COLS)
export const FEED_GROUPS: FeedGroup[] = [BUCKET_GRAN.day, BUCKET_GRAN.week, BUCKET_GRAN.month]

/** Server window size: one /api/notes slice. */
export const PAGE_SIZE = 50
/** Pages held at once — bounds memory AND the refetch fan-out an SSE change
 *  triggers. Eviction is by distance from the freshest page (scroll locality);
 *  the virtualizer just refetches an evicted range when it scrolls back. */
export const MAX_PAGES = 16
/** Changed-event refetches are coalesced: a burst of deltas costs one sweep of
 *  the held pages (each snapshot-served, ~ms), not one per event. */

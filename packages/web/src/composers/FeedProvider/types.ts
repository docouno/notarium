import { type FEED_COLS } from './consts'

export type FeedSort = 'created' | 'modified'
export type FeedView = 'list' | 'grid'
export type FeedCols = (typeof FEED_COLS)[keyof typeof FEED_COLS]
/** Grouping granularity (default off). */
export type FeedGroup = 'off' | 'day' | 'week' | 'month'

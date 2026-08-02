import { FEED_COLS, type FeedCols } from '../FeedProvider'

// Size token (= grid column count) → snippet line clamp. Line-clamp never pads,
// so a short note simply shows fewer lines than the cap.
export const LINES: Record<FeedCols, number> = {
  [FEED_COLS.large]: 12,
  [FEED_COLS.medium]: 6,
  [FEED_COLS.small]: 2,
}

// Virtualizer's first-guess row heights per size token, refined by measurement
// as rows mount (estimates only steer the scrollbar before a row is measured).
export const ROW_ESTIMATE: Record<FeedCols, number> = {
  [FEED_COLS.large]: 280,
  [FEED_COLS.medium]: 170,
  [FEED_COLS.small]: 78,
}

// Grid view, virtualized in BLOCKS (#64, sized for 10k+): true per-tile
// virtualization fights the c3 dense packing (a tile's row-span flips when its
// image loads, and dense flow re-packs everything after it), so the grid is
// windowed at a coarser grain instead — items are chunked into fixed blocks,
// each block is its own .feed-grid (dense packs WITHIN the block only), and
// blocks virtualize like rows: estimated first, measured once mounted,
// unmounted when scrolled past. Trade-off (accepted): packing can't pull a
// tile across a block boundary, so c3 may show an occasional gap at a block's
// tail edge. Grouped grids use the same scheme with per-section blocks — see
// FeedVirtualGroupedGrid (FeedVirtualizers.tsx).
export const GRID_BLOCK: Record<FeedCols, number> = {
  [FEED_COLS.large]: 12,
  [FEED_COLS.medium]: 30,
  [FEED_COLS.small]: 40,
}
export const BLOCK_ESTIMATE: Record<FeedCols, number> = {
  [FEED_COLS.large]: 3900,
  [FEED_COLS.medium]: 2700,
  [FEED_COLS.small]: 1900,
}

export const SECTION_HEADER_ESTIMATE = 44

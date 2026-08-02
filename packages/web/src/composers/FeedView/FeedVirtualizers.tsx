import { useVirtualizer } from '@tanstack/react-virtual'
import { type CSSProperties, useEffect, useMemo, useRef } from 'react'
import { cx } from '../../libs/cx/cx'
import { labelOfBucket } from '../../libs/feed/feedDates'
import type { NoteView } from '../../libs/wire'
import { FEED_COLS, type FeedCols, type FeedState } from '../FeedProvider'
import { BLOCK_ESTIMATE, GRID_BLOCK, LINES, ROW_ESTIMATE, SECTION_HEADER_ESTIMATE } from './consts'
import { FeedCard, FeedGhostCard, FeedTimelineGhostRow, FeedTimelineRow } from './FeedItems'
import { useSectionStarts } from './hooks/useSectionStarts'
import type { GroupedBlock } from './types'
import styles from './FeedView.module.scss'

// The nearest scrollable ancestor — the virtualizer needs the actual element
// that owns the feed's scrollbar (the layout's content pane, not the window).
const getScrollParent = (el: HTMLElement | null): HTMLElement | null => {
  for (let p = el?.parentElement; p; p = p.parentElement) {
    const s = getComputedStyle(p)

    if (/(auto|scroll|overlay)/.test(s.overflowY)) {
      return p
    }
  }

  return (document.scrollingElement as HTMLElement | null) ?? document.documentElement
}

// Timeline (List view container) — truly virtualized (#64): the row count is
// the server's `total` (honest scrollbar over the whole base), only the rows
// near the viewport are mounted AND unmounted again, and scrolling into an
// unfetched window asks the data layer for exactly that range. Group headers
// come from the server's bucket histogram — every section start is known
// up-front, so a header renders even when the neighbouring rows haven't
// loaded (the old "withhold until both neighbours are known" dance is gone).
export const FeedVirtualTimeline = ({
  feed,
  dateOf,
  onOpen,
  lines,
  showDate,
  cols,
}: {
  feed: FeedState
  dateOf: (n: NoteView) => string | null
  onOpen: (id: string) => void
  lines: number
  showDate: boolean
  cols: FeedCols
}) => {
  const { total, itemAt, ensureRange } = feed
  const sectionStarts = useSectionStarts(feed)
  const count = total ?? 0
  const containerRef = useRef<HTMLDivElement>(null)
  const scrollElRef = useRef<HTMLElement | null>(null)

  const virtualizer = useVirtualizer({
    count,
    getScrollElement: () => {
      if (!scrollElRef.current) {
        scrollElRef.current = getScrollParent(containerRef.current)
      }

      return scrollElRef.current
    },
    estimateSize: () => ROW_ESTIMATE[cols],
    overscan: 6,
    // The measurement cache is keyed by GEOMETRY, not bare index (#68 item 6). A row's
    // measured height changes when the size token flips (every row) or a group
    // header appears/disappears over it (section starts only). Folding both into
    // the key means a regime change re-keys exactly the rows whose height moved:
    // they remount and re-measure, while untouched rows keep their valid cached
    // height. The old `virtualizer.measure()` on [cols, group] was the bug — it
    // wiped EVERY cached height, but ResizeObserver only re-fires for elements
    // whose rendered size actually changed, so unchanged rows were stranded on the
    // estimate (~95px gaps under each one). Don't reintroduce measure() here.
    getItemKey: (i) => `${cols}:${sectionStarts?.has(i) ? 'h' : ''}:${i}`,
  })
  const vItems = virtualizer.getVirtualItems()

  // Ask the data layer for whatever the viewport (+overscan) spans. Cheap and
  // idempotent — loaded pages and in-flight fetches are skipped inside.
  const first = vItems[0]?.index ?? 0
  const last = vItems.length ? vItems[vItems.length - 1].index + 1 : 0
  useEffect(() => {
    if (last > first) {
      ensureRange(first, last)
    }
  }, [first, last, ensureRange])

  return (
    <div
      ref={containerRef}
      className={cx(styles.feedTimeline, styles[`feed-timeline-c${cols}`], styles.feedTlVirtual)}
      style={{ height: virtualizer.getTotalSize(), '--lines': lines } as CSSProperties}
    >
      {vItems.map((v) => {
        const note = itemAt(v.index)
        const label = sectionStarts?.get(v.index) ?? null
        const withRule = v.index > 0 && label == null
        return (
          <div
            key={v.key}
            data-index={v.index}
            data-testid="feed-row"
            ref={virtualizer.measureElement}
            className={styles.feedTlVrow}
            style={{ transform: `translateY(${v.start}px)` }}
          >
            {label != null && (
              <div className={styles.feedTlGroup} data-testid="feed-group">
                <span className={styles.feedTlGroupLabel}>{label}</span>
              </div>
            )}
            {note ? (
              <FeedTimelineRow
                note={note}
                dateValue={dateOf(note)}
                onOpen={onOpen}
                lines={lines}
                showDate={showDate}
                withRule={withRule}
              />
            ) : (
              <FeedTimelineGhostRow lines={lines} withRule={withRule} />
            )}
          </div>
        )
      })}
    </div>
  )
}

export const FeedVirtualGrid = ({
  feed,
  dateOf,
  onOpen,
  cols,
  mobile,
}: {
  feed: FeedState
  dateOf: (n: NoteView) => string | null
  onOpen: (id: string) => void
  cols: FeedCols
  mobile: boolean
}) => {
  const { total, itemAt, ensureRange } = feed
  const blockSize = mobile ? GRID_BLOCK[FEED_COLS.large] : GRID_BLOCK[cols]
  const blockEstimate = mobile ? BLOCK_ESTIMATE[FEED_COLS.large] : BLOCK_ESTIMATE[cols]
  const lines = mobile ? LINES[FEED_COLS.medium] : LINES[cols]
  const cls = mobile
    ? cx(styles.feedGrid, styles.feedGridMobile)
    : cx(styles.feedGrid, styles[`feed-grid-c${cols}`])
  const count = total ?? 0
  const blocks = Math.ceil(count / blockSize)

  const containerRef = useRef<HTMLDivElement>(null)
  const scrollElRef = useRef<HTMLElement | null>(null)
  const virtualizer = useVirtualizer({
    count: blocks,
    getScrollElement: () => {
      if (!scrollElRef.current) {
        scrollElRef.current = getScrollParent(containerRef.current)
      }

      return scrollElRef.current
    },
    estimateSize: () => blockEstimate,
    overscan: 1,
    // Geometry-keyed measurement cache (#68 item 6, see FeedVirtualTimeline): the
    // size token / mobile flip changes both which notes a block holds (blockSize)
    // and the tile heights, so re-key by it — the affected blocks re-measure,
    // untouched ones keep their height. Replaces a `measure()` that wiped all.
    getItemKey: (i) => `${cols}:${mobile}:${i}`,
  })
  const vBlocks = virtualizer.getVirtualItems()

  const first = (vBlocks[0]?.index ?? 0) * blockSize
  const last = vBlocks.length ? (vBlocks[vBlocks.length - 1].index + 1) * blockSize : 0
  useEffect(() => {
    if (last > first) {
      ensureRange(first, Math.min(last, count))
    }
  }, [first, last, count, ensureRange])

  return (
    <div
      ref={containerRef}
      className={styles.feedGridVirtual}
      style={{ height: virtualizer.getTotalSize() }}
    >
      {vBlocks.map((v) => {
        const start = v.index * blockSize
        const end = Math.min(start + blockSize, count)
        const tiles = []

        for (let i = start; i < end; i++) {
          const note = itemAt(i)
          // Key carries the index too: a block can straddle a page boundary,
          // and while a snapshot shift is being refetched (the ~1s coalesced
          // sweep) the same note may transiently appear on both sides of it —
          // a bare-permalink key would collide inside one block.
          tiles.push(
            note ? (
              <FeedCard
                key={`${note.id}-${i}`}
                note={note}
                dateValue={dateOf(note)}
                onOpen={onOpen}
                lines={lines}
              />
            ) : (
              <FeedGhostCard key={`ghost-${i}`} lines={lines} />
            ),
          )
        }

        return (
          <div
            key={v.key}
            data-index={v.index}
            ref={virtualizer.measureElement}
            className={styles.feedGridBlock}
            style={{ transform: `translateY(${v.start}px)` }}
          >
            <div className={cls} style={{ '--lines': lines } as CSSProperties}>
              {tiles}
            </div>
          </div>
        )
      })}
    </div>
  )
}

// Grouped grid (#64): the same block virtualization as FeedVirtualGrid, but
// the blocks are laid out per SECTION from the server's bucket histogram —
// every section's start and size is known before any item loads, so sparse
// windows can land anywhere without shifting a header, and the DOM stays
// windowed however far the scroll goes (the old grow-window is gone). A
// section is one or more blocks; dense packing runs within a block, and a
// section's last block simply holds the remainder.
export const FeedVirtualGroupedGrid = ({
  feed,
  dateOf,
  onOpen,
  cols,
  mobile,
}: {
  feed: FeedState
  dateOf: (n: NoteView) => string | null
  onOpen: (id: string) => void
  cols: FeedCols
  mobile: boolean
}) => {
  const { itemAt, ensureRange, buckets, bucketsGroup } = feed
  const blockSize = mobile ? GRID_BLOCK[FEED_COLS.large] : GRID_BLOCK[cols]
  const blockEstimate = mobile ? BLOCK_ESTIMATE[FEED_COLS.large] : BLOCK_ESTIMATE[cols]
  const lines = mobile ? LINES[FEED_COLS.medium] : LINES[cols]
  const cls = mobile
    ? cx(styles.feedGrid, styles.feedGridMobile)
    : cx(styles.feedGrid, styles[`feed-grid-c${cols}`])

  const blocks = useMemo<GroupedBlock[]>(() => {
    if (!buckets || bucketsGroup === 'off') {
      return []
    }
    const out: GroupedBlock[] = []
    let acc = 0

    for (const b of buckets) {
      const label = labelOfBucket(b.key, bucketsGroup)

      for (let s = 0; s < b.count; s += blockSize) {
        out.push({
          start: acc + s,
          end: acc + Math.min(s + blockSize, b.count),
          label: s === 0 ? label : null,
        })
      }
      acc += b.count
    }

    return out
  }, [buckets, bucketsGroup, blockSize])

  const containerRef = useRef<HTMLDivElement>(null)
  const scrollElRef = useRef<HTMLElement | null>(null)
  const virtualizer = useVirtualizer({
    count: blocks.length,
    getScrollElement: () => {
      if (!scrollElRef.current) {
        scrollElRef.current = getScrollParent(containerRef.current)
      }

      return scrollElRef.current
    },
    // Partial blocks (a section's tail) estimate proportionally — refined by
    // measurement the moment the block mounts.
    estimateSize: (i) => {
      const b = blocks[i]
      const frac = b ? (b.end - b.start) / blockSize : 1
      return (
        Math.max(120, Math.round(blockEstimate * frac)) + (b?.label ? SECTION_HEADER_ESTIMATE : 0)
      )
    },
    overscan: 1,
    // Geometry-keyed measurement cache (#68 item 6, see FeedVirtualTimeline): a block's
    // height is set by its item span (start..end), whether it carries a section
    // header (label), and the tile size (cols/mobile). A grouping change or an SSE
    // histogram shift rebuilds `blocks`, so re-keying by these re-measures exactly
    // the blocks that moved while the rest keep their cached height — instead of a
    // `measure()` that blanked every block and stranded the unchanged ones on the
    // estimate (the gaps from #68 item 6).
    getItemKey: (i) => {
      const b = blocks[i]
      return `${cols}:${mobile}:${b?.start}:${b?.end}:${b?.label != null ? 'h' : ''}`
    },
  })
  const vBlocks = virtualizer.getVirtualItems()

  const first = vBlocks.length ? (blocks[vBlocks[0].index]?.start ?? 0) : 0
  const last = vBlocks.length ? (blocks[vBlocks[vBlocks.length - 1].index]?.end ?? 0) : 0
  useEffect(() => {
    if (last > first) {
      ensureRange(first, last)
    }
  }, [first, last, ensureRange])

  return (
    <div
      ref={containerRef}
      className={styles.feedGridVirtual}
      style={{ height: virtualizer.getTotalSize() }}
    >
      {vBlocks.map((v) => {
        const b = blocks[v.index]

        if (!b) {
          return null
        }
        const tiles = []

        for (let i = b.start; i < b.end; i++) {
          const note = itemAt(i)
          // Indexed key — same straddle rationale as FeedVirtualGrid above.
          tiles.push(
            note ? (
              <FeedCard
                key={`${note.id}-${i}`}
                note={note}
                dateValue={dateOf(note)}
                onOpen={onOpen}
                lines={lines}
              />
            ) : (
              <FeedGhostCard key={`ghost-${i}`} lines={lines} />
            ),
          )
        }

        return (
          <div
            key={v.key}
            data-index={v.index}
            ref={virtualizer.measureElement}
            className={styles.feedGridBlock}
            style={{ transform: `translateY(${v.start}px)` }}
          >
            {b.label != null && (
              <h2 className={styles.feedSectionTitle} data-testid="feed-group">
                {b.label}
              </h2>
            )}
            <div className={cls} style={{ '--lines': lines } as CSSProperties}>
              {tiles}
            </div>
          </div>
        )
      })}
    </div>
  )
}

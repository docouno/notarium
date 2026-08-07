import { DisclosureCardSkeleton } from '../../core/DisclosureCard'
import { Skeleton } from '../../core/Skeleton'
import { cx } from '../../libs/cx/cx'
import { AGGREGATE_ROWS, STAT_WIDTHS } from './consts'
import styles from './SessionsPage.module.scss'

// ── loading skeletons ────────────────────────────────────────────────────────
// Structural, NOT decorative: each placeholder mirrors the real element's box (a row
// card's height + its badge/query/meta columns; a panel's head + stat lines), so the
// layout is identical before and after data arrives — a first load or a filter flip
// never reflows the page. Widths are fixed per index (deterministic, no random jitter).

// One history-row placeholder — the shared DisclosureCardSkeleton reserves the real card's
// exact 40px box; inside, the real caret / 18px badge / flexible query / meta columns, so a
// real row drops in with zero shift.
export const SkeletonRow = () => (
  <DisclosureCardSkeleton>
    <Skeleton w={13} h={13} radius="var(--radius-sm)" />
    <Skeleton w={58} h={18} radius="999px" />
    <span className={styles.skeletonQuery}>
      <Skeleton w="42%" h={13} radius="var(--radius-sm)" />
    </span>
    <span className={styles.skeletonMeta}>
      <Skeleton w={46} h={12} />
      <Skeleton w={54} h={12} />
      <Skeleton w={62} h={12} />
    </span>
  </DisclosureCardSkeleton>
)

// The history list while a page loads — a screenful of row placeholders in the SAME
// `.list` container (identical gap), so real rows drop in without a jump.
export const ListSkeleton = ({ rows = 8 }: { rows?: number }) => (
  <ul className={styles.list} data-testid="audit-skeleton" aria-hidden>
    {Array.from({ length: rows }, (_, i) => (
      <li key={i}>
        <SkeletonRow />
      </li>
    ))}
  </ul>
)

// One aggregate-panel stat line placeholder — badge + query + count, like QueryStatRow.
// The 18px badge in a 5px-padded row is the real 28px stat-row, to the pixel.
export const StatRowSkeleton = ({ queryWidth }: { queryWidth: string }) => (
  <li className={styles.statRow} aria-hidden>
    <Skeleton w={54} h={18} radius="999px" />
    <span className={styles.statQuery}>
      <Skeleton w={queryWidth} h={12} radius="var(--radius-sm)" />
    </span>
    <Skeleton w={28} h={12} />
  </li>
)

// The two aggregate panels on the FIRST load (before we know if there are aggregates).
// Mirrors the real grid to the pixel: the FREQUENT panel (right) is the tallest and, being
// server-capped at AGGREGATE_ROWS, is a known fixed height — reserving it exactly means the
// controls + list below never shift. The panel head reserves the real 13px-label line box.
export const PanelsSkeleton = () => {
  const panel = (rows: number) => (
    <section className={styles.panel}>
      <div className={cx(styles.panelHead, styles.skeletonPanelHead)}>
        <Skeleton w={13} h={13} radius="var(--radius-sm)" />
        <Skeleton w={70} h={11} />
      </div>
      <ul className={styles.statList}>
        {Array.from({ length: rows }, (_, i) => (
          <StatRowSkeleton key={i} queryWidth={STAT_WIDTHS[i % STAT_WIDTHS.length]} />
        ))}
      </ul>
    </section>
  )
  return (
    <div className={styles.panels} aria-hidden>
      {panel(2)}
      {panel(AGGREGATE_ROWS)}
    </div>
  )
}

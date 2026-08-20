import { ActivityTimeline, ActivityTimelineRow } from '../../core/ActivityTimeline'
import { AsideSection, AsideSections } from '../../core/AsidePanel'
import { Skeleton } from '../../core/Skeleton'
import { AGGREGATE_ROWS, STAT_WIDTHS } from './consts'
import asideStyles from './ActivityAside.module.scss'
import styles from './ActivityPage.module.scss'
import rowStyles from './ActivityRows.module.scss'

// ── loading skeletons ────────────────────────────────────────────────────────
// Structural, NOT decorative: each placeholder mirrors the real element's box (a timeline
// row's height + its badge/query/meta columns; a panel's head + stat lines), so the
// layout is identical before and after data arrives — a first load or a filter flip
// never reflows the page. Widths are fixed per index (deterministic, no random jitter).

const ActivitySkeletonRow = () => (
  <ActivityTimelineRow
    as="li"
    icon={<Skeleton w={12} h={12} radius="var(--radius-sm)" />}
    primary={
      <span className={rowStyles.skeletonQuery}>
        <Skeleton w="42%" h={13} radius="var(--radius-sm)" />
      </span>
    }
    time={<Skeleton w={46} h={12} />}
    action={<Skeleton w={54} h={13} />}
    attributes={<Skeleton w={62} h={13} />}
    reserveDisclosure
  />
)

export const ActivityListSkeleton = ({
  rows = 8,
  spine = true,
}: {
  rows?: number
  spine?: boolean
}) => (
  <ActivityTimeline as="ul" testId="audit-skeleton" ariaHidden spine={spine}>
    {Array.from({ length: rows }, (_, i) => (
      <ActivitySkeletonRow key={i} />
    ))}
  </ActivityTimeline>
)

export const SessionListSkeleton = ({ rows = 8 }: { rows?: number }) => (
  <div className={styles.sessionTimeline} data-testid="session-list-skeleton" aria-hidden>
    {Array.from({ length: rows }, (_, i) => (
      <ActivityTimeline
        as="ul"
        key={i}
        className={styles.sessionTimelineSegment}
        testId="session-skeleton-segment"
        ariaHidden
        spine={false}
      >
        <ActivityTimelineRow
          as="li"
          icon={<Skeleton w={12} h={12} radius="var(--radius-sm)" />}
          primary={<Skeleton w={`${38 + ((i * 11) % 24)}%`} h={16} />}
          time={<Skeleton w={48} h={11} />}
          outcome={<Skeleton w={`${48 + ((i * 7) % 20)}%`} h={13} />}
          reserveDisclosure
          trailing={<span className={styles.sessionSkeletonAction} aria-hidden />}
        />
      </ActivityTimeline>
    ))}
  </div>
)

// One aggregate-panel stat line placeholder — badge + query + count, like QueryStatRow.
// The 18px badge in a 6px-padded row is the real 30px stat-row, to the pixel.
export const StatRowSkeleton = ({ queryWidth }: { queryWidth: string }) => (
  <li className={asideStyles.statRow} aria-hidden>
    <Skeleton w={54} h={18} radius="999px" />
    <span className={asideStyles.statQuery}>
      <Skeleton w={queryWidth} h={12} radius="var(--radius-sm)" />
    </span>
    <Skeleton w={28} h={12} />
  </li>
)

// The two diagnostics sections while the Activity aside loads aggregates. They share the
// same section headers and row geometry as the loaded Graph/Feed-style aside contents.
export const PanelsSkeleton = () => {
  const panel = (key: string, rows: number) => (
    <AsideSection key={key} heading={<Skeleton w={70} h={11} />}>
      <Skeleton w="72%" h={11} />
      <ul className={asideStyles.statList}>
        {Array.from({ length: rows }, (_, i) => (
          <StatRowSkeleton key={i} queryWidth={STAT_WIDTHS[i % STAT_WIDTHS.length]} />
        ))}
      </ul>
    </AsideSection>
  )
  return <AsideSections>{[panel('misses', 2), panel('top', AGGREGATE_ROWS)]}</AsideSections>
}

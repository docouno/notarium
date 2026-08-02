import { DisclosureCardSkeleton } from '../../core/DisclosureCard'
import { Skeleton } from '../../core/Skeleton'
import styles from './ContextPage.module.scss'

// ── loading skeletons ────────────────────────────────────────────────────────
// Same principle as the Audit log (#243): every placeholder reserves its real element's
// box, so loading → content never reflows. The card rows reuse the shared
// DisclosureCardSkeleton (the exact 40px card); counts are NOT matched to the real data
// (pins/memory are variable) — a few rows just hold the list's shape while it loads.

// One pinned/memory card placeholder — the real 40px ContextCard box, inner: a title line,
// the weight meter (track + value), and the disclosure caret.
export const ContextCardSkeleton = () => (
  <DisclosureCardSkeleton>
    <span className={styles.skeletonTitle}>
      <Skeleton w="52%" h={13} radius="var(--radius-sm)" />
    </span>
    <Skeleton w={40} h={6} radius="999px" />
    <Skeleton w={28} h={12} radius="var(--radius-sm)" />
    <Skeleton w={13} h={13} radius="var(--radius-sm)" />
  </DisclosureCardSkeleton>
)

// A block's card list while it loads — a few rows in the real `.list` (same 7px gaps).
export const CardListSkeleton = ({ rows = 4 }: { rows?: number }) => (
  <div className={styles.list} aria-hidden>
    {Array.from({ length: rows }, (_, i) => (
      <ContextCardSkeleton key={i} />
    ))}
  </div>
)

// The aggregate context-load bar placeholder — reserves its exact 110px box (head 16 +
// bar 20 + tabs 27, with the real gaps/padding), so the blocks below don't jump when the
// real meter appears. Tab COUNT is scope-dependent but the tabs row height is fixed, so a
// single tab-width bar reserves it regardless.
export const AggregateBarSkeleton = () => (
  <div className={styles.aggregate} aria-hidden data-testid="context-aggregate-skeleton">
    <Skeleton w="46%" h={16} radius="var(--radius-sm)" />
    <Skeleton w="100%" h={20} radius="999px" />
    <Skeleton w={132} h={27} radius="var(--radius-sm)" />
  </div>
)

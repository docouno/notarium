import { type ReactNode } from 'react'
import { Notice } from '../../core/Notice'
import { Skeleton } from '../../core/Skeleton'
import styles from './TreeState.module.scss'

// TreeState — the ONE lifecycle skin every explorer tree wears (#220). A tree can
// be in exactly one of four states: still loading, failed to load, loaded-empty, or
// loaded-with-rows. Before this, each tree (the file tree, the memory tree, the
// filter facet) hand-rolled its own skeleton/empty/error, so "couldn't load" looked
// and behaved differently in each — the strict "a tree is uniform everywhere"
// invariant was broken. This wrapper owns the RENDERING of the three non-ready
// states with the shared primitives, so they can't drift again:
//
//   loading → <Skeleton> rows shaped like a tree (canon #65: skeleton in the shape
//             of the target, no empty-flash on boot).
//   error   → <Notice variant="error"> in a compact container — the panel's inline
//             banner (docs/web-ui.md: a panel-flow error is a Notice, not the
//             full-area StateView reserved for whole pages / the reader).
//   empty   → the host's <EmptyState> (it owns the per-scope icon/title/hint), boxed
//             in the shared padded container so spacing is identical everywhere.
//   ready   → the tree itself (children).
//
// It is PURELY presentational: the host computes `status` from its own signals so it
// keeps its concern-scoped nuance (e.g. "show the error only on a COLD load, let a
// failed background refresh keep the tree it already has"). This wrapper only
// guarantees that, once a state is chosen, it is drawn the one shared way.

export type TreeStatus = 'loading' | 'error' | 'empty' | 'ready'

// Shimmer rows shaped like a tree/list. Widths vary deterministically so the group
// reads as a list, not a solid block. Decorative → aria-hidden (the row count is
// cosmetic; a screen reader announces the real rows once they arrive).
export const TreeSkeleton = ({ rows = 7, testId }: { rows?: number; testId?: string }) => (
  <div className={styles.skeleton} aria-hidden="true" data-testid={testId}>
    {Array.from({ length: rows }, (_, i) => (
      <div key={i} className={styles.skeletonRow}>
        <Skeleton w={`${48 + ((i * 17) % 40)}%`} h={13} radius={4} />
      </div>
    ))}
  </div>
)

export const TreeState = ({
  status,
  skeletonRows = 7,
  skeletonTestId,
  error,
  errorTestId,
  empty,
  children,
}: {
  status: TreeStatus
  /** How many shimmer rows to show while loading. */
  skeletonRows?: number
  skeletonTestId?: string
  /** The error message (a cold-load failure) — rendered inside a compact Notice. */
  error?: ReactNode
  errorTestId?: string
  /** The loaded-empty placeholder — a ready-made <EmptyState> from the host. */
  empty?: ReactNode
  /** The tree, shown once loaded with rows. */
  children: ReactNode
}) => {
  if (status === 'loading') {
    return <TreeSkeleton rows={skeletonRows} testId={skeletonTestId} />
  }
  if (status === 'error') {
    return (
      <div className={styles.error}>
        <Notice variant="error" data-testid={errorTestId}>
          {error}
        </Notice>
      </div>
    )
  }
  if (status === 'empty') {
    return <div className={styles.empty}>{empty}</div>
  }

  return <>{children}</>
}

import { type CSSProperties } from 'react'
import { cx } from '../../libs/cx/cx'
import styles from './Skeleton.module.scss'

// ─────────────────────────────────────────────────────────────────────────────
// Reusable shimmer placeholders. Generic by design — the Feed cards are the first
// consumer, but anything that loads async (note list, aside facets, …) can reuse
// these instead of hand-rolling a one-off loader.
//
//   <Skeleton w="60%" h={12} />     a single block (width/height/radius tunable)
//   <SkeletonText lines={6} />      stacked lines, last one shortened to a tail
//
// The visual (shimmer gradient, reduced-motion guard) lives in Skeleton.module.scss;
// these components only emit the markup. All are decorative, so they
// are aria-hidden — a screen reader announces the real content once it arrives.
// ─────────────────────────────────────────────────────────────────────────────

type SkeletonProps = {
  w?: number | string
  h?: number | string
  radius?: number | string
  className?: string
  style?: CSSProperties
}

// One shimmer block. `w`/`h` accept any CSS length (number → px via React).
export const Skeleton = ({ w, h, radius, className = '', style }: SkeletonProps) => (
  <span
    className={cx(styles.skeleton, className)}
    style={{ width: w, height: h, borderRadius: radius, ...style }}
    aria-hidden="true"
  />
)

type SkeletonTextProps = {
  lines?: number
  className?: string
  lastWidth?: string
}

// `lines` shimmer rows for a text block. The last row is shortened so the group
// reads as a paragraph tail rather than a solid rectangle (skipped when 1 line).
export const SkeletonText = ({
  lines = 3,
  className = '',
  lastWidth = '68%',
}: SkeletonTextProps) => (
  <span className={cx(styles.skeletonText, className)} aria-hidden="true">
    {Array.from({ length: lines }, (_, i) => (
      <span
        key={i}
        className={cx(styles.skeleton, styles.skeletonLine)}
        style={i === lines - 1 && lines > 1 ? { width: lastWidth } : undefined}
      />
    ))}
  </span>
)
